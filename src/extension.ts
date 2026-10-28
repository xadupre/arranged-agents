import * as vscode from "vscode";
import { AgentApplication, parseApplicationMessage } from "./application";
import { CopilotConversation } from "./conversation";
import { renderApplication, renderMarkdown, renderText } from "./render";
import { ApplicationStorage } from "./storage";
import { describePermission } from "./presentation";
import { GitHubPanel } from "./github-panel";
import { askCopilot, requestTimeoutMs } from "./copilot";
import { generatePostMortem, postMortemResponseSchema } from "./postmortem";
import { join } from "node:path";

let activePanel: vscode.WebviewPanel | undefined;
let closeActiveApplication: (() => Promise<void>) | undefined;
let opening: Promise<void> | undefined;
let deactivating = false;
const closing = new Set<Promise<void>>();

export function activate(context: vscode.ExtensionContext): void {
  deactivating = false;
  const output = vscode.window.createOutputChannel("Arranged Agents");
  const report = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    return message;
  };
  const openApplication = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust the workspace before running Arranged Agents.",
      );
      return;
    }
    if (activePanel) {
      activePanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    await Promise.all([...closing]);
    const root =
      vscode.workspace.workspaceFolders?.[0]?.uri ??
      (
        await vscode.window.showOpenDialog({
          title: "Choose the parent directory containing your Git repositories",
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
        })
      )?.[0];
    if (!root || deactivating) {
      return;
    }
    if (root.scheme !== "file") {
      throw new Error(
        "Arranged Agents requires a local directory in the extension host.",
      );
    }
    const configuration = vscode.workspace.getConfiguration("arrangedAgents");
    const requestTimeout = (): number =>
      requestTimeoutMs(
        vscode.workspace
          .getConfiguration("arrangedAgents")
          .get("requestTimeoutMinutes"),
      );
    const storage = new ApplicationStorage(
      context.globalStorageUri.fsPath,
      root.fsPath,
    );
    const saved = await storage.load();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let stopped: Promise<void> | undefined;
    const github = new GitHubPanel((update) => {
      if (panel) void panel.webview.postMessage(update);
    }, report);
    const saveFailure = (error: unknown): void => {
      void vscode.window.showErrorMessage(
        `Arranged Agents could not save its history: ${report(error)}`,
      );
    };
    const scheduleSave = (): void => {
      if (!saveTimer && !stopping) {
        saveTimer = setTimeout(() => {
          saveTimer = undefined;
          void storage.save(application.getSnapshot()).catch(saveFailure);
        }, 300);
      }
    };
    const application: AgentApplication = new AgentApplication(
      root.fsPath,
      (repository, requestId) =>
        new CopilotConversation({
          cliPath: configuration.get<string>("cliPath", "copilot"),
          model: configuration.get<string>("model", "").trim(),
          workingDirectory: repository.path,
          get timeoutMs() {
            return requestTimeout();
          },
          onPermissionRequest: async (request, invocation) => {
            if (!vscode.workspace.isTrusted || !panel) {
              return {
                kind: "reject",
                feedback: "The application is closed or untrusted.",
              };
            }
            const approved = await application.requestPermission(
              repository.id,
              describePermission(request, invocation.promptRequest),
              requestId,
            );
            return approved && panel && vscode.workspace.isTrusted
              ? { kind: "approve-once" }
              : {
                  kind: "reject",
                  feedback: "The user did not approve this operation.",
                };
          },
          onUserInputRequest: (request) => {
            if (!vscode.workspace.isTrusted || !panel) {
              throw new Error("The application is closed or untrusted.");
            }
            return application.askQuestion(repository.id, request, requestId);
          },
        }),
      () => {
        publish();
        scheduleSave();
      },
      saved,
    );
    const close = (): Promise<void> =>
      (stopped ??= (async () => {
        stopping = true;
        clearTimeout(saveTimer);
        try {
          await Promise.all([application.dispose(), github.dispose()]);
        } finally {
          await storage.save(application.getSnapshot());
        }
      })());
    let panel: vscode.WebviewPanel | undefined;
    const publish = (): void => {
      if (!panel) {
        return;
      }
      const state = application.getState();
      void panel.webview.postMessage({
        type: "state",
        state: {
          ...state,
          messages: state.messages.map((message) => ({
            ...message,
            html:
              message.role === "assistant" || message.role === "reasoning"
                ? renderMarkdown(message.content)
                : renderText(message.content),
          })),
        },
      });
    };
    await application.refresh();
    if (deactivating) {
      await close();
      return;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const scripts = vscode.Uri.joinPath(context.extensionUri, "dist", "src");
    panel = vscode.window.createWebviewPanel(
      "arrangedAgents.application",
      "Arranged Agents",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [media, scripts],
        retainContextWhenHidden: true,
      },
    );
    activePanel = panel;
    closeActiveApplication = close;
    const currentPanel = panel;
    const messageSubscription = panel.webview.onDidReceiveMessage(
      async (value: unknown) => {
        let repositoryId: string | undefined;
        try {
          if (!vscode.workspace.isTrusted) {
            throw new Error(
              "Trust the workspace before starting Copilot sessions.",
            );
          }
          const message = parseApplicationMessage(value);
          if ("id" in message) {
            repositoryId = message.id;
          }
          switch (message.type) {
            case "ready":
              publish();
              break;
            case "settings":
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "@ext:xadupre.arranged-agents",
              );
              break;
            case "refresh":
              await application.refresh();
              github.retain(
                new Set(
                  application
                    .getState()
                    .repositories.map((repository) => repository.id),
                ),
              );
              break;
            case "github": {
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository)
                throw new Error("Unknown repository for GitHub activity.");
              await github.load(repository, message.section, message.cursor);
              break;
            }
            case "select":
              await application.select(message.id);
              break;
            case "send":
              await application.send(
                message.id,
                message.question,
                message.parallel,
              );
              break;
            case "postmortem":
              await application.createPostMortem(message.id, (source, signal) =>
                generatePostMortem(
                  source,
                  (prompt, signal) =>
                    askCopilot(prompt, {
                      cliPath: configuration.get<string>("cliPath", "copilot"),
                      model: configuration.get<string>("model", "").trim(),
                      workingDirectory: source.repository.path,
                      signal,
                      timeoutMs: requestTimeout(),
                      analysisOnly: true,
                      responseSchema: postMortemResponseSchema,
                    }),
                  signal,
                ),
              );
              await storage.save(application.getSnapshot());
              break;
            case "export-postmortem": {
              const json = application.exportPostMortem(message.id);
              const destination = await vscode.window.showSaveDialog({
                title: "Export PostMortem",
                saveLabel: "Export JSON",
                filters: { JSON: ["json"] },
                defaultUri: vscode.Uri.file(
                  join(root.fsPath, "postmortem.json"),
                ),
              });
              if (destination)
                await vscode.workspace.fs.writeFile(
                  destination,
                  Buffer.from(json, "utf8"),
                );
              break;
            }
            case "cancel":
              application.cancel(message.id);
              break;
            case "draft":
              application.setDraft(message.id, message.text);
              break;
            case "permission":
              application.respondToPermission(message.id, message.approve);
              break;
            case "answer":
              application.answerQuestion(message.id, message.answer);
              break;
            case "restart":
              await application.restart(message.id);
              break;
            case "close-session":
              await application
                .closeSession(message.id)
                .finally(() => storage.save(application.getSnapshot()));
              break;
            case "new-session":
              await application
                .newSession(message.id)
                .finally(() => storage.save(application.getSnapshot()));
              break;
            case "delete-last-session":
            case "delete-all-sessions":
              await application
                .deleteSessions(
                  message.id,
                  message.type === "delete-all-sessions",
                )
                .finally(() => storage.save(application.getSnapshot()));
              break;
            case "openExternal":
              if (
                !(await vscode.env.openExternal(vscode.Uri.parse(message.url)))
              ) {
                throw new Error(`Could not open link: ${message.url}`);
              }
              break;
          }
        } catch (error) {
          const message = report(error);
          if (panel) {
            const state = application.getState();
            await panel.webview.postMessage({
              type: "error",
              id: state.repositories.some(
                (repository) => repository.id === repositoryId,
              )
                ? repositoryId
                : undefined,
              message:
                state.activeId === repositoryId && state.error
                  ? state.error
                  : message,
            });
          }
        }
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      messageSubscription.dispose();
      if (activePanel === currentPanel) {
        activePanel = undefined;
        closeActiveApplication = undefined;
      }
      const stop = close();
      closing.add(stop);
      void stop.then(
        () => closing.delete(stop),
        (error: unknown) => {
          closing.delete(stop);
          saveFailure(error);
        },
      );
    });
    panel.webview.html = renderApplication({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(scripts, "webview.js"))
        .toString(),
      styleUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(media, "app.css"))
        .toString(),
    });
  };
  const open = async (): Promise<void> => {
    try {
      opening ??= openApplication().finally(() => {
        opening = undefined;
      });
      await opening;
    } catch (error) {
      await vscode.window.showErrorMessage(`Arranged Agents: ${report(error)}`);
    }
  };
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("arrangedAgents.open", open),
    vscode.commands.registerCommand("arrangedAgents.ask", open),
    { dispose: () => activePanel?.dispose() },
  );
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    void open();
  }
}

export async function deactivate(): Promise<void> {
  deactivating = true;
  await Promise.all([
    ...closing,
    ...(closeActiveApplication ? [closeActiveApplication()] : []),
  ]);
}
