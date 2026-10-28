import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import type { ApplicationMessage, ApplicationState } from "../src/application";
import { renderApplication, renderMarkdown, renderText } from "../src/render";
import type { GitHubUpdate, GitHubPage } from "../src/github";

async function setup(t: TestContext) {
  const posted: ApplicationMessage[] = [];
  const dom = new JSDOM(
    renderApplication({
      cspSource: "https://webview.invalid",
      scriptUri: "https://webview.invalid/webview.js",
      styleUri: "https://webview.invalid/app.css",
    }),
    { runScripts: "outside-only" },
  );
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: ApplicationMessage) =>
        posted.push(structuredClone(message)),
    }),
  });
  const scriptPath = join(__dirname, "../src/webview.js");
  new Script(await readFile(scriptPath, "utf8"), {
    filename: scriptPath,
  }).runInContext(dom.getInternalVMContext());
  const publish = (state: ApplicationState): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "state",
          state: structuredClone({
            ...state,
            messages: state.messages.map((message) => ({
              ...message,
              html:
                message.role === "assistant" || message.role === "reasoning"
                  ? renderMarkdown(message.content)
                  : renderText(message.content),
            })),
          }),
        },
      }),
    );
  };
  const state: ApplicationState = {
    root: "/projects",
    draft: "",
    repositories: [
      { id: "alpha", path: "/projects/alpha", name: "Alpha", status: "idle" },
      { id: "beta", path: "/projects/beta", name: "Beta", status: "idle" },
    ],
    messages: [],
    permissions: [],
    questions: [],
  };
  const document = dom.window.document;
  const publishGitHub = (update: GitHubUpdate): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: structuredClone(update),
      }),
    );
  };
  return { dom, document, posted, publish, publishGitHub, state };
}

test("transcript selections survive state updates and streamed Markdown without intercepting native copy", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.messages = [
    { role: "assistant", content: "Select **this text** to copy." },
  ];
  publish(state);
  const selection = dom.window.getSelection()!;
  const selected = document.querySelector(".message strong")!.firstChild!;
  selection.setBaseAndExtent(selected, 9, selected, 0);
  assert.equal(selection.toString(), "this text");

  publish(state);
  assert.equal(selection.toString(), "this text");
  assert.equal(selection.anchorOffset, 9);
  assert.equal(selection.getRangeAt(0).startContainer, selection.focusNode);
  assert.equal(selection.getRangeAt(0).endContainer, selection.anchorNode);

  state.messages[0]!.content += "\n\nMore streamed text.";
  state.messages.push({ role: "tool", content: "echo done" });
  publish(state);
  assert.equal(selection.toString(), "this text");

  const content = document.querySelector(".message .content")!;
  for (const key of ["c", "C"]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      ctrlKey: key === "c",
      metaKey: key === "C",
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  const menu = new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  content.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
  assert.equal(selection.toString(), "this text");

  state.activeId = "beta";
  state.messages = [{ role: "assistant", content: "Another conversation." }];
  publish(state);
  assert.equal(selection.toString(), "");
});

test("copy selections can span messages and clamp to shortened streaming content", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.messages = [
    { role: "user", content: "First message" },
    { role: "tool", content: "Second message" },
  ];
  publish(state);
  const selection = dom.window.getSelection()!;
  const contents = document.querySelectorAll(".message .content");
  selection.setBaseAndExtent(
    contents[0]!.firstChild!,
    6,
    contents[1]!.firstChild!,
    6,
  );
  const text = selection.toString();
  publish(state);
  assert.equal(selection.toString(), text);

  state.messages[1]!.content = "End";
  publish(state);
  assert.equal(selection.focusNode?.textContent, "End");
  assert.equal(selection.focusOffset, 3);

  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  question.value = "Editable draft";
  question.focus();
  question.setSelectionRange(0, 8);
  const paste = new dom.window.KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  question.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  publish(state);
  assert.equal(document.activeElement, question);
  assert.equal(question.selectionStart, 0);
  assert.equal(question.selectionEnd, 8);
});

test("the activity sidebar shows viewer flags, preserves cached content during streaming, and opens GitHub links", async (t) => {
  const { dom, document, posted, publish, publishGitHub, state } =
    await setup(t);
  state.activeId = "alpha";
  publish(state);
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "issues",
    cursor: undefined,
  });
  const page: GitHubPage = {
    repository: "acme/project",
    viewer: "Ada",
    cursor: "next",
    items: [
      {
        id: "one",
        title: "#1 <script>Issue</script>",
        author: "Ada",
        date: "2026-01-01T12:00:00Z",
        url: "https://github.com/acme/project/issues/1",
        mine: true,
        replied: true,
        afterMe: true,
      },
    ],
  };
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: false,
    page,
  });
  const card = document.querySelector(".github-item");
  assert.ok(card?.classList.contains("github-mine"));
  assert.deepEqual(
    [...document.querySelectorAll(".github-badge")].map(
      (badge) => badge.textContent,
    ),
    ["Yours", "Replied", "After you"],
  );
  assert.equal(document.querySelector("#github-items script"), null);
  const title = document.querySelector<HTMLAnchorElement>("#github-items h3 a");
  assert.ok(title);
  title.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(posted.at(-1), {
    type: "openExternal",
    url: "https://github.com/acme/project/issues/1",
  });
  state.messages = [{ role: "assistant", content: "Streaming response" }];
  const count = posted.length;
  publish(state);
  assert.equal(posted.length, count);
  assert.equal(document.querySelector(".github-item"), card);
  document.querySelector<HTMLButtonElement>("#github-more")?.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "issues",
    cursor: "next",
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: true,
    page: {
      ...page,
      cursor: undefined,
      items: [
        ...page.items,
        { ...page.items[0]!, id: "two", title: "#2 Another" },
      ],
    },
  });
  assert.equal(document.querySelectorAll(".github-item").length, 2);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#github-more")?.hidden,
    true,
  );
  state.activeId = "beta";
  publish(state);
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "beta",
    section: "issues",
    cursor: undefined,
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: false,
    page,
  });
  assert.equal(document.querySelectorAll(".github-item").length, 0);
  const before = posted.length;
  state.activeId = "alpha";
  publish(state);
  assert.equal(posted.length, before);
  assert.equal(document.querySelectorAll(".github-item").length, 1);
  document.querySelector<HTMLButtonElement>("#github-refresh")?.click();
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "error",
    append: false,
    error: "Run gh auth login",
  });
  assert.match(
    document.getElementById("github-error")?.textContent ?? "",
    /gh auth login/,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>("#github-refresh")?.disabled,
    false,
  );
  assert.equal(document.getElementById("error")?.hidden, true);
});

test("sidebar tabs request separate feeds and safely display comments and commit permalinks", async (t) => {
  const { dom, document, posted, publish, publishGitHub, state } =
    await setup(t);
  state.activeId = "alpha";
  publish(state);
  for (const section of ["reviews", "commits", "comments"] as const) {
    document
      .querySelector<HTMLButtonElement>(
        `#github-tabs [data-section="${section}"]`,
      )
      ?.click();
    assert.deepEqual(posted.at(-1), {
      type: "github",
      id: "alpha",
      section,
      cursor: undefined,
    });
    const url =
      section === "commits"
        ? "https://github.com/acme/project/commit/abc123"
        : "https://github.com/acme/project/pull/1";
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: false,
      page: {
        repository: "acme/project",
        items: [
          {
            id: "entry",
            title: section,
            author: "Ada",
            date: "2026-01-01T12:00:00Z",
            url,
            mine: false,
            replied: false,
            afterMe: false,
            comments:
              section === "comments"
                ? [
                    {
                      id: "own",
                      author: "Ada",
                      mine: true,
                      body: "<script>My comment</script>",
                      date: "2026-01-01T12:00:00Z",
                      url: `${url}#comment`,
                    },
                  ]
                : undefined,
          },
        ],
      },
    });
    const anchor =
      document.querySelector<HTMLAnchorElement>("#github-items h3 a");
    assert.ok(anchor);
    anchor.dispatchEvent(
      new dom.window.MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepEqual(posted.at(-1), { type: "openExternal", url });
    if (section === "comments") {
      assert.equal(document.querySelector("#github-items script"), null);
      assert.match(
        document.querySelector(".github-comment-body")?.textContent ?? "",
        /<script>My comment<\/script>/,
      );
      document.querySelector<HTMLAnchorElement>(".github-comment a")?.click();
      assert.deepEqual(posted.at(-1), {
        type: "openExternal",
        url: `${url}#comment`,
      });
    }
  }
  const before = posted.length;
  document
    .querySelector<HTMLButtonElement>('#github-tabs [data-section="commits"]')
    ?.click();
  assert.equal(posted.length, before);
  assert.equal(
    document.querySelectorAll("#github-tabs [aria-pressed=true]").length,
    1,
  );
});

test("all sidebar feeds remain newest-first after pagination and duplicate updates", async (t) => {
  const { document, publish, publishGitHub, state } = await setup(t);
  state.activeId = "alpha";
  publish(state);
  const item = (id: string, date: string) => ({
    id,
    title: id,
    date,
    author: "Ada",
    mine: false,
    replied: false,
    afterMe: false,
  });
  const titles = (): (string | null)[] =>
    [...document.querySelectorAll(".github-item h3")].map(
      (heading) => heading.textContent,
    );
  for (const section of ["issues", "reviews", "comments", "commits"] as const) {
    document
      .querySelector<HTMLButtonElement>(
        `#github-tabs [data-section="${section}"]`,
      )
      ?.click();
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: false,
      page: {
        repository: "acme/project",
        cursor: "next",
        items: [
          item("older", "2026-01-03T01:00:00+02:00"),
          item("newer", "2026-01-03T00:00:00Z"),
        ],
      },
    });
    assert.deepEqual(titles(), ["newer", "older"]);
    document.querySelector<HTMLButtonElement>("#github-more")?.click();
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: true,
      page: {
        repository: "acme/project",
        items: [
          item("oldest", "2026-01-01T12:00:00Z"),
          item("older", "2026-01-05T12:00:00Z"),
        ],
      },
    });
    assert.deepEqual(titles(), ["older", "newer", "oldest"]);
  }
});

test("the tab has activity navigation and starts no session until a repository is clicked", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  assert.equal(
    document.querySelectorAll(".application > aside, .application > section")
      .length,
    3,
  );
  assert.equal(document.querySelectorAll('[role="separator"]').length, 2);
  assert.deepEqual(
    [...document.querySelectorAll("#github-tabs button")].map(
      (button) => button.textContent,
    ),
    ["Issues", "Reviews", "Commits", "Comments"],
  );
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  publish(state);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>("#question")?.disabled,
    true,
  );
  document.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted, [
    { type: "ready" },
    { type: "select", id: "alpha" },
  ]);
});

test("the compact conversation heading groups its title, session status and PostMortem button", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "saved";
  publish(state);
  const heading = document.querySelector(".chat-heading");
  assert.ok(heading);
  assert.deepEqual(
    [...heading.children].map((element) => element.id || element.className),
    ["active-repository", "session-activity", "postmortem"],
  );
  assert.equal(
    heading.querySelector("#active-repository")?.textContent,
    "Alpha",
  );
  assert.match(
    heading.querySelector("#session-status")?.textContent ?? "",
    /Session closed/,
  );
  assert.equal(document.querySelector(".chat-header h1"), null);
});

test("PostMortem renders a safe evidence-linked table independently of transcript filters and exports its JSON", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.messages = [
    { role: "user", content: "Produce the feature" },
    {
      role: "tool",
      content: "npm test\n<script>not HTML</script>",
      details: '{"command":"npm test"}',
    },
    { role: "assistant", content: "Committed abcdef0123456789" },
  ];
  publish(state);
  const button = document.querySelector<HTMLButtonElement>("#postmortem");
  assert.ok(button);
  button.click();
  button.click();
  assert.equal(
    posted.filter((message) => message.type === "postmortem").length,
    1,
  );
  assert.deepEqual(posted.at(-1), { type: "postmortem", id: "alpha" });
  state.postMortemBusy = true;
  state.repositories[0]!.status = "stopping";
  publish(state);
  assert.equal(button.disabled, true);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#cancel")?.disabled,
    false,
  );
  assert.match(
    document.getElementById("postmortem-status")?.textContent ?? "",
    /Analysing all/,
  );
  state.postMortemBusy = false;
  state.repositories[0]!.status = "ready";
  state.postMortem = {
    version: 1,
    repository: { id: "alpha", name: "Alpha", path: "/projects/alpha" },
    generatedAt: "2026-01-01T12:00:00Z",
    sourceCount: 3,
    sourceHash: "a".repeat(64),
    rows: [
      {
        phase: "Implementation",
        objective: "Produce the feature",
        production: "<img src=x onerror=alert(1)>",
        filesAndCommits: "src/feature.ts; abcdef0123456789",
        validation: "npm test",
        errors: "Not recorded",
        firstMessage: 1,
        lastMessage: 3,
      },
    ],
  };
  publish(state);
  assert.equal(
    document.querySelectorAll("#postmortem-report tbody tr").length,
    1,
  );
  assert.equal(
    document.querySelector("#postmortem-report img, #postmortem-report script"),
    null,
  );
  const details = document.querySelector<HTMLDetailsElement>(
    "#postmortem-report details",
  );
  assert.ok(details);
  assert.equal(details.querySelector("pre"), null);
  details.open = true;
  details.dispatchEvent(new dom.window.Event("toggle"));
  assert.match(details.textContent ?? "", /npm test/);
  assert.match(details.textContent ?? "", /<script>not HTML<\/script>/);
  const cells = document.querySelector("#postmortem-table table");
  publish(state);
  assert.equal(document.querySelector("#postmortem-table table"), cells);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="messages"]',
    )
    ?.click();
  assert.equal(document.getElementById("postmortem-report")?.hidden, false);
  document.querySelector<HTMLButtonElement>("#export-postmortem")?.click();
  assert.deepEqual(posted.at(-1), { type: "export-postmortem", id: "alpha" });
  state.messages.push({ role: "user", content: "Later work" });
  publish(state);
  assert.match(
    document.getElementById("postmortem-status")?.textContent ?? "",
    /New exchanges are not included/,
  );
  state.activeId = "beta";
  state.messages = [];
  state.postMortem = undefined;
  publish(state);
  assert.equal(document.getElementById("postmortem-report")?.hidden, true);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#export-postmortem")?.disabled,
    true,
  );
});

test("the first repository box groups active sessions and moves closed sessions back without duplicates", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  const started = document.getElementById("started-repositories");
  const others = document.getElementById("other-repositories");
  assert.ok(started && others);
  const ids = (group: HTMLElement): string[] =>
    [...group.querySelectorAll<HTMLButtonElement>(".repository")].map(
      (button) => button.dataset.repositoryId!,
    );
  publish(state);
  assert.equal(
    document.querySelector(".repository-group h3")?.textContent,
    "Active sessions",
  );
  assert.deepEqual(ids(started), []);
  assert.match(started.textContent ?? "", /No active session/);
  assert.deepEqual(ids(others), ["alpha", "beta"]);
  for (const status of ["starting", "ready", "busy", "stopping"] as const) {
    state.repositories[1]!.status = status;
    publish(state);
    assert.deepEqual(ids(started), ["beta"]);
    assert.deepEqual(ids(others), ["alpha"]);
    assert.equal(document.querySelectorAll(".repository").length, 2);
  }
  state.repositories[1]!.status = "ready";
  publish(state);
  started.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted.at(-1), { type: "select", id: "beta" });
  started.querySelector<HTMLButtonElement>(".repository")?.dispatchEvent(
    new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    }),
  );
  document
    .querySelector<HTMLButtonElement>('[data-action="close-session"]')
    ?.click();
  assert.deepEqual(posted.at(-1), { type: "close-session", id: "beta" });
  for (const status of ["saved", "error", "idle"] as const) {
    state.repositories[1]!.status = status;
    publish(state);
    assert.deepEqual(ids(started), []);
    assert.deepEqual(ids(others), ["alpha", "beta"]);
  }
  state.repositories.forEach((repository) => {
    repository.status = "ready";
  });
  publish(state);
  assert.deepEqual(ids(started), ["alpha", "beta"]);
  assert.deepEqual(ids(others), []);
  assert.match(
    others.textContent ?? "",
    /All repositories have an active session/,
  );
  state.repositories = [];
  publish(state);
  assert.match(started.textContent ?? "", /No active session/);
  assert.match(others.textContent ?? "", /No direct child repository/);
  assert.equal(document.querySelectorAll(".repository").length, 0);
});

test("right-click menus manage the clicked repository and confirm irreversible deletion without popups", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.repositories.forEach((entry) => {
    entry.status = "ready";
    entry.sessionCount = 2;
  });
  state.activeId = "alpha";
  publish(state);
  const menu = document.getElementById("repository-menu");
  assert.ok(menu);
  const open = (id: string): HTMLButtonElement => {
    const repository = [
      ...document.querySelectorAll<HTMLButtonElement>(".repository"),
    ].find((button) => button.dataset.repositoryId === id);
    assert.ok(repository);
    const event = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    repository.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(menu.hidden, false);
    return repository;
  };
  const action = (name: string): HTMLButtonElement => {
    const button = menu.querySelector<HTMLButtonElement>(
      `[data-action="${name}"]`,
    );
    assert.ok(button);
    return button;
  };
  open("beta");
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  const close = action("close-session");
  state.repositories[0]!.status = "busy";
  publish(state);
  assert.equal(document.activeElement, close);
  close.click();
  assert.deepEqual(posted.at(-1), { type: "close-session", id: "beta" });
  open("alpha");
  action("new-session").click();
  assert.deepEqual(posted.at(-1), { type: "new-session", id: "alpha" });
  open("beta");
  const count = posted.length;
  action("delete-last-session").click();
  assert.equal(menu.hidden, false);
  assert.equal(posted.length, count);
  assert.match(menu.textContent ?? "", /latest session.*Beta.*Copilot history/);
  action("delete-last-session").click();
  assert.deepEqual(posted.at(-1), { type: "delete-last-session", id: "beta" });
  open("beta");
  action("delete-all-sessions").click();
  menu.querySelector<HTMLButtonElement>("button:last-child")?.click();
  assert.equal(posted.length, count + 1);
  const beta = open("beta");
  menu.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, beta);
  beta.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true }),
  );
  assert.equal(menu.hidden, false);
  menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End" }));
  assert.equal(document.activeElement, action("delete-all-sessions"));
  action("delete-all-sessions").click();
  action("delete-all-sessions").click();
  assert.deepEqual(posted.at(-1), { type: "delete-all-sessions", id: "beta" });
  state.repositories[1]!.sessionCount = 0;
  state.repositories[1]!.status = "idle";
  publish(state);
  open("beta");
  assert.equal(action("close-session").disabled, true);
  assert.equal(action("delete-last-session").disabled, true);
  assert.equal(action("new-session").disabled, false);
  document.getElementById("root")?.click();
  assert.equal(menu.hidden, true);
});

test("fresh and restored sessions replace cached drafts even when the repository stays selected", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.repositories[0]!.generation = 0;
  publish(state);
  const input = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(input);
  input.value = "Old draft";
  state.repositories[0]!.generation = 1;
  state.draft = "";
  publish(state);
  assert.equal(input.value, "");
  input.value = "New draft";
  state.activeId = "beta";
  publish(state);
  state.repositories[0]!.generation = 2;
  publish(state);
  state.activeId = "alpha";
  state.draft = "Restored older draft";
  publish(state);
  assert.equal(input.value, "Restored older draft");
});

test("activity icons follow startup and generation independently for each repository", async (t) => {
  const { document, publish, state } = await setup(t);
  const icon = document.getElementById("activity-icon");
  assert.ok(icon);
  state.activeId = "alpha";
  state.repositories[0]!.status = "starting";
  state.repositories[1]!.status = "busy";
  publish(state);
  assert.equal(icon.hidden, false);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 2);
  assert.equal(
    document.getElementById("chat-panel")?.getAttribute("aria-busy"),
    "true",
  );
  state.repositories[0]!.status = "ready";
  publish(state);
  assert.equal(icon.hidden, true);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 1);
  state.repositories[1]!.status = "error";
  state.activeId = "beta";
  publish(state);
  assert.equal(icon.hidden, true);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 0);
});

test("repository indicators distinguish an open session from work independently of selection", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "beta";
  const alpha = state.repositories[0]!;
  const repository = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-repository-id="alpha"]',
    );
    assert.ok(button);
    return button;
  };
  alpha.status = "ready";
  publish(state);
  assert.equal(repository().getAttribute("aria-pressed"), "false");
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), false);
  assert.ok(repository().querySelector(".session-indicator"));
  assert.match(repository().textContent ?? "", /Session open - ready/);
  alpha.status = "busy";
  publish(state);
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), true);
  assert.equal(repository().getAttribute("aria-busy"), "true");
  assert.ok(repository().querySelector(".spinner"));
  assert.equal(repository().querySelector(".session-indicator"), null);
  assert.match(repository().textContent ?? "", /Copilot is working/);
  assert.equal(
    document.querySelector('[data-repository-id="beta"]')?.className,
    "repository",
  );
  state.activeId = "alpha";
  alpha.status = "ready";
  publish(state);
  assert.equal(repository().getAttribute("aria-pressed"), "true");
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), false);
  for (const status of ["saved", "error", "idle"] as const) {
    alpha.status = status;
    publish(state);
    assert.equal(repository().classList.contains("session-open"), false);
    assert.equal(repository().classList.contains("session-working"), false);
    assert.equal(repository().getAttribute("aria-busy"), "false");
    assert.equal(
      repository().querySelector(".session-indicator, .spinner"),
      null,
    );
  }
});

test("both panel dividers resize with pointer and keyboard while preserving positive panel widths", async (t) => {
  const { dom, document } = await setup(t);
  const layout = document.querySelector<HTMLElement>(".application");
  const left = document.getElementById("left-divider");
  const right = document.getElementById("right-divider");
  assert.ok(layout && left && right);
  // jsdom has no layout engine; supply only the container's measured width.
  Object.defineProperty(layout, "clientWidth", { value: 1012 });
  const pointer = (
    target: EventTarget,
    type: string,
    x: number,
    id = 1,
  ): void => {
    const event = new dom.window.MouseEvent(type, {
      clientX: x,
      button: 0,
      bubbles: true,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    target.dispatchEvent(event);
  };
  const widths = (): number[] =>
    layout.style.gridTemplateColumns
      .split(" ")
      .filter((part) => part.endsWith("fr"))
      .map(parseFloat);
  pointer(left, "pointerdown", 100);
  pointer(document, "pointermove", 180, 2);
  assert.equal(layout.style.gridTemplateColumns, "");
  pointer(document, "pointermove", 180);
  const afterLeft = widths();
  assert.ok(afterLeft[0]! > 0.2);
  assert.equal(document.body.classList.contains("resizing"), true);
  pointer(document, "pointerup", 180);
  pointer(document, "pointermove", 250);
  assert.deepEqual(widths(), afterLeft);
  assert.equal(document.body.classList.contains("resizing"), false);
  right.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      cancelable: true,
    }),
  );
  assert.ok(widths()[2]! > afterLeft[2]!);
  pointer(right, "pointerdown", 800);
  pointer(document, "pointermove", 100_000);
  assert.ok(widths().every((width) => width > 0));
  assert.ok(
    Math.abs(widths().reduce((sum, width) => sum + width, 0) - 1) < 1e-10,
  );
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(document.body.classList.contains("resizing"), false);
  assert.notEqual(left.getAttribute("aria-valuenow"), null);
});

test("chat sends to the selected repository, blocks double submission and renders safe HTML equations", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  const alpha = state.repositories[0];
  assert.ok(alpha);
  alpha.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const form = document.getElementById("composer");
  assert.ok(question && form);
  question.value = "Explain $x^2$.";
  question.dispatchEvent(new dom.window.Event("input"));
  for (let attempt = 0; attempt < 2; attempt++) {
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  }
  assert.deepEqual(
    posted.filter((message) => message.type === "send"),
    [{ type: "send", id: "alpha", question: "Explain $x^2$.", parallel: true }],
  );
  assert.equal(document.getElementById("activity-icon")?.hidden, false);
  alpha.status = "busy";
  state.messages = [{ role: "user", content: "<script>untrusted</script>" }];
  publish(state);
  document.querySelector<HTMLButtonElement>("#cancel")?.click();
  assert.deepEqual(posted.at(-1), { type: "cancel", id: "alpha" });
  alpha.status = "ready";
  state.messages.push({
    role: "assistant",
    content:
      "## Equation\n\n$$x^2=4$$\n\n[Link](https://example.com)\n<script>bad()</script>",
  });
  publish(state);
  assert.equal(document.getElementById("activity-icon")?.hidden, true);
  assert.ok(document.querySelector("#messages h2"));
  assert.ok(document.querySelector("#messages math"));
  assert.equal(document.querySelector("#messages script, #messages img"), null);
  assert.match(
    document.querySelector(".message.user")?.textContent ?? "",
    /<script>untrusted/,
  );
});

test("Enter sends once, Shift+Enter inserts a newline, and IME composition is not submitted", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  question.value = "First line\nSecond line";
  for (const options of [
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
      ...options,
    });
    question.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(posted.filter((message) => message.type === "send").length, 0);
  const enter = (): KeyboardEvent =>
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  const event = enter();
  question.dispatchEvent(event);
  question.dispatchEvent(enter());
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    posted.filter((message) => message.type === "send"),
    [
      {
        type: "send",
        id: "alpha",
        question: "First line\nSecond line",
        parallel: true,
      },
    ],
  );
  state.repositories[0]!.status = "busy";
  publish(state);
  question.value = "Ask while busy";
  question.dispatchEvent(enter());
  assert.equal(posted.filter((message) => message.type === "send").length, 2);
  assert.deepEqual(posted.at(-1), {
    type: "send",
    id: "alpha",
    question: "Ask while busy",
    parallel: true,
  });
  publish(state);
  const parallel = document.querySelector<HTMLButtonElement>("#parallel");
  assert.ok(parallel);
  parallel.click();
  assert.equal(parallel.getAttribute("aria-pressed"), "false");
  assert.equal(parallel.textContent, "Parallel OFF");
  question.value = "Wait until the end";
  question.dispatchEvent(enter());
  assert.deepEqual(posted.at(-1), {
    type: "send",
    id: "alpha",
    question: "Wait until the end",
    parallel: false,
  });
  publish(state);
  parallel.click();
  assert.equal(parallel.getAttribute("aria-pressed"), "true");
  assert.equal(parallel.textContent, "Parallel ON");
});

test("clicking rendered URLs asks the extension to open the browser without webview navigation", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.messages = [
    {
      role: "assistant",
      content:
        "[**GitHub**](https://github.com/xadupre/arranged-agents)\n\nhttps://example.com",
    },
  ];
  publish(state);
  const link = document.querySelector("#messages a strong");
  assert.ok(link);
  const click = new dom.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(posted.at(-1), {
    type: "openExternal",
    url: "https://github.com/xadupre/arranged-agents",
  });
  const middle = new dom.window.MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  link.dispatchEvent(middle);
  assert.equal(middle.defaultPrevented, true);
  state.messages.push({
    role: "output",
    content: "Result: https://example.org/output\n<script>untrusted</script>",
  });
  publish(state);
  assert.equal(
    document.querySelector(".message.output a")?.getAttribute("href"),
    "https://example.org/output",
  );
  assert.equal(document.querySelector(".message.output script"), null);
});

test("the default transcript is concise and optional filters reveal information without changing history", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  state.messages = [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "reasoning", content: "Runtime reasoning" },
    {
      role: "tool",
      content: "gh pr list\n<script>not HTML</script>",
      title: "Tool: bash",
      details: '{"command":"gh pr list"}',
    },
    { role: "output", content: "stdout\nstderr" },
    { role: "system", content: '{"status":"running"}' },
  ];
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
  assert.equal(
    document.querySelectorAll("#information-filters input:checked").length,
    2,
  );
  assert.equal(document.querySelector("details:not([hidden])"), null);
  for (const filter of document.querySelectorAll<HTMLInputElement>(
    "#information-filters input:not(:checked)",
  )) {
    filter.click();
  }
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 6);
  assert.equal(document.querySelector(".message.tool script"), null);
  assert.match(
    document.querySelector(".message.tool pre")?.textContent ?? "",
    /<script>not HTML/,
  );
  assert.equal(
    document.querySelector(".message.output pre")?.textContent,
    "stdout\nstderr",
  );
  const details = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.ok(details);
  details.open = true;
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  question.value = "Keep this draft";
  for (const category of [
    "tools",
    "output",
    "reasoning",
    "system",
    "messages",
  ]) {
    const filter = document.querySelector<HTMLInputElement>(
      `#information-filters input[value="${category}"]`,
    );
    assert.ok(filter);
    filter.click();
  }
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 0);
  assert.equal(question.value, "Keep this draft");
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 0);
  assert.equal(
    document.querySelector<HTMLDetailsElement>(".message.tool details")?.open,
    true,
  );
  state.activeId = "beta";
  state.messages = [{ role: "tool", content: "Other repository command" }];
  publish(state);
  assert.equal(
    document.querySelector(".message.tool")?.hasAttribute("hidden"),
    true,
  );
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="tools"]',
    )
    ?.click();
  assert.equal(
    document.querySelector(".message.tool")?.hasAttribute("hidden"),
    false,
  );
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
});

test("Session / events also hides raw event details without hiding tools or output", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.messages = [
    { role: "assistant", content: "Checking the repository." },
    {
      role: "tool",
      content: "gh pr list",
      details: '{"toolCallId":"call-1","command":"gh pr list"}',
    },
    {
      role: "output",
      content: "No pull requests found",
      details: '{"toolCallId":"call-1","success":true}',
    },
    { role: "system", content: "Session ready" },
  ];
  publish(state);
  for (const category of ["output", "system"]) {
    document
      .querySelector<HTMLInputElement>(
        `#information-filters input[value="${category}"]`,
      )
      ?.click();
  }
  const filter = document.querySelector<HTMLInputElement>(
    '#information-filters input[value="system"]',
  );
  const toolDetails = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.ok(filter && toolDetails);
  toolDetails.open = true;
  assert.equal(document.querySelectorAll("details:not([hidden])").length, 2);
  filter.click();
  for (let update = 0; update < 2; update++) {
    assert.equal(document.querySelectorAll("details:not([hidden])").length, 0);
    assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
    assert.equal(
      document.querySelector(".message.tool .content")?.textContent,
      "gh pr list",
    );
    assert.equal(
      document.querySelector(".message.output .content")?.textContent,
      "No pull requests found",
    );
    publish(state);
  }
  filter.click();
  assert.equal(document.querySelectorAll("details:not([hidden])").length, 2);
  const restored = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.equal(restored?.open, true);
  assert.equal(
    restored?.querySelector("pre")?.textContent,
    state.messages[1]!.details,
  );
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 4);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
});

test("inline permission controls remain visible across filters and repository changes without grabbing focus", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const permissions = document.getElementById("permissions");
  assert.ok(question && permissions);
  question.focus();
  assert.equal(permissions.hidden, true);
  state.permissions = [
    {
      id: "alpha-read",
      repositoryId: "alpha",
      kind: "read",
      summary: "Read this file or directory?",
      content: "<script>not executable</script>\nREADME.md",
      details: "<script>not executable</script>\nREADME.md",
    },
    {
      id: "beta-shell",
      repositoryId: "beta",
      kind: "shell",
      summary: "Run this command?",
      content: "gh pr list",
      details: "gh pr list",
    },
  ];
  publish(state);
  assert.equal(document.activeElement, question);
  assert.equal(permissions.hidden, false);
  assert.equal(
    permissions.closest('[aria-live], [role="alert"], [role="dialog"]'),
    null,
  );
  assert.equal(permissions.querySelector("script"), null);
  assert.match(permissions.textContent ?? "", /<script>not executable/);
  assert.match(
    permissions.textContent ?? "",
    /Copilot \(Alpha\): Read this file/,
  );
  assert.match(
    permissions.textContent ?? "",
    /Copilot \(Beta\): Run this command/,
  );
  assert.equal(permissions.querySelector("details:not([hidden])"), null);
  for (const filter of document.querySelectorAll<HTMLInputElement>(
    "#information-filters input",
  )) {
    filter.click();
  }
  assert.equal(permissions.hidden, false);
  const allow = permissions.querySelector<HTMLButtonElement>("button");
  assert.ok(allow);
  allow.focus();
  state.activeId = "beta";
  publish(state);
  assert.equal(document.activeElement, allow);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  allow.click();
  allow.click();
  assert.deepEqual(posted.at(-1), {
    type: "permission",
    id: "alpha-read",
    approve: true,
  });
  assert.equal(
    permissions.querySelectorAll(".permission:first-child button:disabled")
      .length,
    2,
  );
  publish(state);
  assert.equal(allow.disabled, true);
  state.permissions.shift();
  publish(state);
  const reject =
    permissions.querySelector<HTMLButtonElement>("button:last-child");
  assert.ok(reject);
  reject.click();
  assert.deepEqual(posted.at(-1), {
    type: "permission",
    id: "beta-shell",
    approve: false,
  });
  assert.equal(
    posted.filter((message) => message.type === "permission").length,
    2,
  );
  state.permissions = [];
  publish(state);
  assert.equal(permissions.hidden, true);
  assert.equal(permissions.children.length, 0);
});

test("technical tool fragments from saved histories stay hidden and failures remain visible", async (t) => {
  const { document, publish, state } = await setup(t);
  state.messages = [
    {
      role: "tool",
      title: "assistant.tool_call_delta",
      content: '{"inputDelta":"foo"}',
    },
    {
      role: "tool",
      title: "tool.execution_progress",
      content: '{"progress":1}',
    },
    {
      role: "tool",
      title: "Tool: read",
      content: '{"toolCallId":"old","arguments":{"path":"README.md"}}',
    },
    {
      role: "tool",
      title: "bash - completed",
      content: "git status",
      timestamp: "2026-10-28T12:00:00Z",
    },
    { role: "output", content: "Permission denied", error: true },
    {
      role: "output",
      title: "Tool old: failed",
      content: "Previous command failed",
    },
  ];
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
  assert.equal(document.querySelector("#messages time"), null);
  const system = document.querySelector<HTMLInputElement>(
    'input[value="system"]',
  );
  assert.ok(system);
  system.click();
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 6);
  assert.ok(document.querySelector("#messages time"));
  system.click();
  document.querySelector<HTMLInputElement>('input[value="tools"]')?.click();
  assert.deepEqual(
    [...document.querySelectorAll(".message:not([hidden]) .content")].map(
      (content) => content.textContent,
    ),
    ["Permission denied", "Previous command failed"],
  );
});

test("Copilot questions use safe choice buttons and editable answers rather than JSON", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.questions = [
    {
      id: "choice",
      repositoryId: "alpha",
      question: "Which tests?",
      choices: ["Targeted", "All"],
      allowFreeform: false,
    },
    {
      id: "text",
      repositoryId: "beta",
      question: "<script>Which files?</script>",
      choices: ["README"],
      allowFreeform: true,
    },
  ];
  publish(state);
  const cards = document.querySelectorAll<HTMLFormElement>(".agent-question");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.querySelector("textarea"), null);
  assert.equal(document.querySelector("#questions script"), null);
  assert.match(cards[1]?.textContent ?? "", /<script>Which files\?<\/script>/);
  assert.equal(
    document.getElementById("questions")?.closest("[aria-live]"),
    null,
  );
  cards[0]?.querySelector<HTMLButtonElement>("button")?.click();
  assert.deepEqual(posted.at(-1), {
    type: "answer",
    id: "choice",
    answer: "Targeted",
  });
  const input = cards[1]?.querySelector("textarea");
  assert.ok(input);
  input.value = "src/example.ts\nREADME.md";
  input.dispatchEvent(new dom.window.Event("input"));
  input.focus();
  publish(state);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "src/example.ts\nREADME.md");
  for (const options of [{ shiftKey: true }, { isComposing: true }]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
      ...options,
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
  );
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
  );
  assert.deepEqual(
    posted.filter((message) => message.type === "answer"),
    [
      { type: "answer", id: "choice", answer: "Targeted" },
      { type: "answer", id: "text", answer: "src/example.ts\nREADME.md" },
    ],
  );
  state.questions = [
    { id: "cancel", repositoryId: "beta", question: "Continue?" },
  ];
  publish(state);
  document
    .querySelector<HTMLButtonElement>(".agent-question > button:last-child")
    ?.click();
  assert.deepEqual(posted.at(-1), { type: "cancel", id: "beta" });
  state.questions = [];
  publish(state);
  assert.equal(document.getElementById("questions")?.hidden, true);
});

test("repository switching keeps drafts separate and failed submissions remain editable", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.repositories.forEach((repository) => {
    repository.status = "ready";
  });

  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const form = document.getElementById("composer");
  assert.ok(question && form);
  question.value = "Alpha draft";
  state.activeId = "beta";
  publish(state);
  assert.equal(question.value, "");
  question.value = "Beta draft";
  state.activeId = "alpha";
  publish(state);
  assert.equal(question.value, "Alpha draft");
  question.dispatchEvent(new dom.window.Event("input"));
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "error", id: "beta", message: "Other session failed" },
    }),
  );
  assert.equal(question.value, "");
  assert.equal(document.getElementById("error")?.hidden, true);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "error", message: "Session unavailable" },
    }),
  );
  assert.equal(question.value, "Alpha draft");
  assert.equal(document.getElementById("error")?.hidden, false);
  assert.equal(
    document.getElementById("error")?.textContent,
    "Session unavailable",
  );
});

test("saved drafts restore without starting Copilot, edits are persisted and failed resumes offer an explicit fresh session", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.draft = "A draft from the previous window";
  state.repositories[0]!.status = "saved";
  state.repositories[0]!.hasSavedSession = true;
  state.messages = [{ role: "user", content: "An earlier question" }];
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  assert.equal(question.value, state.draft);
  assert.equal(question.disabled, true);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  document.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted.at(-1), { type: "select", id: "alpha" });
  state.repositories[0]!.status = "ready";
  publish(state);
  question.value = "Updated draft";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(posted.at(-1), {
    type: "draft",
    id: "alpha",
    text: "Updated draft",
  });
  state.repositories[0]!.status = "error";
  state.error = "Could not resume";
  publish(state);
  const restart = document.querySelector<HTMLButtonElement>("#restart");
  assert.ok(restart);
  assert.equal(restart.hidden, false);
  restart.click();
  assert.deepEqual(posted.at(-1), { type: "restart", id: "alpha" });
});
