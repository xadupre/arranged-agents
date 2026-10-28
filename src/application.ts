import { randomUUID } from "node:crypto";
import { CopilotRecoveryError, type Conversation } from "./conversation";
import { buildPrompt, MAX_PROMPT_LENGTH, MAX_SELECTION_LENGTH } from "./prompt";
import { discoverRepositories, type Repository } from "./repositories";
import { isExternalUrl } from "./links";
import {
  isImageDataUrl,
  MAX_IMAGES,
  parseImages,
  type ImageAttachment,
} from "./images";
import { describeTool } from "./presentation";
import { isGitHubSection, type GitHubSection } from "./github";
import {
  parsePostMortem,
  postMortemSources,
  type PostMortem,
  type PostMortemSource,
} from "./postmortem";
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
  images?: ImageAttachment[];
}
export interface ApplicationState {
  root: string;
  repositories: (Repository & {
    status: SessionStatus;
    hasSavedSession?: boolean;
    sessionCount?: number;
    generation?: number;
    parallelCount?: number;
    queuedCount?: number;
    generatedTokens?: number;
  })[];
  activeId?: string;
  messages: ChatMessage[];
  error?: string;
  draft: string;
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  postMortem?: PostMortem;
  postMortemBusy?: boolean;
  postMortemError?: string;
}
export interface PendingPermission {
  id: string;
  repositoryId: string;
  kind: string;
  summary: string;
  content: string;
  details: string;
  approvalLabel?: string;
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
  generatedTokens: number;
  removed?: boolean;
  eventMessages: Map<string, ChatMessage>;
  imageAssets?: Map<
    string,
    { image?: ImageAttachment; messages: Set<ChatMessage> }
  >;
  postMortem?: PostMortem;
  postMortemError?: string;
  postMortemOperation?: { controller: AbortController; promise: Promise<void> };
  parallel: Map<string, RepositorySession>;
  queue: {
    question: string;
    prompt: string;
    message: ChatMessage;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[];
}

export type ApplicationMessage =
  | { type: "ready" | "refresh" | "settings" }
  | { type: "github"; id: string; section: GitHubSection; cursor?: string }
  | {
      type:
        "select" | "cancel" | "restart" | "postmortem" | "export-postmortem";
      id: string;
    }
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
  | {
      type: "send";
      id: string;
      question: string;
      parallel?: boolean;
      images?: ImageAttachment[];
    };

export function parseApplicationMessage(value: unknown): ApplicationMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid application message.");
  }
  if (
    value.type === "ready" ||
    value.type === "refresh" ||
    value.type === "settings"
  ) {
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
    value.type === "github" &&
    "section" in value &&
    isGitHubSection(value.section) &&
    (!("cursor" in value) ||
      value.cursor === undefined ||
      (typeof value.cursor === "string" && value.cursor.length <= 4096))
  ) {
    return {
      type: "github",
      id: value.id,
      section: value.section,
      cursor:
        "cursor" in value && typeof value.cursor === "string"
          ? value.cursor
          : undefined,
    };
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
    value.type === "postmortem" ||
    value.type === "export-postmortem" ||
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
    typeof value.question === "string" &&
    (!("parallel" in value) ||
      value.parallel === undefined ||
      typeof value.parallel === "boolean")
  ) {
    return {
      type: "send",
      id: value.id,
      question: value.question,
      ...("images" in value && value.images !== undefined
        ? { images: parseImages(value.images) }
        : {}),
      ...("parallel" in value && typeof value.parallel === "boolean"
        ? { parallel: value.parallel }
        : {}),
    };
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
    {
      request: PendingPermission;
      owner: RepositorySession;
      resolve: (approve: boolean) => void;
    }
  >();
  private readonly questions = new Map<
    string,
    {
      request: PendingQuestion;
      owner: RepositorySession;
      resolve: (response: UserInputResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    readonly root: string,
    private readonly createConversation: (
      repository: Repository,
      requestId?: string,
    ) => Conversation,
    private readonly onChange: (streaming?: boolean) => void,
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
        session.postMortemOperation?.controller.abort();
        for (const child of session.parallel.values())
          child.controller?.abort();
        this.cancelQueue(session);
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
          messages:
            saved?.messages.map((message) => ({
              ...message,
              title:
                message.title === "Queued - after current work"
                  ? "Not sent - previous application ended"
                  : message.title,
            })) ?? [],
          history:
            saved?.history?.map((entry) => this.copyConversation(entry)) ?? [],
          generation: 0,
          generatedTokens: saved?.generatedTokens ?? 0,
          eventMessages: new Map(),
          parallel: new Map(),
          queue: [],
          postMortem: saved?.postMortem,
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
          status:
            session.managing || session.postMortemOperation
              ? ("stopping" as const)
              : session.parallel.size &&
                  ["ready", "error"].includes(session.status)
                ? ("busy" as const)
                : session.status,
          hasSavedSession: Boolean(session.sessionId),
          sessionCount:
            session.history.length +
            session.parallel.size +
            (this.hasConversation(session) ? 1 : 0),
          generation: session.generation,
          parallelCount: session.parallel.size,
          queuedCount: session.queue.length,
          generatedTokens: session.generatedTokens,
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
      postMortem: active?.postMortem
        ? structuredClone(active.postMortem)
        : undefined,
      postMortemBusy: Boolean(active?.postMortemOperation),
      postMortemError: active?.postMortemError,
    };
  }

  requestPermission(
    repositoryId: string,
    permission: Omit<PendingPermission, "id" | "repositoryId">,
    requestId?: string,
  ): Promise<boolean> {
    const session = this.getRequestSession(repositoryId, requestId);
    if (
      this.closed ||
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      return Promise.resolve(false);
    }
    const request = {
      ...permission,
      summary: requestId
        ? `Parallel ${requestId.slice(0, 8)}: ${permission.summary}`
        : permission.summary,
      id: randomUUID(),
      repositoryId,
    };
    return new Promise((resolve) => {
      this.permissions.set(request.id, { request, owner: session, resolve });
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
    requestId?: string,
  ): Promise<UserInputResponse> {
    this.assertOpen();
    const session = this.getRequestSession(repositoryId, requestId);
    if (
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    const request: PendingQuestion = {
      ...question,
      question: requestId
        ? `Parallel ${requestId.slice(0, 8)}: ${question.question}`
        : question.question,
      choices: question.choices ? [...question.choices] : undefined,
      id: randomUUID(),
      repositoryId,
    };
    const message: ChatMessage = {
      role: "assistant",
      content: question.question,
      ...(requestId ? { title: `Parallel ${requestId.slice(0, 8)}` } : {}),
    };
    session.messages.push(message);
    if (requestId) this.getSession(repositoryId).messages.push(message);
    return new Promise((resolve, reject) => {
      this.questions.set(request.id, {
        request,
        owner: session,
        resolve,
        reject,
      });
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
    const message: ChatMessage = {
      role: "user",
      content: answer,
    };
    this.getSession(pending.request.repositoryId).messages.push(message);
    if (pending.owner !== this.getSession(pending.request.repositoryId)) {
      pending.owner.messages.push(message);
    }
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

  createPostMortem(
    id: string,
    generate: (
      source: PostMortemSource,
      signal: AbortSignal,
    ) => Promise<PostMortem>,
  ): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    if (
      id !== this.activeId ||
      ["starting", "busy"].includes(session.status) ||
      session.parallel.size ||
      session.queue.length
    ) {
      throw new Error(
        "Wait for this conversation's work to finish before generating its PostMortem.",
      );
    }
    if (!session.messages.length)
      throw new Error("There is no conversation to analyse.");
    const source: PostMortemSource = {
      repository: { ...session.repository },
      sessionId: session.sessionId,
      messages: session.messages.map((message) => ({ ...message })),
    };
    const controller = new AbortController();
    session.postMortemError = undefined;
    const promise = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const report = parsePostMortem(
          await generate(source, controller.signal),
        );
        controller.signal.throwIfAborted();
        this.assertOpen();
        if (
          session.removed ||
          report.repository.id !== id ||
          report.sourceCount !== source.messages.length
        ) {
          throw new Error(
            "The PostMortem belongs to a different conversation.",
          );
        }
        postMortemSources(report, session.messages);
        session.postMortem = report;
      })
      .catch((error: unknown) => {
        if (!this.closed)
          session.postMortemError =
            error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        session.postMortemOperation = undefined;
        this.onChange();
      });
    session.postMortemOperation = { controller, promise };
    this.onChange();
    return promise;
  }

  exportPostMortem(id: string): string {
    this.assertOpen();
    const session = this.getSession(id);
    const report = session.postMortem;
    if (!report) throw new Error("Generate a PostMortem before exporting it.");
    return (
      JSON.stringify(
        {
          ...report,
          sources: postMortemSources(report, session.messages).map(
            (message, index) => ({ index: index + 1, ...message }),
          ),
        },
        null,
        2,
      ) + "\n"
    );
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
    if (
      current.status === "starting" ||
      current.status === "busy" ||
      current.parallel.size
    ) {
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
    if (!session.sessionId) session.generatedTokens = 0;
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
        session.imageAssets?.clear();
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
        this.clearPendingRequests(id, session);
        this.onChange();
      }
    };
    session.starting = start();
    return session.starting;
  }

  async send(
    id: string,
    question: string,
    parallel = true,
    images?: ImageAttachment[],
  ): Promise<void> {
    images = images === undefined ? undefined : parseImages(images);
    if (!question.trim() && images?.length)
      question = "Describe the attached images.";
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    if (
      id !== this.activeId ||
      (!["ready", "busy"].includes(session.status) &&
        !(session.status === "error" && session.parallel.size && parallel)) ||
      !session.conversation
    ) {
      throw new Error(
        "Select a ready repository session before sending a message.",
      );
    }
    const prompt = buildPrompt(question);
    if (session.status === "busy" || session.parallel.size) {
      if (parallel) return this.sendParallel(session, question, images);
      return new Promise<void>((resolve, reject) => {
        const message: ChatMessage = {
          role: "user",
          content: question.trim(),
          title: "Queued - after current work",
          ...(images?.length ? { images } : {}),
        };
        session.queue.push({ question, prompt, message, resolve, reject });
        session.messages.push(message);
        session.draft = "";
        this.onChange();
      });
    }
    return this.sendMain(session, question, prompt, undefined, images);
  }

  private async sendMain(
    session: RepositorySession,
    question: string,
    prompt: string,
    queuedMessage?: ChatMessage,
    images = queuedMessage?.images,
  ): Promise<void> {
    const conversation = session.conversation;
    if (!conversation) throw new Error("The repository session is not open.");
    const id = session.repository.id;
    if (queuedMessage) queuedMessage.title = "Sent after current work";
    else
      session.messages.push({
        role: "user",
        content: question.trim(),
        ...(images?.length ? { images } : {}),
      });
    session.draft = "";
    session.status = "busy";
    session.error = undefined;
    const controller = new AbortController();
    session.controller = controller;
    this.onChange();
    const requestStart = session.messages.length;
    const run = async (): Promise<void> => {
      try {
        const answer = await conversation.send(
          prompt,
          controller.signal,
          images,
        );
        if (
          !session.messages
            .slice(requestStart)
            .some(
              (message) =>
                message.role === "assistant" &&
                !message.title &&
                !message.agentId &&
                message.content === answer,
            )
        ) {
          session.messages.push({ role: "assistant", content: answer });
        }
      } catch (error) {
        if (!this.closed) {
          if (!(error instanceof CopilotRecoveryError))
            session.sessionId = undefined;
          session.draft = question;
        }
        this.fail(session, error);
        this.cancelQueue(session);
        throw error;
      } finally {
        this.clearPendingRequests(id, session);
        this.onChange();
      }
    };
    const sending = run();
    session.sending = sending;
    try {
      await sending;
    } finally {
      session.sending = undefined;
      if (session.status === "busy") session.status = "ready";
      this.drainQueue(session);
      this.onChange();
    }
  }

  private async sendParallel(
    parent: RepositorySession,
    question: string,
    images?: ImageAttachment[],
  ): Promise<void> {
    const requestId = randomUUID();
    const parentConversation = parent.conversation;
    const label = `Parallel ${requestId.slice(0, 8)}`;
    let remaining = MAX_SELECTION_LENGTH;
    const context: string[] = [];
    for (
      let index = parent.messages.length - 1;
      index >= 0 && remaining > 0;
      index--
    ) {
      const message = parent.messages[index]!;
      if (!["user", "assistant", "tool"].includes(message.role)) continue;
      const excerpt =
        `${message.role}: ${message.content.slice(-remaining)}`.slice(
          -remaining,
        );
      context.push(excerpt);
      remaining -= excerpt.length;
    }
    const prompt = buildPrompt(
      question,
      context.reverse().join("\n").slice(-MAX_SELECTION_LENGTH),
    );
    const user: ChatMessage = {
      role: "user",
      title: label,
      content: question.trim(),
      ...(images?.length ? { images } : {}),
    };
    const controller = new AbortController();
    const child: RepositorySession = {
      repository: parent.repository,
      status: "starting",
      messages: [user],
      draft: "",
      history: [],
      generation: 0,
      generatedTokens: 0,
      eventMessages: new Map(),
      parallel: new Map(),
      queue: [],
      controller,
    };
    parent.parallel.set(requestId, child);
    parent.messages.push(user);
    parent.draft = "";
    this.onChange();
    const run = async (): Promise<void> => {
      try {
        const conversation = this.createConversation(
          parent.repository,
          requestId,
        );
        child.conversation = conversation;
        await conversation.start(controller.signal, (event) => {
          if (!this.closed && parent.parallel.get(requestId) === child) {
            const tokenOwner =
              parent.conversation === parentConversation
                ? parent
                : (parent.history.find(
                    (entry) =>
                      entry.sessionId === parentConversation?.sessionId,
                  ) ?? child);
            this.recordEvent(child, event, parent.messages, label, tokenOwner);
          }
        });
        child.sessionId = conversation.sessionId;
        child.status = "busy";
        this.onChange();
        const answer = await conversation.send(
          prompt,
          controller.signal,
          images,
        );
        if (
          !child.messages.some(
            (message) =>
              message.role === "assistant" &&
              !message.agentId &&
              message.content === answer,
          )
        ) {
          const message: ChatMessage = {
            role: "assistant",
            title: label,
            content: answer,
          };
          child.messages.push(message);
          parent.messages.push(message);
        }
      } catch (error) {
        if (error instanceof CopilotRecoveryError) this.interruptWork(child);
        const message: ChatMessage = {
          role: "assistant",
          title: `${label} - failed`,
          error: true,
          content: error instanceof Error ? error.message : String(error),
        };
        child.messages.push(message);
        parent.messages.push(message);
        throw error;
      } finally {
        this.clearPendingRequests(parent.repository.id, child);
        try {
          await child.conversation?.dispose();
        } finally {
          child.sessionId ??= child.conversation?.sessionId;
          parent.history.push(this.copyConversation(child));
          parent.parallel.delete(requestId);
          this.onChange();
          this.drainQueue(parent);
        }
      }
    };
    child.sending = run();
    return child.sending;
  }

  private drainQueue(session: RepositorySession): void {
    if (
      this.closed ||
      session.removed ||
      session.managing ||
      session.sending ||
      session.status !== "ready" ||
      session.parallel.size
    )
      return;
    const next = session.queue.shift();
    if (!next) return;
    void this.sendMain(session, next.question, next.prompt, next.message).then(
      next.resolve,
      next.reject,
    );
  }

  private cancelQueue(session: RepositorySession): void {
    for (const queued of session.queue.splice(0)) {
      queued.message.title = "Not sent - queue cancelled";
      queued.reject(
        new DOMException("The queued message was cancelled.", "AbortError"),
      );
    }
  }

  cancel(id: string): void {
    this.assertOpen();
    const session = this.getSession(id);
    if (session.postMortemOperation) {
      session.postMortemOperation.controller.abort();
      this.onChange();
      return;
    }
    session.controller?.abort();
    for (const child of session.parallel.values()) child.controller?.abort();
    this.cancelQueue(session);
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
    const postMortem = session.postMortemOperation;
    postMortem?.controller.abort();
    this.cancelQueue(session);
    const children = [...session.parallel.values()];
    for (const child of children) child.controller?.abort();
    this.clearPendingRequests(session.repository.id);
    await conversation?.dispose();
    await Promise.allSettled([
      ...(session.starting ? [session.starting] : []),
      ...(session.sending ? [session.sending] : []),
      ...children.flatMap((child) => (child.sending ? [child.sending] : [])),
      ...(postMortem ? [postMortem.promise] : []),
    ]);
    session.sessionId = sessionId ?? conversation?.sessionId;
    session.conversation = undefined;
    session.controller = undefined;
    session.error = undefined;
    session.status = session.sessionId ? "saved" : "idle";
    session.eventMessages.clear();
    session.imageAssets?.clear();
  }

  private restoreConversation(
    session: RepositorySession,
    saved?: SavedConversation,
  ): void {
    session.sessionId = saved?.sessionId;
    session.generatedTokens = saved?.generatedTokens ?? 0;
    session.messages = saved?.messages.map((message) => ({ ...message })) ?? [];
    session.draft = saved?.draft ?? "";
    session.status = saved?.sessionId ? "saved" : "idle";
    session.error = undefined;
    session.generation++;
    session.eventMessages.clear();
    session.imageAssets?.clear();
    session.postMortem = saved?.postMortem
      ? structuredClone(saved.postMortem)
      : undefined;
    session.postMortemError = undefined;
  }

  private assertAvailable(session: RepositorySession): void {
    if (session.removed) {
      throw new Error("The repository is no longer available.");
    }
    if (session.postMortemOperation) {
      throw new Error(
        "A PostMortem is already being generated for this repository.",
      );
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
      generatedTokens: session.generatedTokens,
      draft: session.draft,
      messages: session.messages.map((message) => ({ ...message })),
      ...(session.postMortem
        ? { postMortem: structuredClone(session.postMortem) }
        : {}),
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
      session.postMortemOperation?.controller.abort();
      this.cancelQueue(session);
      for (const child of session.parallel.values()) child.controller?.abort();
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
        ...(session.postMortemOperation
          ? [session.postMortemOperation.promise]
          : []),
        ...[...session.parallel.values()].flatMap((child) =>
          child.sending ? [child.sending] : [],
        ),
      ]),
    );
  }

  private saveSession(session: RepositorySession): SavedRepositorySession {
    const history = [...session.history, ...session.parallel.values()];
    return {
      id: session.repository.id,
      ...this.copyConversation(session),
      history: history.length
        ? history.map((entry) => this.copyConversation(entry))
        : undefined,
    };
  }

  private clearPendingRequests(
    repositoryId?: string,
    owner?: RepositorySession,
  ): void {
    for (const [id, pending] of this.permissions) {
      if (
        (!repositoryId || pending.request.repositoryId === repositoryId) &&
        (!owner || pending.owner === owner)
      ) {
        this.permissions.delete(id);
        pending.resolve(false);
      }
    }
    for (const [id, pending] of this.questions) {
      if (
        (!repositoryId || pending.request.repositoryId === repositoryId) &&
        (!owner || pending.owner === owner)
      ) {
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

  private getRequestSession(id: string, requestId?: string): RepositorySession {
    const parent = this.getSession(id);
    if (!requestId) return parent;
    const child = parent.parallel.get(requestId);
    if (!child) throw new Error("This parallel request has ended.");
    return child;
  }

  private recordEvent(
    session: RepositorySession,
    event: SessionEvent,
    destination?: ChatMessage[],
    label?: string,
    tokenOwner: Pick<SavedConversation, "generatedTokens"> = session,
  ): void {
    if (event.type === "assistant.usage") {
      const tokens = event.data.outputTokens;
      const ownerTokens = tokenOwner.generatedTokens ?? 0;
      if (
        typeof tokens === "number" &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0 &&
        Number.isSafeInteger(session.generatedTokens + tokens) &&
        Number.isSafeInteger(ownerTokens + tokens)
      ) {
        session.generatedTokens += tokens;
        if (tokenOwner !== session)
          tokenOwner.generatedTokens = ownerTokens + tokens;
      }
    }
    const addImage = (message: ChatMessage, image: ImageAttachment): void => {
      const images = (message.images ??= []);
      if (
        images.length < MAX_IMAGES &&
        !images.some((other) => other.dataUrl === image.dataUrl)
      ) {
        images.push(image);
      }
    };
    const imageAsset = (id: string) => {
      const assets = (session.imageAssets ??= new Map());
      let asset = assets.get(id);
      if (!asset) {
        asset = { messages: new Set() };
        assets.set(id, asset);
      }
      return asset;
    };
    const push = (message: ChatMessage): void => {
      if (label)
        message.title = message.title ? `${label}: ${message.title}` : label;
      session.messages.push(message);
      destination?.push(message);
    };
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
        push(message);
      }
    };
    switch (event.type) {
      case "session.binary_asset": {
        if (event.data.type !== "image") return;
        const dataUrl = `data:${event.data.mimeType};base64,${event.data.data}`;
        if (!isImageDataUrl(dataUrl)) return;
        const asset = imageAsset(event.data.assetId);
        asset.image = { name: "Tool image", dataUrl };
        for (const message of asset.messages) addImage(message, asset.image);
        asset.messages.clear();
        this.onChange(true);
        return;
      }
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
        if (
          event.type === "session.warning" &&
          event.data.warningType === "crash_recovery"
        ) {
          this.interruptWork(session);
          message.title = "Copilot recovery";
          message.content = event.data.message;
          message.error = true;
        } else if (event.type === "tool.execution_start") {
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
          const result = event.data.result;
          for (const part of [
            ...(result?.contents ?? []),
            ...(result?.binaryResultsForLlm ?? []),
          ]) {
            if (part.type !== "image") continue;
            if ("data" in part) {
              const dataUrl = `data:${part.mimeType};base64,${part.data}`;
              if (isImageDataUrl(dataUrl)) {
                addImage(message, { name: "Tool image", dataUrl });
              }
            } else if ("assetId" in part) {
              const asset = imageAsset(part.assetId);
              if (asset.image) addImage(message, asset.image);
              else asset.messages.add(message);
            }
          }
        } else if (event.type === "tool.execution_partial_result") {
          upsert(
            `partial:${event.data.toolCallId}`,
            "output",
            event.data.partialOutput,
            false,
          );
          this.onChange(true);
          return;
        }
        push(message);
      }
    }
    this.onChange(true);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The Arranged Agents tab is closed.");
    }
  }

  private interruptWork(session: RepositorySession): void {
    this.clearPendingRequests(session.repository.id, session);
    for (const message of session.eventMessages.values()) {
      if (message.role === "tool" && message.title?.endsWith(" - running")) {
        message.title = message.title.replace(/ - running$/, " - interrupted");
        message.error = true;
      }
    }
    session.eventMessages.clear();
    session.imageAssets?.clear();
  }

  private fail(session: RepositorySession, error: unknown): void {
    if (error instanceof CopilotRecoveryError) this.interruptWork(session);
    session.status = "error";
    session.error =
      error instanceof Error && error.name === "AbortError"
        ? "Request cancelled. Select this repository to start a new session."
        : error instanceof Error
          ? error.message
          : String(error);
  }
}
