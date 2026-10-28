import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { isExternalUrl } from "./links";

export type GitHubSection =
  "issues" | "reviews" | "comments" | "commits" | "mentions";
export function isGitHubSection(value: unknown): value is GitHubSection {
  return ["issues", "reviews", "comments", "commits", "mentions"].some(
    (section) => section === value,
  );
}

export interface GitHubComment {
  id: string;
  author: string;
  mine: boolean;
  body: string;
  date: string;
  url: string;
}
export interface GitHubItem {
  id: string;
  title: string;
  url?: string;
  author: string;
  date: string;
  mine: boolean;
  replied: boolean;
  afterMe: boolean;
  comments?: GitHubComment[];
}
export interface GitHubPage {
  repository: string;
  viewer?: string;
  items: GitHubItem[];
  cursor?: string;
  notice?: string;
}
export interface GitHubUpdate {
  type: "github";
  id: string;
  section: GitHubSection;
  status: "loading" | "ready" | "error";
  append: boolean;
  page?: GitHubPage;
  error?: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

const execute = promisify(execFile);
export const runCommand: CommandRunner = async (file, args, cwd, signal) => {
  try {
    const { stdout } = await execute(file, args, {
      cwd,
      signal,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.trim()
    ) {
      throw new Error(`${file}: ${error.stderr.trim()}`, { cause: error });
    }
    throw error;
  }
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub response: expected an object.");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid GitHub response: expected text.");
  }
  return value;
}
function url(value: unknown): string {
  const result = text(value);
  if (!isExternalUrl(result)) {
    throw new Error("Invalid GitHub response: expected an HTTP/HTTPS URL.");
  }
  return result;
}
function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error("Invalid GitHub response: expected a timestamp.");
  }
  return result;
}
function author(value: unknown): string {
  return value === null ? "[deleted]" : text(record(value).login);
}
function connection(value: unknown, backwards = false) {
  const data = record(value);
  const info = record(data.pageInfo);
  const more = info[backwards ? "hasPreviousPage" : "hasNextPage"];
  const cursor = info[backwards ? "startCursor" : "endCursor"];
  if (
    !Array.isArray(data.nodes) ||
    typeof more !== "boolean" ||
    (more && (typeof cursor !== "string" || !cursor))
  ) {
    throw new Error("Invalid GitHub pagination response.");
  }
  return {
    nodes: data.nodes.map(record),
    cursor: more ? text(cursor) : undefined,
  };
}
const commentFields = "id author { login } body createdAt url";
const pageFields = "pageInfo { hasPreviousPage startCursor }";
const commentsField = `comments(last:50) { ${pageFields} nodes { ${commentFields} } }`;
const reviewFields = `id author { login } body submittedAt state url
  comments(last:20) { ${pageFields} nodes { ${commentFields} } }`;
const issueFields = `id number title url author { login } updatedAt ${commentsField}`;
const pullFields = `${issueFields}
  reviews(last:20) { ${pageFields} nodes { ${reviewFields} } }`;
const nextPageFields = "pageInfo { hasNextPage endCursor }";

interface Identity {
  owner: string;
  name: string;
  host: string;
  viewer: string;
}
interface CommentCursor {
  commented?: string;
  reviewed?: string;
  commentedDone: boolean;
  reviewedDone: boolean;
}
function commentCursor(cursor?: string): CommentCursor {
  if (!cursor) {
    return { commentedDone: false, reviewedDone: false };
  }
  const value = record(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
  if (
    typeof value.commentedDone !== "boolean" ||
    typeof value.reviewedDone !== "boolean" ||
    (value.commented !== undefined && typeof value.commented !== "string") ||
    (value.reviewed !== undefined && typeof value.reviewed !== "string")
  ) {
    throw new Error("Invalid comments page cursor.");
  }
  return {
    commented: value.commented,
    reviewed: value.reviewed,
    commentedDone: value.commentedDone,
    reviewedDone: value.reviewedDone,
  };
}

export class GitHubRepository {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = runCommand,
  ) {}

  async load(
    section: GitHubSection,
    cursor: string | undefined,
    callerSignal: AbortSignal,
  ): Promise<GitHubPage> {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      callerSignal,
      lifetime.signal,
      AbortSignal.timeout(120_000),
    ]);
    try {
      return await this.read(section, cursor, signal);
    } finally {
      lifetime.abort();
    }
  }

  private async read(
    section: GitHubSection,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<GitHubPage> {
    signal.throwIfAborted();
    if (section === "commits") {
      return this.commits(signal);
    }
    const repository = record(
      JSON.parse(
        await this.run(
          "gh",
          ["repo", "view", "--json", "nameWithOwner,url"],
          this.cwd,
          signal,
        ),
      ),
    );
    const nameWithOwner = text(repository.nameWithOwner);
    const [owner, name, extra] = nameWithOwner.split("/");
    if (!owner || !name || extra) {
      throw new Error("Invalid GitHub repository identity.");
    }
    const host = new URL(url(repository.url)).hostname;
    const user = record(
      JSON.parse(
        await this.run(
          "gh",
          ["api", "--hostname", host, "user"],
          this.cwd,
          signal,
        ),
      ),
    );
    const identity = { owner, name, host, viewer: text(user.login) };
    const variables: Record<string, string | boolean> = { owner, name };
    if (section === "comments") {
      const current = commentCursor(cursor);
      Object.assign(variables, {
        commentedQuery: `repo:${nameWithOwner} commenter:${identity.viewer} sort:updated-desc`,
        reviewedQuery: `repo:${nameWithOwner} is:pr reviewed-by:${identity.viewer} sort:updated-desc`,
        loadCommented: !current.commentedDone,
        loadReviewed: !current.reviewedDone,
      });
      if (current.commented) variables.commented = current.commented;
      if (current.reviewed) variables.reviewed = current.reviewed;
      const data = await this.graphql(
        identity,
        `query(
        $commentedQuery:String!, $reviewedQuery:String!,
        $commented:String, $reviewed:String, $loadCommented:Boolean!, $loadReviewed:Boolean!
      ) {
        commented:search(query:$commentedQuery,type:ISSUE,first:10,after:$commented)
          @include(if:$loadCommented) { ${nextPageFields} nodes {
            ... on Issue { ${issueFields} }
            ... on PullRequest { ${pullFields} }
          } }
        reviewed:search(query:$reviewedQuery,type:ISSUE,first:10,after:$reviewed)
          @include(if:$loadReviewed) { ${nextPageFields} nodes {
            ... on PullRequest { ${pullFields} }
          } }
      }`,
        variables,
        signal,
      );
      const commented = current.commentedDone
        ? undefined
        : connection(data.commented);
      const reviewed = current.reviewedDone
        ? undefined
        : connection(data.reviewed);
      const next: CommentCursor = {
        commented: commented?.cursor,
        reviewed: reviewed?.cursor,
        commentedDone: !commented?.cursor,
        reviewedDone: !reviewed?.cursor,
      };
      const nodes = [
        ...new Map(
          [...(commented?.nodes ?? []), ...(reviewed?.nodes ?? [])].map(
            (node) => [text(node.id), node],
          ),
        ).values(),
      ];
      return {
        repository: nameWithOwner,
        viewer: identity.viewer,
        items: (await this.items(nodes, identity, signal, true)).filter(
          (item) => item.replied,
        ),
        cursor:
          next.commentedDone && next.reviewedDone
            ? undefined
            : Buffer.from(JSON.stringify(next)).toString("base64url"),
        notice:
          "Your comments and submitted reviews, plus comments posted after your latest response in each issue or PR. Includes closed discussions.",
      };
    }
    if (cursor) variables.cursor = cursor;
    if (section === "mentions") {
      variables.searchQuery = `repo:${nameWithOwner} mentions:${identity.viewer} sort:updated-desc`;
      const data = await this.graphql(
        identity,
        `query($searchQuery:String!,$cursor:String) {
          search(query:$searchQuery,type:ISSUE,first:20,after:$cursor) {
            ${nextPageFields} nodes {
              ... on Issue { ${issueFields} body createdAt }
              ... on PullRequest { ${pullFields} body createdAt }
            }
          }
        }`,
        variables,
        signal,
      );
      const page = connection(data.search);
      return {
        repository: nameWithOwner,
        viewer: identity.viewer,
        items: (
          await this.items(page.nodes, identity, signal, true, true)
        ).filter((item) => item.comments?.length),
        cursor: page.cursor,
        notice:
          "Direct @mentions with no later comment or submitted review from you in the discussion. Includes closed issues and PRs; team mentions are excluded. Search indexing may delay results.",
      };
    }
    const field = section === "issues" ? "issues" : "pullRequests";
    const fields = section === "issues" ? issueFields : pullFields;
    const data = await this.graphql(
      identity,
      `query($owner:String!,$name:String!,$cursor:String) {
      repository(owner:$owner,name:$name) {
        ${field}(first:20,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) {
          ${nextPageFields} nodes { ${fields} }
        }
      }
    }`,
      variables,
      signal,
    );
    const page = connection(record(data.repository)[field]);
    return {
      repository: nameWithOwner,
      viewer: identity.viewer,
      items: await this.items(page.nodes, identity, signal, false),
      cursor: page.cursor,
      notice: "Open discussions, most recently updated first.",
    };
  }

  private async graphql(
    identity: Identity,
    query: string,
    variables: Record<string, string | boolean>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const args = [
      "api",
      "--hostname",
      identity.host,
      "graphql",
      "-f",
      `query=${query}`,
    ];
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`);
    }
    const response = record(
      JSON.parse(await this.run("gh", args, this.cwd, signal)),
    );
    if (response.errors !== undefined) {
      throw new Error(
        `GitHub GraphQL error: ${JSON.stringify(response.errors)}`,
      );
    }
    return record(response.data);
  }

  private async history(
    initial: unknown,
    nodeId: string,
    nodeType: string,
    field: string,
    fields: string,
    identity: Identity,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    let page = connection(initial, true);
    const nodes = [...page.nodes];
    const seen = new Set<string>();
    while (page.cursor) {
      signal.throwIfAborted();
      if (seen.has(page.cursor)) {
        throw new Error("GitHub returned a repeated history cursor.");
      }
      seen.add(page.cursor);
      const data = await this.graphql(
        identity,
        `query($id:ID!,$before:String!) {
        node(id:$id) { ... on ${nodeType} {
          ${field}(last:50,before:$before) { ${pageFields} nodes { ${fields} } }
        } }
      }`,
        { id: nodeId, before: page.cursor },
        signal,
      );
      page = connection(record(data.node)[field], true);
      nodes.push(...page.nodes);
    }
    return nodes;
  }

  private async items(
    nodes: Record<string, unknown>[],
    identity: Identity,
    signal: AbortSignal,
    includeComments: boolean,
    pendingMentions = false,
  ): Promise<GitHubItem[]> {
    const result: GitHubItem[] = [];
    for (let offset = 0; offset < nodes.length; offset += 4) {
      result.push(
        ...(await Promise.all(
          nodes.slice(offset, offset + 4).map(async (node) => {
            const id = text(node.id);
            const isPull = node.reviews !== undefined;
            const comments = await this.history(
              node.comments,
              id,
              isPull ? "PullRequest" : "Issue",
              "comments",
              commentFields,
              identity,
              signal,
            );
            if (isPull) {
              const reviews = await this.history(
                node.reviews,
                id,
                "PullRequest",
                "reviews",
                reviewFields,
                identity,
                signal,
              );
              for (const review of reviews) {
                if (review.submittedAt === null) continue;
                comments.push({
                  ...review,
                  createdAt: review.submittedAt,
                  body: text(review.body) || `Review: ${text(review.state)}`,
                });
                comments.push(
                  ...(await this.history(
                    review.comments,
                    text(review.id),
                    "PullRequestReview",
                    "comments",
                    commentFields,
                    identity,
                    signal,
                  )),
                );
              }
            }
            const events: GitHubComment[] = [
              ...new Map(
                comments.map((comment) => {
                  const login = author(comment.author);
                  const event = {
                    id: text(comment.id),
                    author: login,
                    mine: login.toLowerCase() === identity.viewer.toLowerCase(),
                    body: text(comment.body),
                    date: date(comment.createdAt),
                    url: url(comment.url),
                  };
                  return [event.id, event] as const;
                }),
              ).values(),
            ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
            const own = events.filter((event) => event.mine);
            const last = own[0];
            const after = (event: GitHubComment): boolean =>
              Boolean(
                last &&
                !event.mine &&
                Date.parse(event.date) > Date.parse(last.date),
              );
            const mine =
              author(node.author).toLowerCase() ===
              identity.viewer.toLowerCase();
            let displayed = events.filter(
              (event) => event.mine || after(event),
            );
            if (pendingMentions) {
              const candidates = [...events];
              if (!mine) {
                candidates.push({
                  id,
                  author: author(node.author),
                  mine: false,
                  body: text(node.body),
                  date: date(node.createdAt),
                  url: url(node.url),
                });
              }
              displayed = candidates
                .filter(
                  (event) =>
                    !event.mine &&
                    (!last || Date.parse(event.date) > Date.parse(last.date)) &&
                    [
                      ...event.body.matchAll(
                        /(?:^|[^\w@/])@([a-z\d](?:[a-z\d-]*[a-z\d])?)(?![\w/-])/gi,
                      ),
                    ].some(
                      (match) =>
                        match[1]!.toLowerCase() ===
                        identity.viewer.toLowerCase(),
                    ),
                )
                .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
            }
            if (typeof node.number !== "number") {
              throw new Error("Invalid GitHub issue/PR number.");
            }
            return {
              id,
              title: `#${node.number} ${text(node.title)}`,
              url: url(node.url),
              author: author(node.author),
              date:
                includeComments && displayed[0]
                  ? displayed[0].date
                  : date(node.updatedAt),
              mine,
              replied: own.length > 0,
              afterMe: events.some(after),
              comments: includeComments ? displayed : undefined,
            };
          }),
        )),
      );
    }
    return result.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  }

  private async commits(signal: AbortSignal): Promise<GitHubPage> {
    const [log, remotes] = await Promise.all([
      this.run(
        "git",
        ["log", "-n", "30", "--format=%H%x00%an%x00%aI%x00%s%x00"],
        this.cwd,
        signal,
      ),
      this.run("git", ["remote", "-v"], this.cwd, signal),
    ]);
    const fetches = remotes
      .split(/\r?\n/)
      .filter((line) => line.endsWith("(fetch)"));
    const remote = (
      fetches.find((line) => line.startsWith("origin\t")) ?? fetches[0]
    )?.split(/\s+/)[1];
    let github: string | undefined;
    if (remote) {
      const normalized = remote.replace(/^git@([^:]+):/, "https://$1/");
      const parsed = URL.canParse(normalized) ? new URL(normalized) : undefined;
      if (parsed) {
        const path = parsed.pathname
          .replace(/\.git\/?$/, "")
          .replace(/\/$/, "");
        if (
          ["github.com", process.env.GH_HOST].includes(parsed.hostname) &&
          /^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(path)
        ) {
          github = `https://${parsed.hostname}${path}`;
        }
      }
    }
    const fields = log.split("\0");
    const items: GitHubItem[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const hash = fields[index]!.trim();
      if (!/^[a-f0-9]{40,64}$/.test(hash)) {
        throw new Error("Invalid Git commit hash.");
      }
      items.push({
        id: hash,
        title: `${hash.slice(0, 8)} ${fields[index + 3]!}`,
        author: fields[index + 1]!,
        date: date(fields[index + 2]),
        url: github ? `${github}/commit/${hash}` : undefined,
        mine: false,
        replied: false,
        afterMe: false,
      });
    }
    return {
      repository: github
        ? new URL(github).pathname.slice(1)
        : basename(this.cwd),
      items: items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
      notice: `Latest 30 commits on the current local branch.${github ? "" : " No GitHub remote detected; commit links are unavailable."}`,
    };
  }
}
