Design and source guide
=======================

Request flow
------------

``src/extension.ts`` registers ``arrangedAgents.ask`` and manages VS Code UI.
It checks Workspace Trust and the single-request guard, collects a question,
asks for selection consent, and passes the approved input to the prompt builder.

``src/prompt.ts`` validates size limits and builds the prompt without attaching
files or adding workspace context.

``src/copilot.ts`` resolves the installed CLI on ``PATH`` or uses an explicit
path. It creates a Copilot SDK client over stdio, disables agent capabilities,
requests an answer, and stops its child process. An abort/deadline race covers
startup, the session and graceful shutdown; forced cleanup reaps stalled children.

``src/render.ts`` converts Markdown into a complete, restricted HTML document.
The extension displays it in a webview beside the editor.

Validation entry points
-----------------------

* ``test/prompt.test.ts`` checks question limits and approved-selection handling.
* ``test/render.test.ts`` checks Markdown, escaping and inactive links/images.
* ``test/copilot.test.ts`` runs the real SDK against
  ``test/fixtures/copilot.ts``, a local stdio protocol fixture. It checks startup,
  failure propagation, deadlines, cancellation and child-process termination.
* ``scripts/smoke.ts`` sends one real model request from an empty temporary
  directory. It requires the user's authenticated CLI.
* ``scripts/extension-host-smoke.ts`` checks activation and command registration
  in a real VS Code extension host when launched through the dedicated F5 config.

The runtime SDK and Markdown renderer are production dependencies. TypeScript,
formatting, linting, coverage and VSIX packaging are development tools.
