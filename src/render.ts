import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import math from "@vscode/markdown-it-katex";
import { isExternalUrl } from "./links";

const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.use(math, {
  output: "mathml",
  trust: false,
  strict: "error",
  throwOnError: false,
  maxExpand: 1_000,
  maxSize: 20,
  enableFencedBlocks: true,
});
markdown.validateLink = isExternalUrl;
markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  _env,
  renderer,
) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content ?? "");

export function renderMarkdown(content: string): string {
  return markdown.render(content);
}

export function renderText(content: string): string {
  const escape = markdown.utils.escapeHtml;
  let html = "";
  let offset = 0;
  for (const match of markdown.linkify.match(content) ?? []) {
    html += escape(content.slice(offset, match.index));
    html += isExternalUrl(match.url)
      ? `<a href="${escape(match.url)}" target="_blank" rel="noopener noreferrer">${escape(match.text)}</a>`
      : escape(match.text);
    offset = match.lastIndex;
  }
  return html + escape(content.slice(offset));
}

export function renderApplication(resources: {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const nonce = randomUUID();
  const escape = markdown.utils.escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${escape(resources.cspSource)}; base-uri 'none'; form-action 'none';">
<title>Arranged Agents</title>
<link rel="stylesheet" href="${escape(resources.styleUri)}">
</head>
<body>
<main class="application">
  <aside id="left-panel" aria-label="Repository activity">
    <nav id="github-tabs" aria-label="Repository activity views">
      <button type="button" data-section="issues" aria-pressed="true">Issues</button>
      <button type="button" data-section="reviews" aria-pressed="false">Reviews</button>
      <button type="button" data-section="commits" aria-pressed="false">Commits</button>
      <button type="button" data-section="comments" aria-pressed="false">Comments</button>
    </nav>
    <div class="github-toolbar">
      <h2 id="github-heading">Issues</h2>
      <button id="github-refresh" type="button" disabled>Refresh</button>
    </div>
    <p id="github-status" role="status">Select a repository to view its activity.</p>
    <p id="github-notice" class="repository-hint" hidden></p>
    <p id="github-error" role="alert" hidden></p>
    <div id="github-items"></div>
    <button id="github-more" type="button" hidden>Load more</button>
  </aside>
  <div id="left-divider" class="divider" role="separator" aria-label="Resize left panel" aria-orientation="vertical" aria-controls="left-panel chat-panel" tabindex="0"></div>
  <section id="chat-panel" aria-label="Copilot conversation">
    <header class="chat-header">
      <div class="chat-heading">
        <h2 id="active-repository">Select a repository on the right</h2>
        <p class="session-activity" role="status"><span id="activity-icon" class="spinner" aria-hidden="true" hidden></span><span id="session-status">No Copilot session has started.</span></p>
        <button id="postmortem" type="button" disabled title="Analyse the whole selected conversation after its work finishes">PostMortem</button>
        <button id="settings" type="button" title="Open Arranged Agents settings">Settings</button>
      </div>
      <fieldset id="information-filters">
        <legend>Show information</legend>
        <label><input type="checkbox" value="messages" checked> Messages</label>
        <label><input type="checkbox" value="tools" checked> Commands / tools</label>
        <label><input type="checkbox" value="reasoning"> Reasoning</label>
        <label><input type="checkbox" value="output"> Output</label>
        <label><input type="checkbox" value="system"> Session / events (JSON)</label>
      </fieldset>
    </header>
    <div id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
    <section id="postmortem-report" aria-label="Conversation PostMortem" hidden>
      <div class="postmortem-toolbar">
        <h2>PostMortem</h2>
        <button id="export-postmortem" type="button" disabled>Export JSON</button>
      </div>
      <p id="postmortem-status" role="status"></p>
      <p id="postmortem-error" role="alert" hidden></p>
      <div id="postmortem-table"></div>
    </section>
    <div id="interactions">
      <section id="permissions" aria-label="Tool permissions" hidden></section>
      <section id="questions" aria-label="Questions from Copilot" hidden></section>
    </div>
    <p id="error" role="alert" hidden></p>
    <form id="composer">
      <label for="question">Message to Copilot</label>
      <textarea id="question" rows="4" maxlength="20000" placeholder="Select a repository to begin." disabled></textarea>
      <div class="composer-actions">
        <span>Enter to send; Shift+Enter for a new line. Math: $x^2$ or $$E=mc^2$$</span>
        <button id="restart" type="button" title="Start fresh without replaying the displayed history" hidden>New session</button>
        <button id="cancel" type="button" disabled>Cancel</button>
        <button id="parallel" type="button" aria-pressed="true" title="ON: send independently while work continues (actions allowed). OFF: wait until current work finishes. Parallel actions share the same files.">Parallel ON</button>
        <button id="send" type="submit" disabled>Send</button>
      </div>
    </form>
  </section>
  <div id="right-divider" class="divider" role="separator" aria-label="Resize repository panel" aria-orientation="vertical" aria-controls="chat-panel repository-panel" tabindex="0"></div>
  <aside id="repository-panel" aria-label="Repository sessions">
    <header><h2>Repositories</h2><button id="refresh" type="button">Refresh</button></header>
    <p id="root"></p>
    <div id="repositories">
      <section class="repository-group" aria-labelledby="started-repositories-title">
        <h3 id="started-repositories-title">Active sessions</h3>
        <div id="started-repositories"></div>
      </section>
      <section class="repository-group" aria-labelledby="other-repositories-title">
        <h3 id="other-repositories-title">Other repositories</h3>
        <div id="other-repositories"></div>
      </section>
    </div>
    <p class="repository-hint">Only direct child directories containing .git are listed. Click one to start its session.</p>
  </aside>
</main>
<div id="repository-menu" role="menu" aria-label="Repository session actions" hidden></div>
<script nonce="${nonce}" src="${escape(resources.scriptUri)}"></script>
</body>
</html>`;
}

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
<main>${renderMarkdown(answer)}</main>
</body>
</html>`;
}
