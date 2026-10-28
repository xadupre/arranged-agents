import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { askCopilot, type CopilotOptions } from "../src/copilot";
import { waitForRequest } from "./helpers";

const fixture = join(__dirname, "fixtures", "copilot.js");

async function setup(
  t: TestContext,
  scenario = "success",
): Promise<CopilotOptions> {
  const directory = await mkdtemp(join(tmpdir(), "arranged-agents-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "scenario"), scenario);
  return { cliPath: fixture, workingDirectory: directory, timeoutMs: 5_000 };
}

async function assertStopped(options: CopilotOptions): Promise<void> {
  const pid = Number(
    await readFile(join(options.workingDirectory, "pid"), "utf8"),
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("resolves the CLI through PATH and preserves repository tools, Git context and native instructions", async (t) => {
  const options = await setup(t);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dirname(fixture)}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  });
  assert.equal(
    await askCopilot("Question only", {
      ...options,
      cliPath: basename(fixture),
    }),
    "## Fixture answer",
  );
  const requests: { method: string; params: Record<string, unknown> }[] = (
    await readFile(join(options.workingDirectory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  const create = requests.find(
    (request) => request.method === "session.create",
  );
  assert.ok(create);
  assert.equal(create.params.workingDirectory, options.workingDirectory);
  assert.equal(create.params.availableTools, undefined);
  assert.equal(create.params.interactiveUser, true);
  for (const flag of [
    "enableConfigDiscovery",
    "enableHostGitOperations",
    "enableSkills",
    "enableOnDemandInstructionDiscovery",
  ]) {
    assert.equal(create.params[flag], true, flag);
  }
  for (const flag of ["enableFileHooks", "enableSessionStore"]) {
    assert.equal(create.params[flag], false, flag);
  }
  assert.equal(
    (create.params.systemMessage as { mode: string }).mode,
    "append",
  );
  const send = requests.find(
    (request) => request.method === "session.sendAndWait",
  );
  assert.ok(send);
  assert.equal(send.params.prompt, "Question only");
  assert.equal(send.params.attachments, undefined);
  await assertStopped(options);
});

for (const approve of [false, true]) {
  test(`repository tool permission is ${approve ? "approved by the host" : "denied without a host confirmation"}`, async (t) => {
    const options = await setup(t, "permission");
    let confirmations = 0;
    const answer = await askCopilot("Read the repository", {
      ...options,
      onPermissionRequest: approve
        ? (request) => {
            assert.equal(request.kind, "read");
            confirmations++;
            return { kind: "approve-once" };
          }
        : undefined,
    });
    assert.equal(
      answer,
      approve ? "Repository access approved" : "Repository access denied",
    );
    assert.equal(confirmations, approve ? 1 : 0);
    await assertStopped(options);
  });
}

for (const stage of [
  "connect",
  "session.create",
  "session.sendAndWait",
  "session.detach",
  "runtime.shutdown",
]) {
  test(`cancels a CLI stuck in ${stage} and reaps its child process`, async (t) => {
    const options = await setup(t, `hang:${stage}`);
    const controller = new AbortController();
    const result = askCopilot("Question", {
      ...options,
      signal: controller.signal,
    });
    const rejected = assert.rejects(result, { name: "AbortError" });
    try {
      await waitForRequest(options.workingDirectory, stage);
    } finally {
      controller.abort();
      await rejected;
    }
    await assertStopped(options);
  });

  test(`times out a CLI stuck in ${stage} and reaps its child process`, async (t) => {
    const options = await setup(t, `hang:${stage}`);
    await assert.rejects(
      askCopilot("Question", { ...options, timeoutMs: 2_000 }),
      /timed out|Timeout/,
    );
    await assertStopped(options);
  });
}

for (const [scenario, model, expected] of [
  ["unauthenticated", undefined, /Not authenticated/],
  ["success", "invalid-model", /Invalid model/],
  ["empty", undefined, /returned no answer/],
] as const) {
  test(`reports ${scenario === "success" ? model : scenario} errors and reaps the CLI`, async (t) => {
    const options = await setup(t, scenario);
    await assert.rejects(
      askCopilot("Question", { ...options, model }),
      expected,
    );
    await assertStopped(options);
  });
}

test("rejects a missing CLI and a pre-cancelled request without spawning", async (t) => {
  const options = await setup(t);
  await assert.rejects(
    askCopilot("Question", {
      ...options,
      cliPath: join(options.workingDirectory, "missing-cli"),
    }),
    /executable not found/,
  );
  await assert.rejects(
    askCopilot("Question", {
      ...options,
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
  await assert.rejects(readFile(join(options.workingDirectory, "pid")), {
    code: "ENOENT",
  });
});
