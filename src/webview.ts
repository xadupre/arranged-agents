declare function acquireVsCodeApi(): {
  postMessage(message: import("./application").ApplicationMessage): void;
};

(() => {
  type State = Omit<import("./application").ApplicationState, "messages"> & {
    messages: (import("./application").ChatMessage & { html?: string })[];
  };
  function element<T extends HTMLElement>(
    id: string,
    constructor: new () => T,
  ): T {
    const result = document.getElementById(id);
    if (!(result instanceof constructor)) {
      throw new Error(`Missing application element: ${id}`);
    }
    return result;
  }
  const vscode = acquireVsCodeApi();
  const repositories = element("repositories", HTMLElement);
  const startedRepositories = element("started-repositories", HTMLElement);
  const otherRepositories = element("other-repositories", HTMLElement);
  const messages = element("messages", HTMLElement);
  const messageCards: {
    message: State["messages"][number];
    showEventDetails: boolean;
    article: HTMLElement;
  }[] = [];
  const messageFields = [
    "role",
    "content",
    "html",
    "title",
    "agentId",
    "timestamp",
    "details",
    "error",
  ] as const;
  let repositoriesRenderedKey: string | undefined;
  const permissions = element("permissions", HTMLElement);
  const permissionCards = new Map<string, HTMLElement>();
  const questions = element("questions", HTMLElement);
  const questionCards = new Map<string, HTMLElement>();
  const question = element("question", HTMLTextAreaElement);
  type ImageAttachment = import("./images").ImageAttachment;
  const imageInput = element("images", HTMLInputElement);
  const imagePreviews = element("image-previews", HTMLElement);
  const imageDrafts = new Map<string, ImageAttachment[]>();
  const readingImages = new Set<string>();
  const send = element("send", HTMLButtonElement);
  const parallel = element("parallel", HTMLButtonElement);
  const postMortem = element("postmortem", HTMLButtonElement);
  element("settings", HTMLButtonElement).addEventListener("click", () => {
    vscode.postMessage({ type: "settings" });
  });
  const exportPostMortem = element("export-postmortem", HTMLButtonElement);
  let postMortemRenderedKey: string | undefined;
  const cancel = element("cancel", HTMLButtonElement);
  const restart = element("restart", HTMLButtonElement);
  const error = element("error", HTMLElement);
  const composer = element("composer", HTMLFormElement);
  const filters = element("information-filters", HTMLFieldSetElement);
  const repositoryMenu = element("repository-menu", HTMLElement);
  const githubTabs = element("github-tabs", HTMLElement);
  const githubItems = element("github-items", HTMLElement);
  const githubRefresh = element("github-refresh", HTMLButtonElement);
  const githubMore = element("github-more", HTMLButtonElement);
  type GitHubSection = import("./github").GitHubSection;
  type GitHubPage = import("./github").GitHubPage;
  type GitHubUpdate = import("./github").GitHubUpdate;
  const githubLabels: Record<GitHubSection, string> = {
    issues: "Issues",
    reviews: "Reviews",
    comments: "Comments",
    commits: "Commits",
    mentions: "Mentions",
  };
  let githubSection: GitHubSection = "issues";
  const githubPages = new Map<
    string,
    {
      status: GitHubUpdate["status"];
      page?: GitHubPage;
      error?: string;
    }
  >();
  let githubRenderedKey: string | undefined;
  let githubRenderedPage: object | undefined;
  let menuRepositoryId: string | undefined;
  let menuConfirmation:
    "delete-last-session" | "delete-all-sessions" | undefined;
  const categories: Record<
    import("./application").ChatMessage["role"],
    import("./application").InformationType
  > = {
    user: "messages",
    assistant: "messages",
    reasoning: "reasoning",
    tool: "tools",
    output: "output",
    system: "system",
  };
  const roleLabels = {
    user: "You",
    assistant: "Copilot",
    reasoning: "Reasoning",
    tool: "Tool",
    output: "Output",
    system: "Session",
  };
  const application = document.querySelector<HTMLElement>(".application");
  if (!application) {
    throw new Error("Missing application layout.");
  }
  const layout = application;
  const dividers = [
    element("left-divider", HTMLElement),
    element("right-divider", HTMLElement),
  ];
  let widths = [0.6 / 4.6, 3 / 4.6, 1 / 4.6];
  let drag:
    | { index: number; pointerId: number; x: number; widths: number[] }
    | undefined;

  function resize(index: number, delta: number, initial = widths): void {
    const available = layout.clientWidth - 12;
    if (available <= 0) {
      return;
    }
    const minimums = [48, 240, 140].map(
      (width) => (width / available) * Math.min(1, available / 428),
    );
    const pair = initial[index]! + initial[index + 1]!;
    const minimumScale = Math.min(
      1,
      pair / (minimums[index]! + minimums[index + 1]!),
    );
    const first = Math.max(
      minimums[index]! * minimumScale,
      Math.min(
        pair - minimums[index + 1]! * minimumScale,
        initial[index]! + delta / available,
      ),
    );
    widths = [...initial];
    widths[index] = first;
    widths[index + 1] = pair - first;
    layout.style.gridTemplateColumns = `${widths[0]}fr 6px ${widths[1]}fr 6px ${widths[2]}fr`;
    updateDividers();
  }

  function updateDividers(): void {
    dividers.forEach((divider, index) => {
      const position = index === 0 ? widths[0]! : widths[0]! + widths[1]!;
      divider.setAttribute("aria-valuenow", String(Math.round(position * 100)));
      divider.setAttribute("aria-valuemin", "0");
      divider.setAttribute("aria-valuemax", "100");
    });
  }

  function stopResize(): void {
    drag = undefined;
    document.body.classList.remove("resizing");
    dividers.forEach((divider) => divider.classList.remove("dragging"));
  }

  dividers.forEach((divider, index) => {
    divider.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      drag = {
        index,
        pointerId: event.pointerId,
        x: event.clientX,
        widths: [...widths],
      };
      divider.setPointerCapture?.(event.pointerId);
      document.body.classList.add("resizing");
      divider.classList.add("dragging");
    });
    divider.addEventListener("lostpointercapture", stopResize);
    divider.addEventListener("keydown", (event) => {
      const delta =
        event.key === "ArrowLeft"
          ? -16
          : event.key === "ArrowRight"
            ? 16
            : undefined;
      if (delta !== undefined) {
        event.preventDefault();
        resize(index, delta);
      }
    });
  });
  document.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      resize(drag.index, event.clientX - drag.x, drag.widths);
    }
  });
  for (const type of ["pointerup", "pointercancel"] as const) {
    document.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) {
        stopResize();
      }
    });
  }
  window.addEventListener("blur", stopResize);
  updateDividers();
  let state: State | undefined;
  let pending:
    { id: string; text: string; images?: ImageAttachment[] } | undefined;
  const drafts = new Map<string, string>();
  const statusLabels = {
    idle: "Not started",
    saved: "Session closed - click to resume",
    starting: "Starting Copilot...",
    ready: "Session open - ready",
    busy: "Session open - Copilot is working...",
    error: "Session stopped - click to restart",
    stopping: "Updating sessions...",
  };

  function showError(message = ""): void {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateControls(): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === state?.activeId,
    );
    const ready =
      repository?.status === "ready" || repository?.status === "busy";
    const submitting = pending !== undefined && pending.id === repository?.id;
    question.disabled = !ready || submitting;
    imageInput.disabled =
      !ready || submitting || readingImages.has(repository?.id ?? "");
    send.disabled =
      !ready ||
      submitting ||
      readingImages.has(repository?.id ?? "") ||
      (!question.value.trim() &&
        !imageDrafts.get(repository?.id ?? "")?.length);
    postMortem.disabled =
      !repository ||
      submitting ||
      !state?.messages.length ||
      ["starting", "busy", "stopping"].includes(repository.status);
    postMortem.textContent = state?.postMortemBusy
      ? "Generating PostMortem..."
      : "PostMortem";
    cancel.disabled =
      !state?.postMortemBusy &&
      !["starting", "busy"].includes(repository?.status ?? "idle");
    restart.hidden =
      repository?.status !== "error" || !repository.hasSavedSession;
    const running =
      submitting ||
      repository?.status === "starting" ||
      repository?.status === "busy" ||
      repository?.status === "stopping";
    element("activity-icon", HTMLElement).hidden = !running;
    element("chat-panel", HTMLElement).setAttribute(
      "aria-busy",
      String(running),
    );
    if (submitting) {
      element("session-status", HTMLElement).textContent = statusLabels.busy;
    }
  }

  function render(next: State): void {
    const previousRepositories = new Map(
      state?.repositories.map((repository) => [repository.id, repository]),
    );
    const previousActive = previousRepositories.get(state?.activeId ?? "");
    const nextActive = next.repositories.find(
      (entry) => entry.id === next.activeId,
    );
    const reset =
      previousActive?.id === nextActive?.id &&
      previousActive?.generation !== nextActive?.generation;
    if (state?.activeId && !reset) {
      drafts.set(state.activeId, question.value);
    }
    for (const repository of next.repositories) {
      const previous = previousRepositories.get(repository.id);
      if (previous && previous.generation !== repository.generation) {
        drafts.delete(repository.id);
        imageDrafts.delete(repository.id);
      }
    }
    const switched = state?.activeId !== next.activeId || reset;
    state = next;
    if (
      pending &&
      state.repositories.some(
        (repository) =>
          repository.id === pending?.id && repository.status === "busy",
      )
    ) {
      pending = undefined;
    }
    if (switched) {
      question.value = drafts.get(state.activeId ?? "") ?? state.draft;
      imageInput.value = "";
      renderImagePreviews();
    }
    element("root", HTMLElement).textContent = state.root;
    const active = state.repositories.find(
      (repository) => repository.id === state?.activeId,
    );
    element("active-repository", HTMLElement).textContent =
      active?.name ?? "Select a repository on the right";
    element("session-status", HTMLElement).textContent = active
      ? state.postMortemBusy
        ? "Generating PostMortem..."
        : statusLabels[active.status] +
          (active.parallelCount ? ` (${active.parallelCount} parallel)` : "") +
          (active.queuedCount ? ` (${active.queuedCount} queued)` : "")
      : "No Copilot session has started.";
    question.placeholder = active
      ? `Ask Copilot about ${active.name}...`
      : "Select a repository to begin.";

    const repositoriesKey = JSON.stringify([
      state.activeId,
      state.repositories,
    ]);
    if (repositoriesRenderedKey !== repositoriesKey) {
      repositoriesRenderedKey = repositoriesKey;
      startedRepositories.replaceChildren();
      otherRepositories.replaceChildren();
      for (const repository of state.repositories) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "repository";
        button.dataset.repositoryId = repository.id;
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-controls", "repository-menu");
        button.setAttribute(
          "aria-pressed",
          String(repository.id === state.activeId),
        );
        button.title = repository.path;
        const name = document.createElement("span");
        name.className = "repository-name";
        const running =
          repository.status === "starting" ||
          repository.status === "busy" ||
          repository.status === "stopping";
        const open =
          repository.status === "ready" || repository.status === "busy";
        button.classList.toggle("session-open", open);
        button.classList.toggle("session-working", running);
        button.setAttribute("aria-busy", String(running));
        if (running || open) {
          const icon = document.createElement("span");
          icon.className = running ? "spinner" : "session-indicator";
          icon.setAttribute("aria-hidden", "true");
          name.append(icon);
        }
        name.append(document.createTextNode(repository.name));
        const status = document.createElement("small");
        status.textContent = statusLabels[repository.status];
        button.append(name, status);
        button.addEventListener("click", () =>
          vscode.postMessage({ type: "select", id: repository.id }),
        );
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openRepositoryMenu(repository.id, event.clientX, event.clientY);
        });
        button.addEventListener("keydown", (event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const bounds = button.getBoundingClientRect();
            openRepositoryMenu(repository.id, bounds.left, bounds.bottom);
          }
        });
        (open || running ? startedRepositories : otherRepositories).append(
          button,
        );
      }
      if (startedRepositories.children.length === 0) {
        startedRepositories.textContent = "No active session.";
      }
      if (otherRepositories.children.length === 0) {
        otherRepositories.textContent =
          state.repositories.length === 0
            ? "No direct child repository containing .git was found."
            : "All repositories have an active session.";
      }
    }

    renderPermissions();
    renderQuestions();
    renderMessages(switched);
    showError(state.error);
    updateControls();
    updateRepositoryMenu();
    renderGitHub();
    renderPostMortem();
  }

  function renderPostMortem(): void {
    const report = state?.postMortem;
    const stale = Boolean(
      report && (state?.messages.length ?? 0) > report.sourceCount,
    );
    const key = JSON.stringify([
      state?.activeId,
      report?.sourceHash,
      report?.generatedAt,
      state?.postMortemBusy,
      state?.postMortemError,
      stale,
    ]);
    if (postMortemRenderedKey === key) return;
    postMortemRenderedKey = key;
    const section = element("postmortem-report", HTMLElement);
    section.hidden =
      !report && !state?.postMortemBusy && !state?.postMortemError;
    exportPostMortem.disabled = !report;
    const status = element("postmortem-status", HTMLElement);
    status.textContent = state?.postMortemBusy
      ? "Analysing all recorded exchanges; no tools or repository changes."
      : report
        ? `${report.sourceCount} source records - ${new Date(report.generatedAt).toLocaleString()}. Model-generated analysis; consult its sources.${stale ? " New exchanges are not included; generate again when work finishes." : ""}`
        : "";
    const error = element("postmortem-error", HTMLElement);
    error.textContent = state?.postMortemError ?? "";
    error.hidden = !error.textContent;
    const container = element("postmortem-table", HTMLElement);
    container.replaceChildren();
    if (!report) return;
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = `Conversation analysis - ${report.repository.name}`;
    table.append(caption);
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const label of [
      "Stage",
      "Objective",
      "Production / decisions",
      "Files / PR / commit",
      "Validation",
      "Errors / corrections",
      "Sources",
    ]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headings.append(cell);
    }
    head.append(headings);
    table.append(head);
    const body = document.createElement("tbody");
    const sourceMessages = state?.messages ?? [];
    for (const row of report.rows) {
      const tr = document.createElement("tr");
      for (const value of [
        row.phase,
        row.objective,
        row.production,
        row.filesAndCommits,
        row.validation,
        row.errors,
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      }
      const cell = document.createElement("td");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${row.firstMessage}-${row.lastMessage}`;
      details.append(summary);
      let rendered = false;
      details.addEventListener("toggle", () => {
        if (!details.open || rendered) return;
        rendered = true;
        for (
          let index = row.firstMessage - 1;
          index < row.lastMessage;
          index++
        ) {
          const message = sourceMessages[index];
          if (!message) continue;
          const heading = document.createElement("h4");
          heading.textContent = `#${index + 1} ${message.role}${message.title ? ` - ${message.title}` : ""}`;
          const content = document.createElement("pre");
          content.textContent = message.content;
          details.append(heading, content);
          if (message.details) {
            const metadata = document.createElement("pre");
            metadata.textContent = message.details;
            details.append(metadata);
          }
        }
      });
      cell.append(details);
      tr.append(cell);
      body.append(tr);
    }
    table.append(body);
    container.append(table);
  }

  postMortem.addEventListener("click", () => {
    if (state?.activeId && !postMortem.disabled) {
      postMortem.disabled = true;
      vscode.postMessage({ type: "postmortem", id: state.activeId });
    }
  });
  exportPostMortem.addEventListener("click", () => {
    if (state?.activeId && !exportPostMortem.disabled) {
      vscode.postMessage({ type: "export-postmortem", id: state.activeId });
    }
  });

  function githubKey(id: string): string {
    return JSON.stringify([id, githubSection]);
  }

  function requestGitHub(more = false): void {
    const id = state?.activeId;
    if (!id) return;
    const key = githubKey(id);
    const previous = githubPages.get(key);
    const cursor = more ? previous?.page?.cursor : undefined;
    githubPages.set(key, {
      status: "loading",
      page: more ? previous?.page : undefined,
    });
    renderGitHub();
    vscode.postMessage({ type: "github", id, section: githubSection, cursor });
  }

  function renderGitHub(): void {
    const id = state?.activeId;
    const key = id ? githubKey(id) : githubSection;
    const entry = id ? githubPages.get(key) : undefined;
    if (id && !entry) {
      requestGitHub();
      return;
    }
    if (key === githubRenderedKey && entry === githubRenderedPage) return;
    githubRenderedKey = key;
    githubRenderedPage = entry;
    for (const button of githubTabs.querySelectorAll<HTMLButtonElement>(
      "button",
    )) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.section === githubSection),
      );
    }
    element("github-heading", HTMLElement).textContent =
      githubLabels[githubSection];
    githubRefresh.disabled = !id || entry?.status === "loading";
    githubMore.hidden = !entry?.page?.cursor;
    githubMore.disabled = entry?.status === "loading";
    const status = element("github-status", HTMLElement);
    status.textContent = !id
      ? "Select a repository to view its activity."
      : entry?.status === "loading"
        ? "Loading repository activity..."
        : entry?.page
          ? `${entry.page.repository}${entry.page.viewer ? ` - ${entry.page.viewer}` : ""} (${entry.page.items.length})`
          : "";
    githubItems.setAttribute("aria-busy", String(entry?.status === "loading"));
    const failure = element("github-error", HTMLElement);
    failure.textContent = entry?.error ?? "";
    failure.hidden = !entry?.error;
    const notice = element("github-notice", HTMLElement);
    notice.textContent = entry?.page?.notice ?? "";
    notice.hidden = !notice.textContent;
    githubItems.replaceChildren();
    const link = (label: string, href?: string): HTMLElement => {
      const node = document.createElement(href ? "a" : "span");
      node.textContent = label;
      if (node instanceof HTMLAnchorElement && href) {
        node.href = href;
        node.title = "Open on GitHub";
      }
      return node;
    };
    for (const item of entry?.page?.items ?? []) {
      const card = document.createElement("article");
      card.className = "github-item";
      card.classList.toggle("github-mine", item.mine);
      const heading = document.createElement("h3");
      heading.append(link(item.title, item.url));
      const metadata = document.createElement("p");
      metadata.className = "github-metadata";
      const time = document.createElement("time");
      time.dateTime = item.date;
      time.textContent = new Date(item.date).toLocaleString();
      metadata.append(document.createTextNode(`${item.author} - `), time);
      const badges = document.createElement("div");
      badges.className = "github-badges";
      for (const [show, label, title, className] of [
        [item.mine, "Yours", "You created this issue or PR.", "mine"],
        [
          item.replied,
          "Replied",
          "You commented or submitted a review.",
          "replied",
        ],
        [
          item.afterMe,
          "After you",
          "Someone posted after your latest response.",
          "after-me",
        ],
      ] as const) {
        if (!show) continue;
        const badge = document.createElement("span");
        badge.className = `github-badge ${className}`;
        badge.textContent = label;
        badge.title = title;
        badges.append(badge);
      }
      card.append(heading, metadata, badges);
      for (const comment of item.comments ?? []) {
        const block = document.createElement("section");
        block.className = "github-comment";
        block.classList.toggle("github-mine", comment.mine);
        const author = document.createElement("p");
        author.append(
          link(
            `${comment.author} - ${new Date(comment.date).toLocaleString()}`,
            comment.url,
          ),
        );
        const body = document.createElement("div");
        body.className = "github-comment-body";
        body.textContent = comment.body;
        block.append(author, body);
        card.append(block);
      }
      githubItems.append(card);
    }
    if (entry?.status === "ready" && !entry.page?.items.length) {
      githubItems.textContent =
        githubSection === "mentions"
          ? "No unanswered mentions in this page."
          : githubSection === "comments"
            ? "No matching comments in this page."
            : "No entries found.";
    }
  }

  githubTabs.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const section = button.dataset.section;
    if (
      section === "issues" ||
      section === "reviews" ||
      section === "comments" ||
      section === "mentions" ||
      section === "commits"
    ) {
      githubSection = section;
      renderGitHub();
    }
  });
  githubRefresh.addEventListener("click", () => requestGitHub());
  githubMore.addEventListener("click", () => requestGitHub(true));

  function closeRepositoryMenu(restoreFocus = false): void {
    const id = menuRepositoryId;
    menuRepositoryId = undefined;
    menuConfirmation = undefined;
    repositoryMenu.hidden = true;
    repositoryMenu.replaceChildren();
    if (restoreFocus) {
      [...repositories.querySelectorAll<HTMLButtonElement>(".repository")]
        .find((button) => button.dataset.repositoryId === id)
        ?.focus();
    }
  }

  function updateRepositoryMenu(): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === menuRepositoryId,
    );
    if (!repository) {
      closeRepositoryMenu();
      return;
    }
    for (const button of repositoryMenu.querySelectorAll<HTMLButtonElement>(
      "button[data-action]",
    )) {
      const action = button.dataset.action;
      button.disabled =
        repository.status === "stopping" ||
        (action === "close-session" &&
          !["starting", "busy", "ready"].includes(repository.status)) ||
        (action?.startsWith("delete-") === true && !repository.sessionCount);
    }
  }

  function openRepositoryMenu(id: string, x: number, y: number): void {
    closeRepositoryMenu();
    menuRepositoryId = id;
    repositoryMenu.hidden = false;
    const actions = [
      ["close-session", "Close session"],
      ["new-session", "New session"],
      ["delete-last-session", "Delete latest session..."],
      ["delete-all-sessions", "Delete all sessions for this repository..."],
    ] as const;
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.action = action;
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (
          action === "delete-last-session" ||
          action === "delete-all-sessions"
        ) {
          confirmDeletion(action);
        } else {
          closeRepositoryMenu(true);
          vscode.postMessage({ type: action, id });
        }
      });
      repositoryMenu.append(button);
    }
    updateRepositoryMenu();
    positionRepositoryMenu(x, y);
    repositoryMenu.querySelector<HTMLButtonElement>("button:enabled")?.focus();
  }

  function positionRepositoryMenu(x: number, y: number): void {
    repositoryMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - repositoryMenu.offsetWidth))}px`;
    repositoryMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - repositoryMenu.offsetHeight))}px`;
  }

  function confirmDeletion(
    action: "delete-last-session" | "delete-all-sessions",
  ): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === menuRepositoryId,
    );
    if (!repository) {
      closeRepositoryMenu();
      return;
    }
    menuConfirmation = action;
    repositoryMenu.replaceChildren();
    const prompt = document.createElement("p");
    prompt.textContent = `Permanently delete ${action === "delete-all-sessions" ? "all sessions" : "the latest session"} for ${repository.name}, including their Copilot history? Repository files will not be changed.`;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.setAttribute("role", "menuitem");
    confirm.dataset.action = action;
    confirm.textContent = "Delete permanently";
    confirm.addEventListener("click", () => {
      const id = menuRepositoryId;
      const type = menuConfirmation;
      if (id && type) {
        closeRepositoryMenu(true);
        vscode.postMessage({ type, id });
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("role", "menuitem");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closeRepositoryMenu(true));
    repositoryMenu.append(prompt, confirm, cancel);
    updateRepositoryMenu();
    const bounds = repositoryMenu.getBoundingClientRect();
    positionRepositoryMenu(bounds.left, bounds.top);
    cancel.focus();
  }

  repositoryMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRepositoryMenu(true);
      return;
    }
    const buttons = [
      ...repositoryMenu.querySelectorAll<HTMLButtonElement>("button:enabled"),
    ];
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      event.target instanceof Node &&
      !repositoryMenu.contains(event.target)
    ) {
      closeRepositoryMenu();
    }
  });
  window.addEventListener("blur", () => closeRepositoryMenu());

  function renderPermissions(): void {
    const pending = state?.permissions ?? [];
    const ids = new Set(pending.map((request) => request.id));
    for (const [id, card] of permissionCards) {
      if (!ids.has(id)) {
        card.remove();
        permissionCards.delete(id);
      }
    }
    for (const request of pending) {
      if (permissionCards.has(request.id)) {
        continue;
      }
      const card = document.createElement("article");
      card.className = "permission";
      const heading = document.createElement("h3");
      const repository = state?.repositories.find(
        (entry) => entry.id === request.repositoryId,
      );
      heading.textContent = `Copilot (${repository?.name ?? request.repositoryId}): ${request.summary}`;
      const content = document.createElement("pre");
      content.textContent = request.content;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Event details";
      const raw = document.createElement("pre");
      raw.textContent = request.details;
      details.append(summary, raw);
      const actions = document.createElement("div");
      actions.className = "permission-actions";
      for (const approve of [true, false]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = approve
          ? (request.approvalLabel ?? "Allow once")
          : "Reject";
        button.addEventListener("click", () => {
          for (const control of actions.querySelectorAll("button")) {
            control.disabled = true;
          }
          vscode.postMessage({
            type: "permission",
            id: request.id,
            approve,
          });
        });
        actions.append(button);
      }
      card.append(heading, content, details, actions);
      permissionCards.set(request.id, card);
      permissions.append(card);
    }
    const showDetails =
      filters.querySelector<HTMLInputElement>('input[value="system"]')
        ?.checked !== false;
    for (const details of permissions.querySelectorAll("details")) {
      details.hidden = !showDetails;
    }
    permissions.hidden = pending.length === 0;
  }

  function renderQuestions(): void {
    const pending = state?.questions ?? [];
    const ids = new Set(pending.map((request) => request.id));
    for (const [id, card] of questionCards) {
      if (!ids.has(id)) {
        card.remove();
        questionCards.delete(id);
      }
    }
    for (const request of pending) {
      if (questionCards.has(request.id)) {
        continue;
      }
      const card = document.createElement("form");
      card.className = "agent-question";
      const heading = document.createElement("h3");
      const repository = state?.repositories.find(
        (entry) => entry.id === request.repositoryId,
      );
      heading.textContent = `Copilot (${repository?.name ?? request.repositoryId})`;
      const prompt = document.createElement("p");
      prompt.className = "question-text";
      prompt.textContent = request.question;
      const actions = document.createElement("div");
      actions.className = "permission-actions";
      const answer = (text: string): void => {
        for (const control of card.querySelectorAll("button, textarea")) {
          if (
            control instanceof HTMLButtonElement ||
            control instanceof HTMLTextAreaElement
          ) {
            control.disabled = true;
          }
        }
        vscode.postMessage({ type: "answer", id: request.id, answer: text });
      };
      for (const choice of request.choices ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = choice;
        button.addEventListener("click", () => answer(choice));
        actions.append(button);
      }
      card.append(heading, prompt, actions);
      if (request.allowFreeform !== false) {
        const label = document.createElement("label");
        label.textContent = "Your answer";
        const input = document.createElement("textarea");
        input.rows = 2;
        input.maxLength = 20000;
        input.id = `answer-${request.id}`;
        label.htmlFor = input.id;
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = "Reply";
        submit.disabled = true;
        input.addEventListener("input", () => {
          submit.disabled = !input.value.trim();
        });
        input.addEventListener("keydown", (event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (!submit.disabled) {
              card.requestSubmit();
            }
          }
        });
        card.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!submit.disabled && input.value.trim()) {
            answer(input.value);
          }
        });
        card.append(label, input, submit);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel request";
      cancel.addEventListener("click", () => {
        vscode.postMessage({ type: "cancel", id: request.repositoryId });
      });
      card.append(cancel);
      questionCards.set(request.id, card);
      questions.append(card);
    }
    questions.hidden = pending.length === 0;
  }

  let scrollFrame: number | undefined;

  function renderMessages(switched = false): void {
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    const selection = window.getSelection();
    const savePoint = (node: Node | null, offset: number) => {
      const article = (
        node instanceof Element ? node : node?.parentElement
      )?.closest<HTMLElement>(".message");
      if (!node || article?.parentElement !== messages) return undefined;
      const range = document.createRange();
      range.selectNodeContents(article);
      range.setEnd(node, offset);
      return { index: article.dataset.index, offset: range.toString().length };
    };
    const anchor =
      !switched && selection && !selection.isCollapsed
        ? savePoint(selection.anchorNode, selection.anchorOffset)
        : undefined;
    const focus = anchor
      ? savePoint(selection!.focusNode, selection!.focusOffset)
      : undefined;
    const showEventDetails =
      filters.querySelector<HTMLInputElement>('input[value="system"]')
        ?.checked !== false;
    const scrollTop = messages.scrollTop;
    const nearBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    const enabled = new Set(
      [...filters.querySelectorAll<HTMLInputElement>("input:checked")].map(
        (input) => input.value,
      ),
    );
    if (switched) {
      messages.replaceChildren();
      messageCards.length = 0;
    }
    let lastVisibleMessage: HTMLElement | undefined;
    for (const [index, message] of (state?.messages ?? []).entries()) {
      const failed =
        message.error ||
        (message.role === "output" && message.title?.endsWith(": failed"));
      const category =
        message.role === "tool" &&
        (message.title === "assistant.tool_call_delta" ||
          message.title?.startsWith("tool.") ||
          (message.title?.startsWith("Tool: ") &&
            !message.details &&
            message.content.trimStart().startsWith("{")))
          ? "system"
          : categories[message.role];
      const hidden = !failed && !enabled.has(category);
      const previous = messageCards[index];
      if (
        previous &&
        previous.showEventDetails === showEventDetails &&
        messageFields.every(
          (field) => previous.message[field] === message[field],
        )
      ) {
        if (previous.article.hidden !== hidden)
          previous.article.hidden = hidden;
        if (!hidden) {
          lastVisibleMessage = previous.article;
        }
        continue;
      }
      const article = document.createElement("article");
      article.className = `message ${message.role}`;
      if (failed) article.classList.add("failed");
      article.dataset.index = String(index);
      article.hidden = hidden;
      if (!hidden) {
        lastVisibleMessage = article;
      }
      const heading = document.createElement("h3");
      heading.textContent =
        (message.title ?? roleLabels[message.role]) +
        (message.agentId && showEventDetails ? ` [${message.agentId}]` : "");
      if (message.timestamp && showEventDetails) {
        const time = document.createElement("time");
        time.dateTime = message.timestamp;
        time.textContent = message.timestamp;
        heading.append(time);
      }
      const content = document.createElement(
        message.role === "tool" ||
          message.role === "output" ||
          message.role === "system"
          ? "pre"
          : "div",
      );
      content.className = "content";
      if (message.html !== undefined) {
        content.innerHTML = message.html;
      } else {
        content.textContent = message.content;
      }
      article.append(heading, content);
      if (message.details) {
        const details = document.createElement("details");
        details.hidden = !showEventDetails;
        details.open =
          previous?.article.querySelector("details")?.open ?? false;
        const summary = document.createElement("summary");
        summary.textContent = "Event details";
        const data = document.createElement("pre");
        data.textContent = message.details;
        details.append(summary, data);
        article.append(details);
      }
      if (previous) previous.article.replaceWith(article);
      else messages.append(article);
      messageCards[index] = { message, showEventDetails, article };
    }
    while (messageCards.length > (state?.messages.length ?? 0)) {
      messageCards.pop()?.article.remove();
    }
    if (anchor && focus) {
      const restorePoint = (
        point: typeof anchor,
      ): [Node, number] | undefined => {
        const article = messages.querySelector(
          `.message[data-index="${point.index}"]`,
        );
        if (!article || (article as HTMLElement).hidden) return undefined;
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        let offset = point.offset;
        let last: Node = article;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          last = node;
          const length = node.textContent?.length ?? 0;
          if (offset <= length) return [node, offset];
          offset -= length;
        }
        return [last, last.textContent?.length ?? 0];
      };
      const start = restorePoint(anchor);
      const end = restorePoint(focus);
      if (start && end) {
        selection!.setBaseAndExtent(...start, ...end);
      }
    }
    if (switched || nearBottom) {
      messages.scrollTop = messages.scrollHeight;
      const pendingScrollTop = messages.scrollTop;
      // Resolve skipped content after layout has updated its estimated heights.
      scrollFrame = window.requestAnimationFrame?.(() => {
        scrollFrame = undefined;
        if (messages.scrollTop < pendingScrollTop) {
          return;
        }
        lastVisibleMessage?.scrollIntoView?.({ block: "end" });
        messages.scrollTop = messages.scrollHeight;
      });
    } else {
      messages.scrollTop = scrollTop;
    }
  }

  parallel.addEventListener("click", () => {
    const enabled = parallel.getAttribute("aria-pressed") !== "true";
    parallel.setAttribute("aria-pressed", String(enabled));
    parallel.textContent = enabled ? "Parallel ON" : "Parallel OFF";
  });

  function renderImagePreviews(): void {
    imagePreviews.replaceChildren();
    const id = state?.activeId;
    for (const [index, attachment] of (
      imageDrafts.get(id ?? "") ?? []
    ).entries()) {
      const preview = document.createElement("div");
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = attachment.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = `Remove ${attachment.name}`;
      remove.addEventListener("click", () => {
        if (!id || readingImages.has(id)) return;
        imageDrafts.get(id)?.splice(index, 1);
        renderImagePreviews();
        updateControls();
      });
      preview.append(image, remove);
      imagePreviews.append(preview);
    }
  }

  async function addImages(files: File[]): Promise<void> {
    const id = state?.activeId;
    if (!id || imageInput.disabled || !files.length) return;
    const generation = state?.repositories.find(
      (repo) => repo.id === id,
    )?.generation;
    const existing = imageDrafts.get(id) ?? [];
    if (
      existing.length + files.length > Number(imageInput.dataset.maxCount) ||
      files.some(
        (file) =>
          !imageInput.accept.split(",").includes(file.type) ||
          !file.size ||
          file.size > Number(imageInput.dataset.maxBytes),
      )
    ) {
      showError(
        "Attach up to five PNG, JPEG, GIF or WebP images, at most 5 MiB each.",
      );
      return;
    }
    readingImages.add(id);
    updateControls();
    try {
      const images = await Promise.all(
        files.map(
          (file) =>
            new Promise<ImageAttachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: file.name.slice(0, 255) || "Image",
                  dataUrl: String(reader.result),
                });
              reader.onerror = () =>
                reject(new Error(`Could not read ${file.name}.`));
              reader.onabort = () =>
                reject(new Error(`Reading ${file.name} was cancelled.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      const repository = state?.repositories.find((repo) => repo.id === id);
      if (repository && repository.generation === generation) {
        imageDrafts.set(id, [...existing, ...images]);
        if (state?.activeId === id) {
          renderImagePreviews();
          showError();
        }
      }
    } catch (error) {
      if (state?.activeId === id) showError(String(error));
    } finally {
      readingImages.delete(id);
      updateControls();
    }
  }

  imageInput.addEventListener("change", () => {
    const files = [...(imageInput.files ?? [])];
    imageInput.value = "";
    void addImages(files);
  });
  question.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length && !imageInput.disabled) {
      event.preventDefault();
      void addImages(files);
    }
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (send.disabled || !state?.activeId) {
      return;
    }
    const images = imageDrafts.get(state.activeId);
    pending = {
      id: state.activeId,
      text: question.value,
      ...(images?.length ? { images } : {}),
    };
    question.value = "";
    drafts.delete(state.activeId);
    imageDrafts.delete(state.activeId);
    renderImagePreviews();
    updateControls();
    showError();
    vscode.postMessage({
      type: "send",
      id: state.activeId,
      question: pending.text,
      parallel: parallel.getAttribute("aria-pressed") === "true",
      ...(pending.images ? { images: pending.images } : {}),
    });
  });
  question.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      updateControls();
      if (!send.disabled) {
        composer.requestSubmit();
      }
    }
  });
  filters.addEventListener("change", () => {
    renderMessages();
    renderPermissions();
  });
  const openLink = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) {
      return;
    }
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link instanceof HTMLAnchorElement) {
      event.preventDefault();
      vscode.postMessage({ type: "openExternal", url: link.href });
    }
  };
  messages.addEventListener("click", openLink);
  messages.addEventListener("auxclick", openLink);
  githubItems.addEventListener("click", openLink);
  githubItems.addEventListener("auxclick", openLink);
  question.addEventListener("input", () => {
    updateControls();
    if (state?.activeId) {
      vscode.postMessage({
        type: "draft",
        id: state.activeId,
        text: question.value,
      });
    }
  });
  restart.addEventListener("click", () => {
    if (state?.activeId && !restart.hidden) {
      vscode.postMessage({ type: "restart", id: state.activeId });
    }
  });
  cancel.addEventListener("click", () => {
    if (state?.activeId) {
      vscode.postMessage({ type: "cancel", id: state.activeId });
    }
  });
  element("refresh", HTMLButtonElement).addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  window.addEventListener(
    "message",
    (
      event: MessageEvent<
        | { type: "state"; state: State }
        | { type: "error"; message: string; id?: string }
        | GitHubUpdate
      >,
    ) => {
      if (event.data.type === "state") {
        render(event.data.state);
      } else if (event.data.type === "github") {
        const update = event.data;
        const key = JSON.stringify([update.id, update.section]);
        const previous = githubPages.get(key);
        const page =
          update.page && update.append && previous?.page
            ? {
                ...update.page,
                items: [
                  ...new Map(
                    [...previous.page.items, ...update.page.items].map(
                      (item) => [item.id, item],
                    ),
                  ).values(),
                ],
              }
            : (update.page ?? (update.append ? previous?.page : undefined));
        if (page) {
          page.items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        }
        githubPages.set(key, {
          status: update.status,
          page,
          error: update.error,
        });
        renderGitHub();
      } else if (event.data.type === "error") {
        if (pending && (!event.data.id || event.data.id === pending.id)) {
          drafts.set(pending.id, pending.text);
          if (pending.images) imageDrafts.set(pending.id, pending.images);
          if (state?.activeId === pending.id) {
            question.value = pending.text;
            renderImagePreviews();
          }
          vscode.postMessage({
            type: "draft",
            id: pending.id,
            text: pending.text,
          });
          pending = undefined;
        }
        if (!event.data.id || event.data.id === state?.activeId) {
          showError(event.data.message);
        }
        updateControls();
      }
    },
  );
  vscode.postMessage({ type: "ready" });
})();
