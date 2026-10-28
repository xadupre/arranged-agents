Features and safeguards
=======================

Current features
----------------

* Ask one question and display one Markdown result panel per request.
* Include the editor selection only after explicit consent.
* Choose the CLI executable and model through VS Code settings.
* Cancel a request and report visible CLI/model errors.
* Reject concurrent requests until the current request finishes or is cancelled.

Input limits are 20,000 characters for the trimmed question and 80,000 for a
selection. Inputs are rejected rather than silently truncated.

Data boundaries
---------------

No workspace files are attached automatically. Requests use the extension's
global storage directory rather than the opened workspace as their working
directory. Configuration discovery, file hooks, skills, on-demand instructions,
session-store integration and host Git operations are disabled.

Agent tools are disabled and permission requests are rejected. The extension
cannot apply suggested edits or run suggested commands. Selected text is marked
as reference data, not instructions; it is still sent to the model when approved.

Results use a script-disabled webview with no local resource roots. Raw HTML is
escaped, Markdown links become inactive text, and images are not loaded. A
restrictive Content Security Policy blocks remote resources.

Workspace Trust is required. The CLI's normal session persistence and GitHub's
service-side policies still apply; disabling session-store integration is not a
promise that no CLI state is written.

Lifecycle
---------

The two-minute request deadline covers CLI startup, session creation, generation
and graceful shutdown. Cancellation also works during these phases. A stalled
CLI is forcibly terminated, and extension deactivation waits for an active CLI
request to stop.

Known limitations
-----------------

There is no conversation history UI, streaming answer display, automatic file
context, editing agent or Marketplace publication.

Automated tests cover rendering, prompts and real SDK subprocess lifecycle
using an explicit local CLI fixture. A real authenticated CLI model request and
VSIX installation have passed locally. These checks do not replace interactive
extension-host validation of consent dialogs, Workspace Trust, overlapping
commands, deactivation and side-panel behavior. See :doc:`development`.
