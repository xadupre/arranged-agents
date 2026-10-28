import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./application";

export interface SavedRepositorySession {
  id: string;
  sessionId?: string;
  draft: string;
  messages: ChatMessage[];
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
    ["title", "timestamp", "agentId", "details"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
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
        typeof session.draft !== "string" ||
        (session.sessionId !== undefined &&
          (typeof session.sessionId !== "string" || !session.sessionId)) ||
        !Array.isArray(session.messages) ||
        !session.messages.every(isMessage)
      ) {
        throw new Error("Invalid repository in saved Arranged Agents history.");
      }
      ids.add(session.id);
      return {
        id: session.id,
        sessionId: session.sessionId,
        draft: session.draft,
        messages: session.messages.map((message) => ({
          role: message.role,
          content: message.content,
          title: message.title,
          timestamp: message.timestamp,
          agentId: message.agentId,
          details: message.details,
        })),
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
