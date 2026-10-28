import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationRenderer,
  renderMarkdown,
  renderResult,
  renderText,
} from "../src/render";
import { describePermission, describeTool } from "../src/presentation";
import type { ChatMessage } from "../src/application";

test("cached conversation HTML follows edited content and roles while retaining fresh metadata and avoiding stale session entries", () => {
  const renderer = new ConversationRenderer();
  const messages: ChatMessage[] = [
    { role: "assistant", content: "**Answer**", title: "Draft" },
    { role: "tool", content: "npm test", details: "Pending" },
  ];
  const before = renderer.render("alpha", messages);
  messages[0]!.title = "Final";
  messages[1]!.details = "Completed";
  const metadata = renderer.render("alpha", messages);
  assert.equal(metadata[0]?.html, before[0]?.html);
  assert.equal(metadata[0]?.title, "Final");
  assert.equal(metadata[1]?.details, "Completed");
  messages[0]!.role = "tool";
  assert.equal(renderer.render("alpha", messages)[0]?.html, "**Answer**");
  messages[0]!.content = "<script>not executable</script>";
  assert.doesNotMatch(renderer.render("alpha", messages)[0]!.html, /<script>/);
  assert.equal(renderer.render("alpha", []).length, 0);
  assert.deepEqual(
    renderer.render("beta", [{ role: "assistant", content: "New session" }]),
    [
      {
        role: "assistant",
        content: "New session",
        html: renderMarkdown("New session"),
      },
    ],
  );
});

test("tool and approval summaries show readable commands, paths and warnings without JSON", () => {
  assert.equal(
    describeTool("read", { path: "README.md", viewRange: [1, 10] }),
    "Path: README.md\nView Range: 1\n10",
  );
  assert.equal(
    describeTool("bash", { command: "git status\nprintf done" }),
    "git status\nprintf done",
  );
  const permission = describePermission({
    kind: "read",
    path: "../private",
    intention: "Inspect instructions",
    requestSandboxBypass: true,
    requestSandboxBypassReason: "Outside the workspace",
  });
  assert.equal(permission.summary, "Read this file or directory?");
  assert.match(permission.content, /Inspect instructions\n\n\.\.\/private/);
  assert.match(permission.content, /Warning:.*outside the sandbox/);
  assert.match(permission.content, /Outside the workspace/);
  assert.doesNotMatch(permission.content, /"kind"|[{}]/);
  assert.match(permission.details, /"kind": "read"/);
  const write = describePermission({
    kind: "write",
    canOfferSessionApproval: false,
    fileName: "README.md",
    intention: "Update documentation",
    diff: "-old\n+new",
  });
  assert.equal(
    write.content,
    "Update documentation\n\nREADME.md\n\n-old\n+new",
  );
});

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
