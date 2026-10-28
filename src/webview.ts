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
  const permissions = element("permissions", HTMLElement);
  const permissionCards = new Map<string, HTMLElement>();
  const questions = element("questions", HTMLElement);
  const questionCards = new Map<string, HTMLElement>();
  const question = element("question", HTMLTextAreaElement);
  const send = element("send", HTMLButtonElement);
  const cancel = element("cancel", HTMLButtonElement);
  const restart = element("restart", HTMLButtonElement);
  const error = element("error", HTMLElement);
  const composer = element("composer", HTMLFormElement);
  const filters = element("information-filters", HTMLFieldSetElement);
  const repositoryMenu = element("repository-menu", HTMLElement);
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
  let pending: { id: string; text: string } | undefined;
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
    const ready = repository?.status === "ready";
    const submitting = pending !== undefined && pending.id === repository?.id;
    question.disabled = !ready || submitting;
    send.disabled = !ready || submitting || !question.value.trim();
    cancel.disabled = !["starting", "busy"].includes(
      repository?.status ?? "idle",
    );
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
    }
    element("root", HTMLElement).textContent = state.root;
    const active = state.repositories.find(
      (repository) => repository.id === state?.activeId,
    );
    element("active-repository", HTMLElement).textContent =
      active?.name ?? "Select a repository on the right";
    element("session-status", HTMLElement).textContent = active
      ? statusLabels[active.status]
      : "No Copilot session has started.";
    question.placeholder = active
      ? `Ask Copilot about ${active.name}...`
      : "Select a repository to begin.";

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

    renderPermissions();
    renderQuestions();
    renderMessages(switched);
    showError(state.error);
    updateControls();
    updateRepositoryMenu();
  }

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
        button.textContent = approve ? "Allow once" : "Reject";
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

  function renderMessages(switched = false): void {
    const showEventDetails =
      filters.querySelector<HTMLInputElement>('input[value="system"]')
        ?.checked !== false;
    const scrollTop = messages.scrollTop;
    const nearBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    const expanded = new Set(
      [...messages.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
        (details) => details.parentElement?.dataset.index,
      ),
    );
    messages.replaceChildren();
    for (const [index, message] of (state?.messages ?? []).entries()) {
      const failed =
        message.error ||
        (message.role === "output" && message.title?.endsWith(": failed"));
      const article = document.createElement("article");
      article.className = `message ${message.role}`;
      if (failed) {
        article.classList.add("failed");
      }
      article.dataset.index = String(index);
      const category =
        message.role === "tool" &&
        (message.title === "assistant.tool_call_delta" ||
          message.title?.startsWith("tool.") ||
          (message.title?.startsWith("Tool: ") &&
            !message.details &&
            message.content.trimStart().startsWith("{")))
          ? "system"
          : categories[message.role];
      const filter = filters.querySelector<HTMLInputElement>(
        `input[value="${category}"]`,
      );
      article.hidden = !failed && filter?.checked === false;
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
        details.open = !switched && expanded.has(String(index));
        const summary = document.createElement("summary");
        summary.textContent = "Event details";
        const data = document.createElement("pre");
        data.textContent = message.details;
        details.append(summary, data);
        article.append(details);
      }
      messages.append(article);
    }
    if (switched || nearBottom) {
      messages.scrollTop = messages.scrollHeight;
    } else {
      messages.scrollTop = scrollTop;
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (send.disabled || !state?.activeId) {
      return;
    }
    pending = { id: state.activeId, text: question.value };
    question.value = "";
    drafts.delete(state.activeId);
    updateControls();
    showError();
    vscode.postMessage({
      type: "send",
      id: state.activeId,
      question: pending.text,
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
      >,
    ) => {
      if (event.data.type === "state") {
        render(event.data.state);
      } else if (event.data.type === "error") {
        if (pending && (!event.data.id || event.data.id === pending.id)) {
          drafts.set(pending.id, pending.text);
          if (state?.activeId === pending.id) {
            question.value = pending.text;
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
