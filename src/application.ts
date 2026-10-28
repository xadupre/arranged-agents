import { randomUUID } from "node:crypto";
import type { Conversation } from "./conversation";
import { buildPrompt, MAX_PROMPT_LENGTH } from "./prompt";
import { discoverRepositories, type Repository } from "./repositories";
import { isExternalUrl } from "./links";
import { describeTool } from "./presentation";
import type {
  SavedApplication,
  SavedConversation,
  SavedRepositorySession,
} from "./storage";
import type { UserInputRequest, UserInputResponse } from "./copilot";
import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};

export type SessionStatus =
  "idle" | "saved" | "starting" | "ready" | "busy" | "error" | "stopping";
export type InformationType =
  "messages" | "reasoning" | "tools" | "output" | "system";
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "reasoning" | "tool" | "output";
  content: string;
  title?: string;
  timestamp?: string;
  agentId?: string;
  details?: string;
  error?: boolean;
}
export interface ApplicationState {
  root: string;
  repositories: (Repository & {
    status: SessionStatus;
    hasSavedSession?: boolean;
    sessionCount?: number;
    generation?: number;
  })[];
  activeId?: string;
  messages: ChatMessage[];
  error?: string;
  draft: string;
  permissions: PendingPermission[];
  questions: PendingQuestion[];
}
export interface PendingPermission {
  id: string;
  repositoryId: string;
  kind: string;
  summary: string;
  content: string;
  details: string;
}
export interface PendingQuestion extends UserInputRequest {
  id: string;
  repositoryId: string;
}
interface RepositorySession {
  repository: Repository;
  status: SessionStatus;
  messages: ChatMessage[];
  conversation?: Conversation;
  controller?: AbortController;
  starting?: Promise<void>;
  error?: string;
  sessionId?: string;
  draft: string;
  sending?: Promise<void>;
  managing?: Promise<void>;
  history: SavedConversation[];
  generation: number;
  removed?: boolean;
  eventMessages: Map<string, ChatMessage>;
}

export type ApplicationMessage =
  | { type: "ready" | "refresh" }
  | { type: "select" | "cancel" | "restart"; id: string }
  | {
      type:
        | "close-session"
        | "new-session"
        | "delete-last-session"
        | "delete-all-sessions";
      id: string;
    }
  | { type: "draft"; id: string; text: string }
  | { type: "permission"; id: string; approve: boolean }
  | { type: "answer"; id: string; answer: string }
  | { type: "openExternal"; url: string }
  | { type: "send"; id: string; question: string };

export function parseApplicationMessage(value: unknown): ApplicationMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid application message.");
  }
  if (value.type === "ready" || value.type === "refresh") {
    return { type: value.type };
  }
  if (value.type === "openExternal") {
    if (
      !("url" in value) ||
      typeof value.url !== "string" ||
      !isExternalUrl(value.url)
    ) {
      throw new Error("Only HTTP and HTTPS links can be opened.");
    }
    return { type: "openExternal", url: value.url };
  }
  if (!("id" in value) || typeof value.id !== "string") {
    throw new Error("The application message must identify a repository.");
  }
  if (
    value.type === "answer" &&
    "answer" in value &&
    typeof value.answer === "string" &&
    value.answer.trim() &&
    value.answer.length <= MAX_PROMPT_LENGTH
  ) {
    return { type: "answer", id: value.id, answer: value.answer };
  }
  if (
    value.type === "permission" &&
    "approve" in value &&
    typeof value.approve === "boolean"
  ) {
    return { type: "permission", id: value.id, approve: value.approve };
  }
  if (
    value.type === "select" ||
    value.type === "cancel" ||
    value.type === "restart" ||
    value.type === "close-session" ||
    value.type === "new-session" ||
    value.type === "delete-last-session" ||
    value.type === "delete-all-sessions"
  ) {
    return { type: value.type, id: value.id };
  }
  if (
    value.type === "draft" &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text.length <= MAX_PROMPT_LENGTH
  ) {
    return { type: "draft", id: value.id, text: value.text };
  }
  if (
    value.type === "send" &&
    "question" in value &&
    typeof value.question === "string"
  ) {
    return { type: "send", id: value.id, question: value.question };
  }
  throw new Error("Unknown application message.");
}

export class AgentApplication {
  private readonly sessions = new Map<string, RepositorySession>();
  private activeId?: string;
  private closed = false;
  private stopping?: Promise<void>;
  private readonly saved = new Map<string, SavedRepositorySession>();
  private readonly permissions = new Map<
    string,
    { request: PendingPermission; resolve: (approve: boolean) => void }
  >();
  private readonly questions = new Map<
    string,
    {
      request: PendingQuestion;
      resolve: (response: UserInputResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    readonly root: string,
    private readonly createConversation: (
      repository: Repository,
    ) => Conversation,
    private readonly onChange: () => void,
    saved?: SavedApplication,
  ) {
    if (saved && saved.root !== root) {
      throw new Error(
        "Saved history belongs to a different repository parent.",
      );
    }
    this.activeId = saved?.activeId;
    for (const session of saved?.sessions ?? []) {
      this.saved.set(session.id, session);
    }
  }

  async refresh(): Promise<void> {
    this.assertOpen();
    const repositories = await discoverRepositories(this.root);
    this.assertOpen();
    const ids = new Set(repositories.map((repository) => repository.id));
    for (const [id, session] of this.sessions) {
      if (!ids.has(id)) {
        session.removed = true;
        session.controller?.abort();
        this.clearPendingRequests(id);
        await session.conversation?.dispose();
        if (session.managing) {
          await Promise.allSettled([session.managing]);
        }
        await this.stopSession(session);
        this.saved.set(id, this.saveSession(session));
        this.sessions.delete(id);
        if (this.activeId === id) {
          this.activeId = undefined;
        }
      }
    }
    for (const repository of repositories) {
      if (!this.sessions.has(repository.id)) {
        const saved = this.saved.get(repository.id);
        this.sessions.set(repository.id, {
          repository,
          status: saved?.sessionId ? "saved" : "idle",
          sessionId: saved?.sessionId,
          draft: saved?.draft ?? "",
          messages: saved?.messages.map((message) => ({ ...message })) ?? [],
          history:
            saved?.history?.map((entry) => this.copyConversation(entry)) ?? [],
          generation: 0,
          eventMessages: new Map(),
        });
      }
    }
    if (this.activeId && !this.sessions.has(this.activeId)) {
      this.activeId = undefined;
    }
    this.onChange();
  }

  getState(): ApplicationState {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return {
      root: this.root,
      repositories: [...this.sessions.values()]
        .map((session) => ({
          ...session.repository,
          status: session.managing ? ("stopping" as const) : session.status,
          hasSavedSession: Boolean(session.sessionId),
          sessionCount:
            session.history.length + (this.hasConversation(session) ? 1 : 0),
          generation: session.generation,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      activeId: this.activeId,
      messages: active?.messages.map((message) => ({ ...message })) ?? [],
      error: active?.error,
      draft: active?.draft ?? "",
      permissions: [...this.permissions.values()].map(({ request }) => ({
        ...request,
      })),
      questions: [...this.questions.values()].map(({ request }) => ({
        ...request,
        choices: request.choices ? [...request.choices] : undefined,
      })),
    };
  }

  requestPermission(
    repositoryId: string,
    permission: Omit<PendingPermission, "id" | "repositoryId">,
  ): Promise<boolean> {
    const session = this.getSession(repositoryId);
    if (
      this.closed ||
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      return Promise.resolve(false);
    }
    const request = { ...permission, id: randomUUID(), repositoryId };
    return new Promise((resolve) => {
      this.permissions.set(request.id, { request, resolve });
      this.onChange();
    });
  }

  respondToPermission(id: string, approve: boolean): void {
    this.assertOpen();
    const pending = this.permissions.get(id);
    if (!pending) {
      throw new Error("This permission request is no longer pending.");
    }
    this.permissions.delete(id);
    pending.resolve(approve);
    this.onChange();
  }

  askQuestion(
    repositoryId: string,
    question: UserInputRequest,
  ): Promise<UserInputResponse> {
    this.assertOpen();
    const session = this.getSession(repositoryId);
    if (
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    const request: PendingQuestion = {
      ...question,
      choices: question.choices ? [...question.choices] : undefined,
      id: randomUUID(),
      repositoryId,
    };
    session.messages.push({ role: "assistant", content: question.question });
    return new Promise((resolve, reject) => {
      this.questions.set(request.id, { request, resolve, reject });
      this.onChange();
    });
  }

  answerQuestion(id: string, answer: string): void {
    this.assertOpen();
    const pending = this.questions.get(id);
    if (!pending) {
      throw new Error("This question is no longer pending.");
    }
    if (!answer.trim() || answer.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `The answer must contain between 1 and ${MAX_PROMPT_LENGTH} characters.`,
      );
    }
    const wasFreeform = !pending.request.choices?.includes(answer);
    if (wasFreeform && pending.request.allowFreeform === false) {
      throw new Error("Choose one of the proposed answers.");
    }
    this.questions.delete(id);
    this.getSession(pending.request.repositoryId).messages.push({
      role: "user",
      content: answer,
    });
    pending.resolve({ answer, wasFreeform });
    this.onChange();
  }

  getSnapshot(): SavedApplication {
    const sessions = new Map(this.saved);
    for (const [id, session] of this.sessions) {
      sessions.set(id, this.saveSession(session));
    }
    return {
      version: 1,
      root: this.root,
      activeId: this.activeId,
      sessions: [...sessions.values()],
    };
  }

  setDraft(id: string, text: string): void {
    this.assertOpen();
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `The draft must not exceed ${MAX_PROMPT_LENGTH} characters.`,
      );
    }
    const session = this.getSession(id);
    this.assertAvailable(session);
    session.draft = text;
    this.onChange();
  }

  async restart(id: string): Promise<void> {
    this.assertOpen();
    const current = this.getSession(id);
    this.assertAvailable(current);
    if (current.status === "starting" || current.status === "busy") {
      throw new Error(
        "Cancel the running operation before starting a new session.",
      );
    }
    return this.manageSession(id, async (session) => {
      await this.stopSession(session);
      if (this.hasConversation(session)) {
        session.history.push(this.copyConversation(session));
      }
      const messages = session.messages;
      this.restoreConversation(session);
      session.messages = messages;
      session.messages.push({
        role: "system",
        content:
          "Starting a new Copilot session. Earlier messages are kept for reference, not replayed as context.",
      });
      this.activeId = id;
      await this.startSession(session);
    });
  }

  async select(id: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    this.activeId = id;
    this.onChange();
    await this.startSession(session);
  }

  private async startSession(session: RepositorySession): Promise<void> {
    const id = session.repository.id;
    this.assertOpen();
    if (session.removed) {
      throw new Error("The repository is no longer available.");
    }
    if (session.status === "starting") {
      return session.starting;
    }
    if (session.status === "ready" || session.status === "busy") {
      return;
    }
    const previous = session.conversation;
    if (
      previous?.sessionId &&
      !session.sessionId &&
      !session.history.some((entry) => entry.sessionId === previous.sessionId)
    ) {
      session.history.push({
        ...this.copyConversation(session),
        sessionId: previous.sessionId,
      });
    }
    if ((previous || session.messages.length > 0) && !session.sessionId) {
      session.messages.push({
        role: "system",
        content:
          "The previous session ended. Starting a new Copilot session; earlier messages are shown for reference only.",
      });
    }
    const controller = new AbortController();
    session.controller = controller;
    session.status = "starting";
    session.error = undefined;
    this.onChange();
    const start = async (): Promise<void> => {
      try {
        await previous?.dispose();
        this.assertOpen();
        if (session.removed) {
          throw new Error("The repository is no longer available.");
        }
        const conversation = this.createConversation(session.repository);
        session.conversation = conversation;
        session.eventMessages.clear();
        await conversation.start(
          controller.signal,
          (event) => {
            if (
              !this.closed &&
              session.conversation === conversation &&
              this.sessions.get(id) === session
            ) {
              this.recordEvent(session, event);
            }
          },
          session.sessionId,
        );
        session.sessionId = conversation.sessionId;
        session.status = "ready";
      } catch (error) {
        this.fail(
          session,
          session.sessionId && !this.closed
            ? new Error(
                `Could not resume the saved Copilot session: ${error instanceof Error ? error.message : String(error)}. Retry, or choose New session to keep the displayed history but start fresh.`,
                { cause: error },
              )
            : error,
        );
        throw error;
      } finally {
        session.starting = undefined;
        this.clearPendingRequests(id);
        this.onChange();
      }
    };
    session.starting = start();
    return session.starting;
  }

  async send(id: string, question: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    if (
      id !== this.activeId ||
      session.status !== "ready" ||
      !session.conversation
    ) {
      throw new Error(
        "Select a ready repository session before sending a message.",
      );
    }
    const prompt = buildPrompt(question);
    session.messages.push({ role: "user", content: question.trim() });
    session.draft = "";
    session.status = "busy";
    session.error = undefined;
    const controller = new AbortController();
    session.controller = controller;
    this.onChange();
    const requestStart = session.messages.length;
    const conversation = session.conversation;
    const run = async (): Promise<void> => {
      try {
        const answer = await conversation.send(prompt, controller.signal);
        if (
          !session.messages
            .slice(requestStart)
            .some(
              (message) =>
                message.role === "assistant" &&
                !message.agentId &&
                message.content === answer,
            )
        ) {
          session.messages.push({ role: "assistant", content: answer });
        }
        session.status = "ready";
      } catch (error) {
        if (!this.closed) {
          session.sessionId = undefined;
          session.draft = question;
        }
        this.fail(session, error);
        throw error;
      } finally {
        this.clearPendingRequests(id);
        this.onChange();
      }
    };
    const sending = run();
    session.sending = sending;
    try {
      await sending;
    } finally {
      session.sending = undefined;
    }
  }

  cancel(id: string): void {
    this.assertOpen();
    const session = this.getSession(id);
    session.controller?.abort();
    this.clearPendingRequests(id);
    this.onChange();
  }

  closeSession(id: string): Promise<void> {
    return this.manageSession(id, async (session) => {
      await this.stopSession(session);
      session.generation++;
    });
  }

  newSession(id: string): Promise<void> {
    return this.manageSession(id, async (session) => {
      await this.stopSession(session);
      if (this.hasConversation(session)) {
        session.history.push(this.copyConversation(session));
      }
      this.restoreConversation(session);
      this.activeId = id;
      await this.startSession(session);
    });
  }

  deleteSessions(id: string, all: boolean): Promise<void> {
    return this.manageSession(id, async (session) => {
      await this.stopSession(session);
      this.assertOpen();
      if (session.removed) {
        throw new Error("The repository is no longer available.");
      }
      const cleaner = this.createConversation(session.repository);
      session.conversation = cleaner;
      const controller = new AbortController();
      session.controller = controller;
      try {
        do {
          if (!this.hasConversation(session)) {
            const previous = session.history.pop();
            if (!previous) {
              break;
            }
            this.restoreConversation(session, previous);
          }
          if (session.sessionId) {
            await cleaner.deleteSession(session.sessionId, controller.signal);
          }
          this.restoreConversation(session, session.history.pop());
          this.onChange();
        } while (all && this.hasConversation(session));
      } finally {
        await cleaner.dispose();
        session.conversation = undefined;
        session.controller = undefined;
      }
    });
  }

  private manageSession(
    id: string,
    action: (session: RepositorySession) => Promise<void>,
  ): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    const operation = Promise.resolve()
      .then(() => {
        this.assertOpen();
        return action(session);
      })
      .catch((error: unknown) => {
        this.fail(session, error);
        throw error;
      })
      .finally(() => {
        session.managing = undefined;
        this.onChange();
      });
    session.managing = operation;
    this.onChange();
    return operation;
  }

  private async stopSession(session: RepositorySession): Promise<void> {
    const conversation = session.conversation;
    const sessionId = session.sessionId;
    if (session.status === "busy" || session.status === "starting") {
      session.messages.push({
        role: "system",
        content:
          "The operation was interrupted when this session was closed. It will not be resumed automatically.",
      });
    }
    session.controller?.abort();
    this.clearPendingRequests(session.repository.id);
    await conversation?.dispose();
    await Promise.allSettled([
      ...(session.starting ? [session.starting] : []),
      ...(session.sending ? [session.sending] : []),
    ]);
    session.sessionId = sessionId ?? conversation?.sessionId;
    session.conversation = undefined;
    session.controller = undefined;
    session.error = undefined;
    session.status = session.sessionId ? "saved" : "idle";
    session.eventMessages.clear();
  }

  private restoreConversation(
    session: RepositorySession,
    saved?: SavedConversation,
  ): void {
    session.sessionId = saved?.sessionId;
    session.messages = saved?.messages.map((message) => ({ ...message })) ?? [];
    session.draft = saved?.draft ?? "";
    session.status = saved?.sessionId ? "saved" : "idle";
    session.error = undefined;
    session.generation++;
    session.eventMessages.clear();
  }

  private assertAvailable(session: RepositorySession): void {
    if (session.removed) {
      throw new Error("The repository is no longer available.");
    }
    if (session.managing) {
      throw new Error(
        "A session management operation is already running for this repository.",
      );
    }
  }

  private hasConversation(session: SavedConversation): boolean {
    return Boolean(
      session.sessionId || session.draft || session.messages.length,
    );
  }

  private copyConversation(session: SavedConversation): SavedConversation {
    return {
      sessionId: session.sessionId,
      draft: session.draft,
      messages: session.messages.map((message) => ({ ...message })),
    };
  }

  dispose(): Promise<void> {
    return (this.stopping ??= this.stop());
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.clearPendingRequests();
    for (const session of this.sessions.values()) {
      if (session.status === "busy" || session.status === "starting") {
        session.messages.push({
          role: "system",
          content:
            "The operation was interrupted when the application closed. Pending work will not be resumed or sent again automatically.",
        });
      }
      session.controller?.abort();
    }
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        session.conversation?.dispose(),
      ),
    );
    await Promise.allSettled(
      [...this.sessions.values()].flatMap((session) => [
        ...(session.starting ? [session.starting] : []),
        ...(session.sending ? [session.sending] : []),
        ...(session.managing ? [session.managing] : []),
      ]),
    );
  }

  private saveSession(session: RepositorySession): SavedRepositorySession {
    return {
      id: session.repository.id,
      ...this.copyConversation(session),
      history: session.history.length
        ? session.history.map((entry) => this.copyConversation(entry))
        : undefined,
    };
  }

  private clearPendingRequests(repositoryId?: string): void {
    for (const [id, pending] of this.permissions) {
      if (!repositoryId || pending.request.repositoryId === repositoryId) {
        this.permissions.delete(id);
        pending.resolve(false);
      }
    }
    for (const [id, pending] of this.questions) {
      if (!repositoryId || pending.request.repositoryId === repositoryId) {
        this.questions.delete(id);
        pending.reject(
          new DOMException("The question was cancelled.", "AbortError"),
        );
      }
    }
  }

  private getSession(id: string): RepositorySession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(
        "Unknown repository. Choose a directory from the repository list.",
      );
    }
    return session;
  }

  private recordEvent(session: RepositorySession, event: SessionEvent): void {
    const upsert = (
      key: string,
      role: ChatMessage["role"],
      content: string,
      append: boolean,
      title?: string,
    ): void => {
      const id = `${event.agentId ?? ""}:${key}`;
      const previous = session.eventMessages.get(id);
      if (previous) {
        previous.content = append ? previous.content + content : content;
      } else {
        const message: ChatMessage = {
          role,
          content,
          title,
          timestamp: event.timestamp,
          agentId: event.agentId,
        };
        session.eventMessages.set(id, message);
        session.messages.push(message);
      }
    };
    switch (event.type) {
      case "user.message":
        return;
      case "assistant.message_start":
        upsert(`message:${event.data.messageId}`, "assistant", "", false);
        break;
      case "assistant.message_delta":
        upsert(
          `message:${event.data.messageId}`,
          "assistant",
          event.data.deltaContent,
          true,
        );
        break;
      case "assistant.message":
        upsert(
          `message:${event.data.messageId}`,
          "assistant",
          event.data.content,
          false,
        );
        if (event.data.reasoningText) {
          upsert(
            `reasoning:${event.data.messageId}`,
            "reasoning",
            event.data.reasoningText,
            false,
          );
        }
        break;
      case "assistant.reasoning_delta":
        upsert(
          `reasoning:${event.data.reasoningId}`,
          "reasoning",
          event.data.deltaContent,
          true,
        );
        break;
      case "assistant.reasoning":
        upsert(
          `reasoning:${event.data.reasoningId}`,
          "reasoning",
          event.data.content,
          false,
        );
        break;
      case "tool.shell_output":
        upsert(
          `output:${event.data.toolCallId}:${event.data.stream ?? "stdout"}`,
          "output",
          event.data.text,
          true,
          `${event.data.toolCallId} (${event.data.stream ?? "stdout"})`,
        );
        break;
      case "assistant.tool_call_delta":
        upsert(
          `tool-input:${event.data.toolCallId}`,
          "system",
          event.data.inputDelta,
          true,
          `Tool input: ${event.data.toolName ?? event.data.toolCallId}`,
        );
        break;
      default: {
        const message: ChatMessage = {
          role: "system",
          title: event.type,
          content: JSON.stringify(event.data, null, 2),
          timestamp: event.timestamp,
          agentId: event.agentId,
        };
        if (event.type === "tool.execution_start") {
          message.role = "tool";
          message.title = `${event.data.toolName} - running`;
          message.content = describeTool(
            event.data.toolName,
            event.data.arguments,
          );
          message.details = JSON.stringify(event.data, null, 2);
          session.eventMessages.set(
            `${event.agentId ?? ""}:tool:${event.data.toolCallId}`,
            message,
          );
        } else if (event.type === "tool.execution_complete") {
          const tool = session.eventMessages.get(
            `${event.agentId ?? ""}:tool:${event.data.toolCallId}`,
          );
          if (tool?.title) {
            tool.title =
              tool.title?.replace(/ - running$/, "") +
              (event.data.success ? " - completed" : " - failed");
          }
          message.role = "output";
          message.error = !event.data.success;
          message.title = `Tool ${event.data.toolCallId}: ${event.data.success ? "completed" : "failed"}`;
          message.content =
            [event.data.result?.content, event.data.error?.message]
              .filter((part) => part !== undefined)
              .join("\n") ||
            (event.data.success ? "Completed" : "Tool execution failed.");
          message.details = JSON.stringify(event.data, null, 2);
        } else if (event.type === "tool.execution_partial_result") {
          upsert(
            `partial:${event.data.toolCallId}`,
            "output",
            event.data.partialOutput,
            false,
          );
          this.onChange();
          return;
        }
        session.messages.push(message);
      }
    }
    this.onChange();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The Arranged Agents tab is closed.");
    }
  }

  private fail(session: RepositorySession, error: unknown): void {
    session.status = "error";
    session.error =
      error instanceof Error && error.name === "AbortError"
        ? "Request cancelled. Select this repository to start a new session."
        : error instanceof Error
          ? error.message
          : String(error);
  }
}
