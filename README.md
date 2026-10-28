# Arranged Agents

<img src="media/icon.png" alt="Arranged Agents icon" width="128" height="128">

[![Tests](https://github.com/xadupre/arranged-agents/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/xadupre/arranged-agents/actions/workflows/tests.yml)
[![Code coverage](https://codecov.io/gh/xadupre/arranged-agents/branch/main/graph/badge.svg)](https://codecov.io/gh/xadupre/arranged-agents)

A three-panel application inside a VS Code editor tab, using your **locally
installed GitHub Copilot CLI**:

- **Left:** issues, PRs, your comments and later responses, and recent commits.
- **Center:** the selected repository's Copilot conversation, rendered as HTML
  with Markdown and mathematical equations.
- **Right:** direct child directories containing a `.git` directory or file.
  Each repository has its own session, started only when you click it.

## Requirements

- VS Code 1.105 or newer.
- Node.js 22.13 or newer for development.
- GitHub Copilot CLI installed and authenticated: run `copilot login`.
- Git and GitHub CLI installed; run `gh auth login` for the activity sidebar.
- A GitHub account with access to Copilot. Requests use your Copilot allowance.

The CLI runs locally, but model requests still go to GitHub Copilot: this is not
an offline model. No separate API key is required.

## Try it

Pass the parent directory containing your repositories:

```bash
./start.sh /path/to/repositories
```

The script installs missing dependencies, compiles, and opens a new VS Code
development window. It chooses the desktop `code` executable, not the restricted
remote CLI, and removes the remote IPC hook. Other installed extensions are
disabled in that window. The **Arranged Agents** tab opens automatically.
Without a directory argument, the launcher uses the source checkout's parent
directory, regardless of the terminal's current directory.
The source checkout is used for compilation, not as the implicit repository root.
No Copilot process or session starts until a repository is clicked.

Alternatively run `npm ci` and open this directory in VS Code,
then select **Run Arranged Agents** and press **F5**. In the development window,
the application opens automatically and scans the first workspace folder.
For an installed VSIX, run **Arranged Agents: Open** from the Command Palette.
The old **Ask Copilot** command is an alias for opening the application.

Click a repository on the right, wait for **Session open - ready**, and send messages
in the center with **Enter** or **Send**. **Shift+Enter** inserts a new line.
The **Parallel ON/OFF** button beside **Send** defaults to **ON**. While Copilot
is working, ON starts an independent request immediately with a bounded snapshot
of the visible conversation. OFF queues the message for the main agent after
current requests finish, in submission order. Parallel requests can run tools
and edit the same repository files, subject to the usual permissions; concurrent
edits can conflict. Their messages and commands carry a **Parallel** label.
**Cancel** stops all requests and discards queued messages for that repository.
Switching repositories preserves their independent conversations
and drafts. **Refresh** rescans the parent directory without restarting existing
sessions. Closing the tab stops Copilot and saves the histories, drafts and session
IDs locally. Reopening restores the last selected repository and its transcript;
click a repository to resume its saved Copilot context. Nothing restarts in the
background, and interrupted requests are never sent again automatically.

History is saved per repository parent under the extension's VS Code global
storage, outside your repositories, as private JSON files (not encrypted).
Resume also requires the CLI's own saved session to remain available. If it is
missing or invalid, an error is shown; **New session** explicitly starts fresh
while retaining the displayed history, without replaying it to the model.

Activity icons indicate session startup and requests in progress, including in
background repositories. Drag either panel divider to resize it, or focus the
divider and use the left/right arrow keys.

The left panel follows the selected repository with four buttons:
**Issues**, **Reviews** (pull requests), **Commits** and **Comments**.
Your issues/PRs have a distinct background; **Replied** marks your participation
and **After you** indicates a comment or submitted review after your latest response.
**Comments** shows your comments/reviews plus subsequent responses, including closed
discussions. **Commits** lists the latest 30 commits on the current local branch.
Click titles or comment timestamps to open their GitHub page in your browser.
GitHub feeds require an installed, authenticated `gh` CLI (`gh auth login`).
Use **Refresh** for new activity and **Load more** for older discussions.

The default transcript is concise: your messages, Copilot's responses and readable
command/tool summaries with their running/completed/failed status. Errors remain
visible. Use the checkboxes to add **Reasoning**, **Output** or **Session / events
(JSON)**, or hide **Messages** and **Commands / tools**, without stopping execution
or deleting history. Streaming tool-input fragments are grouped as technical events,
not shown as individual commands. Raw metadata and timestamps are hidden until
**Session / events (JSON)** is checked; expand **Event details** to inspect metadata.
HTTP/HTTPS links, including plain URLs in tool output, open in your browser.

After a task finishes, click **PostMortem** above the conversation. Copilot groups
the whole selected session's recorded exchanges into a table of coherent stages:
objectives, production/decisions, files/PR/commit, validations and errors/corrections.
Expand each row's **Sources** to inspect its evidence. **Export JSON** saves both
the table and the complete analysed transcript. The report stays with the saved
conversation; later exchanges are excluded until you generate it again.
Analysis uses separate tool-free model requests and your normal Copilot allowance.

Right-click a repository (or press Shift+F10) to manage its sessions:

- **Close session** stops Copilot but keeps its history and resumable context.
- **New session** archives the previous conversation and opens a fresh one.
- **Delete latest session** deletes the latest conversation and restores the
  previous saved one without starting Copilot.
- **Delete all sessions for this repository** deletes only this repository's
  conversations managed by Arranged Agents, never other repositories' sessions.

Deletion requires a quiet inline confirmation and removes both application history
and the corresponding Copilot sessions through the official SDK API. Repository
files are not deleted. If deletion fails, remaining histories are retained and
the error is displayed. Old saved histories remain compatible.

Copilot can inspect the selected repository, use its instructions and run tools
such as Git or `gh` for pull requests. Permission requests appear directly in
the conversation panel with **Allow once** and **Reject**, without modal popups,
notification sounds or automatic approval. Each request identifies its repository,
including background sessions, and remains visible regardless of display filters.
Approvals show readable descriptions, full commands, paths and proposed changes
rather than JSON. Copilot's questions appear as inline choice buttons and, when
allowed, a free-text answer box. Enter submits; Shift+Enter adds a line.
Cancelling or closing rejects pending requests and questions.
GitHub operations use the CLI's existing authentication.

Equations use `$x^2$` inline or `$$E=mc^2$$` on their own line. KaTeX renders
native MathML without loading external fonts or scripts.

Click **Settings** at the top right to open the Arranged Agents settings page in
VS Code. `arrangedAgents.requestTimeoutMinutes` defaults to **60 minutes** and
limits total operation time, including tools and permission waits. Changes apply
to subsequent operations, even in existing sessions.

If VS Code cannot find `copilot`, set `arrangedAgents.cliPath` to its absolute
executable path. Optionally set `arrangedAgents.model` to a supported model ID.
In Remote SSH, WSL, or a dev container, the CLI must be installed and authenticated
on the machine hosting the workspace extension.

## Documentation and automation

Sphinx documentation: [getting started](docs/getting_started.rst),
[features and safeguards](docs/features.rst), [source guide](docs/design.rst),
and [development, coverage, releases and documentation build](docs/development.rst).

Like [onnx-light-viewer](https://github.com/xadupre/onnx-light-viewer), automation
is split into Linux/Windows tests, nightly TypeScript coverage with Codecov,
weekly Sphinx documentation, and tagged GitHub releases with a VSIX attachment.
Configure `CODECOV_TOKEN` for coverage uploads. Workflows never run the paid
Copilot smoke test or publish to the Marketplace.

## Checks and packaging

```bash
npm run check
npm run coverage
npm run package
code --install-extension ./arranged-agents-0.1.0.vsix
```

The resulting `.vsix` can be installed with VS Code's **Install from VSIX** command.
To test the real local CLI connection, run `npm run smoke`. This sends three model
requests and requires your existing Copilot login; it is not part of CI.
The smoke test creates a temporary Git repository and verifies that Copilot can
read a unique marker file there, stops the CLI, resumes the same session in a new
process and checks that its earlier context is retained.
Packaging uses the supported `--skip-license` policy while the project remains
`UNLICENSED`; this does not grant a license or publish to the Marketplace.

The unit tests also run the real SDK against a small local stdio CLI fixture:
they cover PATH lookup, missing CLI, authentication/model errors, empty answers,
and cancellation/timeouts during startup, session creation, generation, and
shutdown. They verify that each child process exits. No model requests are made
by `npm run check`. The Bash launcher also has focused subprocess tests on
Linux; they do not open VS Code. Application tests check lazy repository sessions,
conversation isolation and cleanup. DOM tests execute the actual compiled
webview script and check panel layout, keyboard submission, filters, safe links,
chat controls and MathML. SDK fixture tests also verify live commands, separate
output channels, available reasoning and deduplicated final responses.

To check activation in a real extension host, select **Test Arranged Agents
activation** in VS Code's Run and Debug view and press **F5**. On success it writes
`dist/scripts/extension-host-smoke-result.json` with the host versions and loaded
extension path. This tests the development extension, not installation of the VSIX.

### Validation status (2026-10-28)

Verified with Node.js **22.23.4**, Copilot CLI **1.0.105**, and VS Code's WSL remote
CLI **1.143.1**:

- `npm ci`, `npm run check`, and `npm run package` pass.
- `npm run smoke` reaches the authenticated local CLI, receives
  `ARRANGED_AGENTS_OK`, reads a repository file, and renders the result.
- `code --install-extension ./arranged-agents-0.1.0.vsix` succeeds; the installed
  extension is listed as `xadupre.arranged-agents@0.1.0`.
- Production dependencies have no reported advisories. The full audit reports
  four moderate entries in the development-only `vsce` → Azure Identity →
  MSAL → UUID chain. `npm audit --audit-level=high` passes. These are not shipped
  in the VSIX.

**Still pending:** interactive validation of the packaged three-panel application
inside VS Code, including Workspace Trust and visual equation layout. The remote
`code` command available during initial validation rejects
`--extensionDevelopmentPath` and `--extensionTestsPath`, so installation alone is
not evidence of activation. Use F5 for the activation check and **Install from
VSIX** for the packaged UI checks. Windows and macOS have not been tested.

## Scope and safeguards

- Repository discovery is one level deep, without following directory symlinks.
- Each clicked repository gets a separate CLI client/session and working directory.
  Switching tabs or repositories does not merge their conversation histories.
- No automatic workspace attachments or editor selections. Copilot can read
  repository files and send relevant context through its normal tools.
- Built-in agent tools, configuration/instruction discovery, skills and host Git
  context are enabled. Requested tool permissions require explicit confirmation;
  no blanket approval is granted. Repository file hooks and cross-session store
  integration remain disabled.
- Only the application's own nonce-authorized script runs. Model HTML is escaped,
  images are blocked and math cannot load external resources. Only HTTP/HTTPS
  links can open externally; executable and local-file URL schemes are blocked.
- The two-minute deadline applies to session startup and each response.
  **Cancel** stops that repository's session without affecting other repositories;
  click it again to start a fresh session. Earlier messages remain visible but
  are not replayed to the new session.
- Workspace Trust is required. The executable path is a machine-scoped setting.
- Closing the application or deactivating the extension stops all of its CLI
  processes, including requests still starting, then flushes the saved history.
  An interrupted-operation notice is retained. Resuming does not automatically
  continue pending commands or permission requests.
- Local application history is not encrypted or synced. Do not rely on it as a
  backup; simultaneous windows using the same parent share one snapshot, with
  the last saved window taking precedence.
- The SDK uses the installed CLI, not an embedded Copilot runtime. Normal CLI
  session persistence and service-side data policies still apply.

The SDK version is matched to Copilot CLI 1.0.104. Older CLI versions may require
an update. Transitive dependency overrides avoid known advisories in the SDK's
Zod dependency and a high-severity advisory in newer versions of the packager's
Azure authentication dependency. Keep the Azure Identity 4.13.0 override for now:
removing it selected 4.14.0 with a vulnerable MSAL Node 6.0.1
([GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)).
Revisit this pin when upstream resolves that chain; the retained UUID advisory
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq))
affects buffer handling in v3/v5/v6 UUID APIs. It does not affect the extension's
production dependencies.
The math plugin's KaTeX dependency is also overridden to a patched 0.19 release;
untrusted TeX commands remain disabled.

This is an unofficial project, not a GitHub product. A project license has not
yet been selected.
