import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./application";
import { parsePostMortem, type PostMortem } from "./postmortem";

export interface SavedConversation {
  sessionId?: string;
  draft: string;
  messages: ChatMessage[];
  postMortem?: PostMortem;
}

export interface SavedRepositorySession extends SavedConversation {
  id: string;
  history?: SavedConversation[];
}

export interface SavedApplication {
  version: 1;
  root: string;
  activeId?: string;
  sessions: SavedRepositorySession[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    ["user", "assistant", "system", "reasoning", "tool", "output"].includes(
      value.role,
    ) &&
    typeof value.content === "string" &&
    (value.error === undefined || typeof value.error === "boolean") &&
    ["title", "timestamp", "agentId", "details"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}

function parseConversation(value: unknown): SavedConversation {
  if (
    !isRecord(value) ||
    typeof value.draft !== "string" ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || !value.sessionId)) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage)
  ) {
    throw new Error("Invalid conversation in saved Arranged Agents history.");
  }
  const postMortem =
    value.postMortem === undefined
      ? undefined
      : parsePostMortem(value.postMortem);
  if (postMortem && postMortem.sourceCount > value.messages.length) {
    throw new Error(
      "Saved PostMortem references missing conversation records.",
    );
  }
  return {
    sessionId: value.sessionId,
    draft: value.draft,
    messages: value.messages.map((message) => ({
      role: message.role,
      content: message.content,
      title: message.title,
      timestamp: message.timestamp,
      agentId: message.agentId,
      details: message.details,
      error: message.error,
    })),
    ...(postMortem ? { postMortem } : {}),
  };
}

function parseSavedApplication(value: unknown, root: string): SavedApplication {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.root !== root ||
    (value.activeId !== undefined && typeof value.activeId !== "string") ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("Invalid saved Arranged Agents history.");
  }
  const ids = new Set<string>();
  const sessions = value.sessions.map(
    (session: unknown): SavedRepositorySession => {
      if (
        !isRecord(session) ||
        typeof session.id !== "string" ||
        ids.has(session.id) ||
        (session.history !== undefined && !Array.isArray(session.history))
      ) {
        throw new Error("Invalid repository in saved Arranged Agents history.");
      }
      ids.add(session.id);
      return {
        id: session.id,
        ...parseConversation(session),
        history: session.history?.map(parseConversation),
      };
    },
  );
  return { version: 1, root, activeId: value.activeId, sessions };
}

export class ApplicationStorage {
  readonly filename: string;
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    storageDirectory: string,
    private readonly root: string,
  ) {
    this.directory = join(storageDirectory, "conversations");
    this.filename = join(
      this.directory,
      `${createHash("sha256").update(root).digest("hex")}.json`,
    );
  }

  async load(): Promise<SavedApplication | undefined> {
    let content: string;
    try {
      content = await readFile(this.filename, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return parseSavedApplication(JSON.parse(content), this.root);
  }

  save(snapshot: SavedApplication): Promise<void> {
    const content = JSON.stringify(parseSavedApplication(snapshot, this.root));
    const write = async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.filename);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    // A failed save is returned to its caller; a later save can retry.
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
