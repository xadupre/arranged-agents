import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, renderResult, renderText } from "../src/render";

test("renders structured Markdown and code blocks", () => {
  const html = renderResult(
    "Explain this",
    "## Summary\n\n- One\n- Two\n\n```ts\nconst answer = 42;\n```",
  );
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<li>One<\/li>/);
  assert.match(html, /<code class="language-ts">const answer = 42;/);
});

test("renders inline and display equations as native MathML without external assets", () => {
  const html = renderMarkdown("Inline $x^2$.\n\n$$\\frac{a}{b}=\\sqrt{c}$$");
  assert.equal((html.match(/<math\b/g) ?? []).length, 2);
  assert.match(html, /display="block"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.doesNotMatch(html, /<script|<link|<img|src=/);
});

test("math cannot turn trusted TeX commands into active links or remote images", () => {
  const html = renderMarkdown(
    "$\\href{https://attacker.invalid}{click}$\n\n" +
      "$\\includegraphics{https://attacker.invalid/image}$\n\n" +
      "$\\notacommand$",
  );
  assert.doesNotMatch(html, /<a\b|<img\b|<script\b|href=|src=/);
  assert.match(html, /notacommand/);
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

test("plain tool output preserves command syntax and only linkifies safe URLs", () => {
  const html = renderText(
    "echo *literal*\n<script>bad()</script>\nhttps://example.com/log\ncommand:run",
  );
  assert.match(html, /echo \*literal\*\n&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com\/log"/);
  assert.doesNotMatch(html, /<script|<em>|href="command:/);
});

test("renders clickable HTTP URLs but blocks executable links and remote images", () => {
  const html = renderResult(
    "Links",
    "[Run](command:workbench.action.terminal.new)\n\n" +
      "[External](https://example.com)\n\n" +
      "http://example.org/path\n\n" +
      "[Script](javascript:alert(1))\n\n" +
      "[Local](file:///etc/passwd)\n\n" +
      "[Editor](vscode://some.extension/action)\n\n" +
      "![secret](https://attacker.invalid/collect)",
  );
  assert.match(
    html,
    /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">External<\/a>/,
  );
  assert.match(html, /href="http:\/\/example.org\/path"/);
  assert.doesNotMatch(
    html,
    /href="(?:command:|javascript:|file:|vscode:)|<img\b|src=/,
  );
  assert.match(html, /secret/);
  const nonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`default-src 'none'; style-src 'nonce-${nonce}'`));
});
