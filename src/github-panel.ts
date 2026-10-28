import {
  GitHubRepository,
  type GitHubSection,
  type GitHubUpdate,
} from "./github";
import type { Repository } from "./repositories";

export class GitHubPanel {
  private readonly requests = new Map<
    string,
    {
      id: string;
      controller: AbortController;
    }
  >();
  private closed = false;
  private readonly operations = new Set<Promise<void>>();

  constructor(
    private readonly publish: (update: GitHubUpdate) => void,
    private readonly report: (error: unknown) => void,
    private readonly create = (repository: Repository) =>
      new GitHubRepository(repository.path),
  ) {}

  load(
    repository: Repository,
    section: GitHubSection,
    cursor?: string,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("The GitHub panel is closed."));
    }
    const key = JSON.stringify([repository.id, section]);
    this.requests.get(key)?.controller.abort();
    const controller = new AbortController();
    const base = {
      type: "github" as const,
      id: repository.id,
      section,
      append: Boolean(cursor),
    };
    const current = (): boolean =>
      !this.closed && this.requests.get(key)?.controller === controller;
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const page = await this.create(repository).load(
          section,
          cursor,
          controller.signal,
        );
        if (current()) this.publish({ ...base, status: "ready", page });
      } catch (error) {
        if (current() && !controller.signal.aborted) {
          this.report(error);
          this.publish({
            ...base,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (current()) this.requests.delete(key);
        this.operations.delete(promise);
      }
    });
    this.operations.add(promise);
    this.requests.set(key, { id: repository.id, controller });
    this.publish({ ...base, status: "loading" });
    return promise;
  }

  retain(ids: Set<string>): void {
    for (const [key, request] of this.requests) {
      if (!ids.has(request.id)) {
        request.controller.abort();
        this.requests.delete(key);
      }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const pending = [...this.requests.values()];
    for (const request of pending) request.controller.abort();
    await Promise.allSettled(this.operations);
    this.requests.clear();
  }
}
