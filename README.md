# Arranged Agents

A VS Code extension that asks your **locally installed GitHub Copilot CLI** a
question and presents its answer as structured Markdown in a side panel.

## Requirements

- VS Code 1.105 or newer.
- Node.js 22.13 or newer for development.
- GitHub Copilot CLI installed and authenticated: run `copilot login`.
- A GitHub account with access to Copilot. Requests use your Copilot allowance.

The CLI runs locally, but model requests still go to GitHub Copilot: this is not
an offline model. No separate API key is required.

## Try it

```bash
npm ci --omit=optional
npm run compile
```

Open this directory in VS Code and press **F5**. In the Extension Development
Host, run **Arranged Agents: Ask Copilot** from the Command Palette.
Enter a question; if you selected text, explicitly choose whether to include it.
The response opens beside your editor. The progress notification allows cancellation.

If VS Code cannot find `copilot`, set `arrangedAgents.cliPath` to its absolute
executable path. Optionally set `arrangedAgents.model` to a supported model ID.
In Remote SSH, WSL, or a dev container, the CLI must be installed and authenticated
on the machine hosting the workspace extension.

## Checks and packaging

```bash
npm run check
npm run package
code --install-extension ./arranged-agents-0.1.0.vsix
```

The resulting `.vsix` can be installed with VS Code's **Install from VSIX** command.
To test the real local CLI connection, run `npm run smoke`. This sends one model
request and requires your existing Copilot login; it is not part of CI.
The smoke test uses an empty temporary working directory, not the source checkout.
Packaging uses the supported `--skip-license` policy while the project remains
`UNLICENSED`; this does not grant a license or publish to the Marketplace.

The unit tests also run the real SDK against a small local stdio CLI fixture:
they cover PATH lookup, missing CLI, authentication/model errors, empty answers,
and cancellation/timeouts during startup, session creation, generation, and
shutdown. They verify that each child process exits. No model requests are made
by `npm run check`.

To check activation in a real extension host, select **Test Arranged Agents
activation** in VS Code's Run and Debug view and press **F5**. On success it writes
`dist/scripts/extension-host-smoke-result.json` with the host versions and loaded
extension path. This tests the development extension, not installation of the VSIX.

### Validation status (2026-10-28)

Verified with Node.js **24.22.1**, Copilot CLI **1.0.105**, and VS Code's WSL remote
CLI **1.143.1**:

- `npm ci --omit=optional`, `npm run check` (21 tests), and `npm run package` pass.
- `npm run smoke` reaches the authenticated local CLI, receives
  `ARRANGED_AGENTS_OK`, and renders the result.
- `code --install-extension ./arranged-agents-0.1.0.vsix` succeeds; the installed
  extension is listed as `xadupre.arranged-agents@0.1.0`.
- Production dependencies have no reported advisories. The full audit reports
  four moderate entries in the development-only `vsce` → Azure Identity →
  MSAL → UUID chain. `npm audit --audit-level=high` passes. These are not shipped
  in the VSIX.

**Still pending:** actual extension-host activation and interactive validation of
the packaged extension: formatted side panel, selection consent/question-only
requests, overlapping requests, cancellation/deactivation, Workspace Trust, and
resource blocking. The remote `code` command available during validation rejects
`--extensionDevelopmentPath` and `--extensionTestsPath`, so installation alone is
not evidence of activation. Use F5 for the activation check and **Install from
VSIX** for the packaged UI checks. Windows and macOS have not been tested.

## Scope and safeguards

- One question and one result panel per request; no conversation history UI yet.
- No automatic workspace attachments; only your question and an explicitly
  approved selection are sent.
- Agent tools, configuration discovery, file hooks, skills, and host git context
  are disabled. The extension cannot apply model-proposed edits or run commands.
- Results render without scripts, active links, or images. A restrictive Content
  Security Policy prevents remote resource loading.
- Workspace Trust is required. The executable path is a machine-scoped setting.
- Cancellation and the two-minute request deadline cover CLI startup, session
  creation, generation, and cleanup. Deactivation waits for an active CLI request
  to stop; a stalled CLI is forcibly terminated.
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

This is an unofficial project, not a GitHub product. A project license has not
yet been selected.
