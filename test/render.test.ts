import assert from "node:assert/strict";
import { test } from "node:test";
import { renderResult } from "../src/render";

test("renders structured Markdown and code blocks", () => {
  const html = renderResult(
    "Explain this",
    "## Summary\n\n- One\n- Two\n\n```ts\nconst answer = 42;\n```",
  );
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<li>One<\/li>/);
  assert.match(html, /<code class="language-ts">const answer = 42;/);
});

test("escapes untrusted prompt and answer HTML", () => {
  const html = renderResult(
    "</p><script>alert(1)</script>",
    '<img src="https://attacker.invalid/secret" onerror="alert(1)">',
  );
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test("does not turn model links or images into active resources", () => {
  const html = renderResult(
    "Links",
    "[Run](command:workbench.action.terminal.new)\n\n" +
      "[External](https://example.com)\n\n" +
      "![secret](https://attacker.invalid/collect)",
  );
  assert.doesNotMatch(html, /<a\b|<img\b|href=|src=/);
  assert.match(html, /External/);
  assert.match(html, /secret/);
  const nonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`default-src 'none'; style-src 'nonce-${nonce}'`));
});
