import * as vscode from "vscode";
import { askCopilot } from "./copilot";
import { buildPrompt, MAX_SELECTION_LENGTH, validateQuestion } from "./prompt";
import { renderResult } from "./render";

let activeRequest: AbortController | undefined;
let activeOperation: Promise<string> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Arranged Agents");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("arrangedAgents.ask", async () => {
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showWarningMessage(
          "Trust the workspace before running Arranged Agents.",
        );
        return;
      }
      if (activeRequest) {
        await vscode.window.showWarningMessage(
          "A Copilot request is already running. Cancel it or wait for its answer.",
        );
        return;
      }
      const controller = new AbortController();
      activeRequest = controller;
      try {
        const editor = vscode.window.activeTextEditor;
        if (
          editor &&
          editor.document.offsetAt(editor.selection.end) -
            editor.document.offsetAt(editor.selection.start) >
            MAX_SELECTION_LENGTH
        ) {
          throw new Error(
            "The selected text is too large. Select a smaller excerpt or clear the selection.",
          );
        }
        const selection = editor?.document.getText(editor.selection);
        const question = await vscode.window.showInputBox({
          title: "Arranged Agents",
          prompt: "What would you like Copilot to organize or explain?",
          ignoreFocusOut: true,
          validateInput: validateQuestion,
        });
        if (question === undefined) {
          return;
        }
        let includedSelection: string | undefined;
        if (selection) {
          const choice = await vscode.window.showInformationMessage(
            "Send the selected text to GitHub Copilot with your question?",
            {
              modal: true,
              detail: "No other workspace files will be attached.",
            },
            "Include selection",
            "Question only",
          );
          if (choice === undefined) {
            return;
          }
          if (choice === "Include selection") {
            includedSelection = selection;
          }
        }
        const prompt = buildPrompt(question, includedSelection);
        const configuration =
          vscode.workspace.getConfiguration("arrangedAgents");
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        const answer = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Arranged Agents: asking Copilot",
            cancellable: true,
          },
          async (_progress, cancellation) => {
            const subscription = cancellation.onCancellationRequested(() =>
              controller.abort(),
            );
            if (cancellation.isCancellationRequested) {
              controller.abort();
            }
            try {
              activeOperation = askCopilot(prompt, {
                cliPath: configuration.get<string>("cliPath", "copilot"),
                model: configuration.get<string>("model", "").trim(),
                workingDirectory: context.globalStorageUri.fsPath,
                signal: controller.signal,
              });
              return await activeOperation;
            } finally {
              activeOperation = undefined;
              subscription.dispose();
            }
          },
        );
        const panel = vscode.window.createWebviewPanel(
          "arrangedAgents.result",
          "Arranged Agents",
          vscode.ViewColumn.Beside,
          { enableScripts: false, localResourceRoots: [] },
        );
        panel.webview.html = renderResult(question, answer);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(message);
        await vscode.window.showErrorMessage(
          `Arranged Agents: ${message}. Check that your local Copilot CLI is installed and authenticated (copilot login).`,
        );
      } finally {
        activeRequest = undefined;
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  activeRequest?.abort();
  if (activeOperation) {
    await Promise.allSettled([activeOperation]);
  }
}
