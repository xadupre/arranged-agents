import type {
  CopilotClient,
  CopilotSession,
  SessionEvent,
} from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import {
  copilotSessionConfig,
  createCopilotClient,
  type CopilotOptions,
} from "./copilot";

export interface Conversation {
  readonly sessionId?: string;
  start(
    signal: AbortSignal,
    onEvent?: (event: SessionEvent) => void,
    sessionId?: string,
  ): Promise<void>;
  send(prompt: string, signal: AbortSignal): Promise<string>;
  deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export class CopilotConversation implements Conversation {
  private client?: CopilotClient;
  private session?: CopilotSession;
  private readonly lifetime = new AbortController();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private busy = false;

  constructor(private readonly options: CopilotOptions) {}

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  start(
    signal: AbortSignal,
    onEvent?: (event: SessionEvent) => void,
    sessionId?: string,
  ): Promise<void> {
    return (this.starting ??= this.run(async (operationSignal) => {
      const client = await createCopilotClient(this.options);
      operationSignal.throwIfAborted();
      this.client = client;
      await client.start();
      operationSignal.throwIfAborted();
      const config = {
        ...copilotSessionConfig(this.options),
        streaming: true,
        onEvent: (event: SessionEvent) => {
          if (!this.closed) {
            onEvent?.(event);
          }
        },
      };
      this.session = sessionId
        ? await client.resumeSession(sessionId, {
            ...config,
            allowTranscriptRecovery: false,
            continuePendingWork: false,
          })
        : await client.createSession({ ...config, name: "Arranged Agents" });
      operationSignal.throwIfAborted();
    }, signal));
  }

  async send(prompt: string, signal: AbortSignal): Promise<string> {
    if (!this.session || this.closed) {
      throw new Error("Select the repository to start its Copilot session.");
    }
    if (this.busy) {
      throw new Error("A request is already running in this repository.");
    }
    this.busy = true;
    const session = this.session;
    try {
      return await this.run(async () => {
        const response = await session.sendAndWait(
          { prompt },
          this.options.timeoutMs ?? 120_000,
        );
        if (!response?.data.content.trim()) {
          throw new Error("Copilot returned no answer.");
        }
        return response.data.content;
      }, signal);
    } finally {
      this.busy = false;
    }
  }

  deleteSession(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.run(async (operationSignal) => {
      if (!this.client) {
        const client = await createCopilotClient(this.options);
        operationSignal.throwIfAborted();
        this.client = client;
        await client.start();
      }
      operationSignal.throwIfAborted();
      if (await this.client.getSessionMetadata(sessionId)) {
        operationSignal.throwIfAborted();
        await this.client.deleteSession(sessionId);
      }
    }, signal);
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    return (this.stopping ??= this.client?.forceStop() ?? Promise.resolve());
  }

  private async run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    callerSignal: AbortSignal,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("This Copilot session has ended.");
    }
    callerSignal.throwIfAborted();
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      callerSignal,
      this.lifetime.signal,
      deadline.signal,
    ]);
    const timeout = setTimeout(
      () =>
        deadline.abort(
          new Error(`Copilot request timed out after ${timeoutMs}ms.`),
        ),
      timeoutMs,
    );
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([action(signal), cancelled]);
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      clearTimeout(timeout);
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
