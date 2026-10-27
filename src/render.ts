import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.renderer.rules.link_open = () => "<span>";
markdown.renderer.rules.link_close = () => "</span>";
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content ?? "");

export function renderResult(question: string, answer: string): string {
  const nonce = randomUUID();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<title>Arranged Agents</title>
<style nonce="${nonce}">
body { max-width: 900px; margin: 0 auto; padding: 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); line-height: 1.6; overflow-wrap: anywhere; }
header { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 24px; }
pre { padding: 16px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
code { font-family: var(--vscode-editor-font-family); }
table { border-collapse: collapse; }
th, td { padding: 8px; border: 1px solid var(--vscode-panel-border); }
blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin-left: 0; padding-left: 16px; }
</style>
</head>
<body>
<header><h1>Arranged Agents</h1><p>${markdown.utils.escapeHtml(question)}</p></header>
<main>${markdown.render(answer)}</main>
</body>
</html>`;
}
