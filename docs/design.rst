Design and source guide
=======================

Request flow
------------

``src/extension.ts`` registers ``arrangedAgents.open`` and the legacy
``arrangedAgents.ask`` alias. It opens a singleton editor webview and forwards
validated messages to the application model. Development launches open the
tab automatically, without starting Copilot.

``src/repositories.ts`` discovers one level of Git directories beneath the
launch root. ``src/application.ts`` tracks the selected repository, per-repository
status and transcripts, merging streamed text by message/reasoning/tool identifiers
while keeping background repositories and subagents separate.
Incoming repository IDs must belong to this discovered
list; browser-provided paths cannot start arbitrary sessions.

``src/conversation.ts`` creates one lazy SDK client/session per clicked repository.
It registers the event handler before session creation, enables streaming,
reuses the same session for subsequent messages, isolates repository working
directories and bounds startup/response operations. A saved SDK session ID is
resumed instead of creating a fresh session. Resume disables transcript repair
and continuation of pending work. Closing the application forces cleanup of all
clients and waits for interrupted application operations to settle.

``src/storage.ts`` validates versioned snapshots and writes them atomically to
private, per-parent JSON files in the extension's global storage. The extension
saves periodically and flushes on tab disposal/deactivation. Snapshots contain
transcripts, drafts, active repository and SDK session IDs, not browser-rendered
HTML. Only discovered repositories can resume; loading history never spawns a CLI.

``src/prompt.ts`` validates size limits and builds the prompt without attaching
files or adding workspace context.

``src/copilot.ts`` shares executable resolution, client construction and
repository-aware agent settings. It preserves native system instructions and
enables tools and repository discovery. The extension confirms requested
permissions through inline webview controls without modal dialogs or notifications.
``AgentApplication`` owns pending decisions, routes them by unique request ID and
rejects them on cancellation, failure, repository removal or closure. Decisions are
not persisted or automatically replayed. Its original one-shot helper is retained; the application
and CLI smoke test use the persistent conversation implementation.

``src/render.ts`` escapes HTML, blocks remote images and renders equations
using KaTeX's MathML output. ``src/webview.ts`` is the type-checked browser script;
it updates the three panels and activity indicators, handles accessible panel
dividers, keyboard submission and category filters, keeps drafts and posts commands
to the extension. HTTP/HTTPS links are detected in Markdown and escaped plain
tool output; ``src/links.ts`` shares URL validation between rendering and the
extension's external-browser message handler.
Legacy module detection keeps this script free of CommonJS ``exports`` at runtime.
``media/app.css`` defines the three-column layout.

Validation entry points
-----------------------

* ``test/prompt.test.ts`` checks question limits and approved-selection handling.
* ``test/render.test.ts`` checks Markdown, MathML, safe links and escaped tool output.
* ``test/repositories.test.ts`` checks direct-child discovery and Git worktrees.
* ``test/application.test.ts`` exercises the real SDK/CLI fixture through the
  application model, including live events, lazy startup, session reuse, navigation and cleanup.
  It also checks disk-backed close/reopen, SDK context resumption and missing-session recovery.
* ``test/storage.test.ts`` checks private atomic saves, root isolation,
  corrupt snapshots and write-error recovery using the real filesystem.
* ``test/webview.test.ts`` runs the compiled UI in a real DOM implementation,
  checking panel resizing, activity, Enter/Shift+Enter, links, category filters,
  equations, saved drafts and repository-specific errors.
* ``test/copilot.test.ts`` runs the real SDK against
  ``test/fixtures/copilot.ts``, a local stdio protocol fixture. It checks startup,
  permission callbacks, failure propagation, deadlines, cancellation and child-process termination.
* ``scripts/smoke.ts`` sends three real model requests from a temporary Git
  repository, including reading a unique marker file through the CLI's tools.
  It also checks that tool execution/result events arrive, then stops the CLI,
  resumes the same session and verifies earlier context without rereading the file.
  It requires the user's authenticated CLI.
* ``scripts/extension-host-smoke.ts`` checks activation, commands and an open app tab
  in a real VS Code extension host when launched through the dedicated F5 config.

The runtime SDK and Markdown renderer are production dependencies. TypeScript,
formatting, linting, coverage and VSIX packaging are development tools.
