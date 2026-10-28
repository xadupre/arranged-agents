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
  const messages = element("messages", HTMLElement);
  const permissions = element("permissions", HTMLElement);
  const permissionCards = new Map<string, HTMLElement>();
  const question = element("question", HTMLTextAreaElement);
  const send = element("send", HTMLButtonElement);
  const cancel = element("cancel", HTMLButtonElement);
  const restart = element("restart", HTMLButtonElement);
  const error = element("error", HTMLElement);
  const composer = element("composer", HTMLFormElement);
  const filters = element("information-filters", HTMLFieldSetElement);
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
    saved: "Saved session - click to resume",
    starting: "Starting Copilot...",
    ready: "Session ready",
    busy: "Copilot is answering...",
    error: "Session stopped - click to restart",
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
      repository?.status === "busy";
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
    if (state?.activeId) {
      drafts.set(state.activeId, question.value);
    }
    const switched = state?.activeId !== next.activeId;
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

    repositories.replaceChildren();
    for (const repository of state.repositories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "repository";
      button.setAttribute(
        "aria-pressed",
        String(repository.id === state.activeId),
      );
      button.title = repository.path;
      const name = document.createElement("span");
      name.className = "repository-name";
      const running =
        repository.status === "starting" || repository.status === "busy";
      button.setAttribute("aria-busy", String(running));
      if (running) {
        const icon = document.createElement("span");
        icon.className = "spinner";
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
      repositories.append(button);
    }
    if (state.repositories.length === 0) {
      repositories.textContent =
        "No direct child repository containing .git was found.";
    }

    renderPermissions();
    renderMessages(switched);
    showError(state.error);
    updateControls();
  }

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
      heading.textContent = `Copilot (${repository?.name ?? request.repositoryId}): allow ${request.kind}?`;
      const details = document.createElement("pre");
      details.textContent = request.details;
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
      card.append(heading, details, actions);
      permissionCards.set(request.id, card);
      permissions.append(card);
    }
    permissions.hidden = pending.length === 0;
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
      const article = document.createElement("article");
      article.className = `message ${message.role}`;
      article.dataset.index = String(index);
      const filter = filters.querySelector<HTMLInputElement>(
        `input[value="${categories[message.role]}"]`,
      );
      article.hidden = filter?.checked === false;
      const heading = document.createElement("h3");
      heading.textContent =
        (message.title ?? roleLabels[message.role]) +
        (message.agentId ? ` [${message.agentId}]` : "");
      if (message.timestamp) {
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
  filters.addEventListener("change", () => renderMessages());
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
