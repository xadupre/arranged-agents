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
```

The resulting `.vsix` can be installed with VS Code's **Install from VSIX** command.
To test the real local CLI connection, run `npm run smoke`. This sends one model
request and requires your existing Copilot login; it is not part of CI.

## Scope and safeguards

- One question and one result panel per request; no conversation history UI yet.
- No automatic workspace attachments; only your question and an explicitly
  approved selection are sent.
- Agent tools, configuration discovery, file hooks, skills, and host git context
  are disabled. The extension cannot apply model-proposed edits or run commands.
- Results render without scripts, active links, or images. A restrictive Content
  Security Policy prevents remote resource loading.
- Workspace Trust is required. The executable path is a machine-scoped setting.
- The SDK uses the installed CLI, not an embedded Copilot runtime. Normal CLI
  session persistence and service-side data policies still apply.

The SDK version is matched to Copilot CLI 1.0.104. Older CLI versions may require
an update. Transitive dependency overrides avoid known advisories in the SDK's
Zod dependency and the packager's Azure authentication dependency; revisit them
when those upstream packages update.

This is an unofficial project, not a GitHub product. A project license has not
yet been selected.
