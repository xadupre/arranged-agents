import { randomUUID } from "node:crypto";
import type { Conversation } from "./conversation";
import { buildPrompt, MAX_PROMPT_LENGTH } from "./prompt";
import { discoverRepositories, type Repository } from "./repositories";
import { isExternalUrl } from "./links";
import type { SavedApplication, SavedRepositorySession } from "./storage";
import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};

export type SessionStatus =
  "idle" | "saved" | "starting" | "ready" | "busy" | "error";
export type InformationType =
  "messages" | "reasoning" | "tools" | "output" | "system";
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "reasoning" | "tool" | "output";
  content: string;
  title?: string;
  timestamp?: string;
  agentId?: string;
  details?: string;
}
export interface ApplicationState {
  root: string;
  repositories: (Repository & {
    status: SessionStatus;
    hasSavedSession?: boolean;
  })[];
  activeId?: string;
  messages: ChatMessage[];
  error?: string;
  draft: string;
  permissions: PendingPermission[];
}
export interface PendingPermission {
  id: string;
  repositoryId: string;
  kind: string;
  details: string;
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
  eventMessages: Map<string, ChatMessage>;
}

export type ApplicationMessage =
  | { type: "ready" | "refresh" }
  | { type: "select" | "cancel" | "restart"; id: string }
  | { type: "draft"; id: string; text: string }
  | { type: "permission"; id: string; approve: boolean }
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
    value.type === "permission" &&
    "approve" in value &&
    typeof value.approve === "boolean"
  ) {
    return { type: "permission", id: value.id, approve: value.approve };
  }
  if (
    value.type === "select" ||
    value.type === "cancel" ||
    value.type === "restart"
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
        session.controller?.abort();
        this.rejectPermissions(id);
        await session.conversation?.dispose();
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
        .map(({ repository, status, sessionId }) => ({
          ...repository,
          status,
          hasSavedSession: Boolean(sessionId),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      activeId: this.activeId,
      messages: active?.messages.map((message) => ({ ...message })) ?? [],
      error: active?.error,
      draft: active?.draft ?? "",
      permissions: [...this.permissions.values()].map(({ request }) => ({
        ...request,
      })),
    };
  }

  requestPermission(
    repositoryId: string,
    kind: string,
    details: string,
  ): Promise<boolean> {
    const session = this.getSession(repositoryId);
    if (
      this.closed ||
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      return Promise.resolve(false);
    }
    const request = { id: randomUUID(), repositoryId, kind, details };
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
    this.getSession(id).draft = text;
    this.onChange();
  }

  async restart(id: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    if (session.status === "starting" || session.status === "busy") {
      throw new Error(
        "Cancel the running operation before starting a new session.",
      );
    }
    await session.conversation?.dispose();
    session.conversation = undefined;
    session.sessionId = undefined;
    session.status = "idle";
    session.messages.push({
      role: "system",
      content:
        "Starting a new Copilot session. Earlier messages are kept for reference, not replayed as context.",
    });
    await this.select(id);
  }

  async select(id: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.activeId = id;
    this.onChange();
    if (session.status === "starting") {
      return session.starting;
    }
    if (session.status === "ready" || session.status === "busy") {
      return;
    }
    const previous = session.conversation;
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
        this.rejectPermissions(id);
        this.onChange();
      }
    };
    session.starting = start();
    return session.starting;
  }

  async send(id: string, question: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
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
        this.rejectPermissions(id);
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
    this.rejectPermissions(id);
    this.onChange();
  }

  dispose(): Promise<void> {
    return (this.stopping ??= this.stop());
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.rejectPermissions();
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
      ]),
    );
  }

  private saveSession(session: RepositorySession): SavedRepositorySession {
    return {
      id: session.repository.id,
      sessionId: session.sessionId,
      draft: session.draft,
      messages: session.messages.map((message) => ({ ...message })),
    };
  }

  private rejectPermissions(repositoryId?: string): void {
    for (const [id, pending] of this.permissions) {
      if (!repositoryId || pending.request.repositoryId === repositoryId) {
        this.permissions.delete(id);
        pending.resolve(false);
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
      default: {
        const tool =
          event.type.startsWith("tool.") ||
          event.type === "assistant.tool_call_delta";
        const message: ChatMessage = {
          role: tool ? "tool" : "system",
          title: event.type,
          content: JSON.stringify(event.data, null, 2),
          timestamp: event.timestamp,
          agentId: event.agentId,
        };
        if (event.type === "tool.execution_start") {
          message.title = `Tool: ${event.data.toolName}`;
          const args = event.data.arguments;
          if (
            args &&
            typeof args === "object" &&
            !Array.isArray(args) &&
            typeof args.command === "string"
          ) {
            message.content = args.command;
            message.details = JSON.stringify(event.data, null, 2);
          }
        } else if (event.type === "tool.execution_complete") {
          message.role = "output";
          message.title = `Tool ${event.data.toolCallId}: ${event.data.success ? "completed" : "failed"}`;
          message.content = [
            event.data.result?.content,
            event.data.error?.message,
          ]
            .filter((part) => part !== undefined)
            .join("\n");
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
