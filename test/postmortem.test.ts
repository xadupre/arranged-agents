import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generatePostMortem,
  parsePostMortem,
  postMortemHash,
  postMortemSources,
  type PostMortemSource,
} from "../src/postmortem";

function source(): PostMortemSource {
  return {
    repository: {
      id: "/projects/alpha",
      path: "/projects/alpha",
      name: "Alpha",
    },
    sessionId: "task-session",
    messages: [
      { role: "user", content: "Implement the feature and submit its PR." },
      {
        role: "tool",
        title: "apply_patch - completed",
        content: "*** Add File: src/feature.ts\n+export const answer = 42;",
        details: '{"toolCallId":"edit"}',
      },
      { role: "tool", content: "npm test", title: "bash - completed" },
      { role: "output", content: "One test failed", error: true },
      {
        role: "assistant",
        content:
          "Corrected the edge case; tests now pass. PR #10, commit abcdef0123456789.",
      },
    ],
  };
}

function row(first: number, last: number) {
  return {
    first,
    last,
    phase: "Implementation, validation and delivery",
    objective: "Implement the requested feature",
    production: "Added code and corrected an edge case",
    filesAndCommits: "src/feature.ts; PR #10; abcdef0123456789",
    validation: "npm test: initially failed; agent later reported success",
    errors: "One test failed before correction",
  };
}

test("PostMortem groups all conversation evidence, preserves failed attempts and does not change sources", async () => {
  const input = source();
  const before = structuredClone(input);
  const report = await generatePostMortem(
    input,
    async (prompt) => {
      const entries = JSON.parse(prompt.split("\n").at(-1)!);
      assert.equal(entries.length, 5);
      assert.match(prompt, /untrusted reference data/);
      assert.ok(
        entries.some((entry: { text: string }) =>
          entry.text.includes("One test failed"),
        ),
      );
      return JSON.stringify({ rows: [row(1, entries.length)] });
    },
    new AbortController().signal,
  );
  assert.deepEqual(input, before);
  assert.equal(report.rows[0]?.firstMessage, 1);
  assert.equal(report.rows[0]?.lastMessage, 5);
  assert.equal(report.rows[0]?.filesAndCommits, row(1, 5).filesAndCommits);
  assert.deepEqual(
    postMortemSources(parsePostMortem(report), input.messages),
    input.messages,
  );
});

test("large messages are split into bounded batches without truncating commands, details or output", async () => {
  const input = source();
  input.messages[1]!.content = '\n\\"\u0000'.repeat(12_000);
  input.messages[1]!.details = "A large patch\n".repeat(5_000);
  const fragments: {
    message: number;
    part: number;
    parts: number;
    text: string;
  }[] = [];
  let calls = 0;
  const report = await generatePostMortem(
    input,
    async (prompt) => {
      calls++;
      const serialized = prompt.split("\n").at(-1)!;
      assert.ok(serialized.length <= 48_000);
      const entries = JSON.parse(serialized);
      fragments.push(...entries);
      return JSON.stringify({ rows: [row(1, entries.length)] });
    },
    new AbortController().signal,
  );
  assert.ok(calls > 1);
  for (const [index, original] of input.messages.entries()) {
    const parts = fragments.filter(
      (fragment) => fragment.message === index + 1,
    );
    assert.deepEqual(
      parts.map((part) => part.part),
      parts.map((_part, index) => index + 1),
    );
    assert.equal(parts[0]?.parts, parts.length);
    assert.deepEqual(
      JSON.parse(parts.map((part) => part.text).join("")),
      original,
    );
  }
  assert.equal(
    parsePostMortem(report).rows.at(-1)?.lastMessage,
    input.messages.length,
  );
});

test("invalid or incomplete model reports fail instead of hiding missing evidence", async () => {
  for (const response of [
    "Not JSON",
    JSON.stringify({ rows: [] }),
    JSON.stringify({ rows: [row(2, 5)] }),
    JSON.stringify({ rows: [row(1, 3)] }),
    JSON.stringify({ rows: [row(1, 4), row(4, 5)] }),
    JSON.stringify({ rows: [{ ...row(1, 5), production: null }] }),
  ]) {
    await assert.rejects(
      generatePostMortem(
        source(),
        async () => response,
        new AbortController().signal,
      ),
    );
  }
});

test("cancellation prevents further analysis and exports detect changed source records", async () => {
  const input = source();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generatePostMortem(
      input,
      async () => {
        assert.fail("Cancelled analysis must not call Copilot");
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  const report = await generatePostMortem(
    input,
    async () => JSON.stringify({ rows: [row(1, 5)] }),
    new AbortController().signal,
  );
  input.messages.push({ role: "user", content: "A later task" });
  assert.equal(postMortemSources(report, input.messages).length, 5);
  input.messages[1]!.content = "Changed evidence";
  assert.throws(
    () => postMortemSources(report, input.messages),
    /no longer matches/,
  );
  assert.notEqual(
    postMortemHash(input.messages.slice(0, 5)),
    report.sourceHash,
  );
});
