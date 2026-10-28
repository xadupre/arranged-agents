import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AgentApplication,
  parseApplicationMessage,
  type ApplicationState,
} from "../src/application";
import { CopilotConversation } from "../src/conversation";
import { ApplicationStorage, type SavedApplication } from "../src/storage";
import { waitForRequest } from "./helpers";

async function setup(
  t: TestContext,
  scenario = "conversation",
  timeoutMs = 5_000,
) {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-application-"));
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(root, name, ".git"), { recursive: true });
    await writeFile(join(root, name, "scenario"), scenario);
  }
  let changes = 0;
  const snapshots: ApplicationState[] = [];
  const updates = new EventEmitter();
  const applications: AgentApplication[] = [];
  const createApplication = (saved?: SavedApplication): AgentApplication => {
    const application: AgentApplication = new AgentApplication(
      root,
      (repository) =>
        new CopilotConversation({
          cliPath: join(__dirname, "fixtures", "copilot.js"),
          workingDirectory: repository.path,
          timeoutMs,
          onPermissionRequest: async (request, invocation) => ({
            kind: (await application.requestPermission(
              repository.id,
              request.kind,
              JSON.stringify(invocation.promptRequest ?? request, null, 2),
            ))
              ? "approve-once"
              : "reject",
          }),
        }),
      () => {
        changes++;
        snapshots.push(application.getState());
        updates.emit("change");
      },
      saved,
    );
    applications.push(application);
    return application;
  };
  const application = createApplication();
  t.after(async () => {
    await Promise.all(applications.map((application) => application.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  await application.refresh();
  return {
    application,
    root,
    changes: () => changes,
    snapshots,
    createApplication,
    waitForPermission: async (repositoryId: string) => {
      for (;;) {
        const request = application
          .getState()
          .permissions.find((entry) => entry.repositoryId === repositoryId);
        if (request) {
          return request;
        }
        await once(updates, "change");
      }
    },
  };
}

async function requests(directory: string): Promise<{ method: string }[]> {
  return (await readFile(join(directory, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

async function pid(directory: string): Promise<number> {
  return Number(await readFile(join(directory, "pid"), "utf8"));
}

test("repository sessions start only on click, persist across switches, and keep conversations isolated", async (t) => {
  const { application, root, changes } = await setup(t);
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  assert.ok(changes() > 0);
  assert.ok(
    application
      .getState()
      .repositories.every((repository) => repository.status === "idle"),
  );
  for (const directory of [alpha, beta]) {
    await assert.rejects(readFile(join(directory, "pid")), { code: "ENOENT" });
  }
  await Promise.all([application.select(alpha), application.select(alpha)]);
  await application.send(alpha, "Remember ALPHA.");
  await application.select(beta);
  assert.deepEqual(application.getState().messages, []);
  await application.send(beta, "Remember BETA.");
  await application.select(alpha);
  await application.send(alpha, "What did I say?");
  const history = application.getState().messages;
  assert.equal(history.length, 4);
  assert.match(history[3]?.content ?? "", /ALPHA[\s\S]*What did I say/);
  assert.doesNotMatch(history[3]?.content ?? "", /BETA/);
  for (const directory of [alpha, beta]) {
    assert.equal(
      (await requests(directory)).filter(
        (request) => request.method === "session.create",
      ).length,
      1,
    );
  }
  const pids = await Promise.all([pid(alpha), pid(beta)]);
  await application.dispose();
  for (const child of pids) {
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  }
});

test("inline permissions wait for an explicit decision and stay isolated across background repositories", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  const alphaAnswer = application.send(alpha, "Read Alpha");
  const alphaPermission = await waitForPermission(alpha);
  assert.equal(alphaPermission.kind, "read");
  assert.match(alphaPermission.details, /README.md/);
  assert.equal(
    (await requests(alpha)).filter(
      (request) =>
        request.method === "session.permissions.handlePendingPermissionRequest",
    ).length,
    0,
  );
  await application.select(beta);
  const betaAnswer = application.send(beta, "Read Beta");
  const betaPermission = await waitForPermission(beta);
  assert.notEqual(alphaPermission.id, betaPermission.id);
  assert.equal(application.getState().permissions.length, 2);
  application.respondToPermission(alphaPermission.id, true);
  await alphaAnswer;
  assert.deepEqual(application.getState().permissions, [betaPermission]);
  assert.throws(
    () => application.respondToPermission(alphaPermission.id, true),
    /no longer pending/,
  );
  application.respondToPermission(betaPermission.id, false);
  await betaAnswer;
  assert.deepEqual(application.getState().permissions, []);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /access denied/,
  );
  await application.select(alpha);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /access approved/,
  );
});

test("cancellation, closure, failure and repository removal clear pending approvals without approving", async (t) => {
  for (const action of ["cancel", "close", "timeout", "remove"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForPermission } = await setup(
        t,
        "permission",
        action === "timeout" ? 1_500 : 5_000,
      );
      const alpha = join(root, "alpha");
      await application.select(alpha);
      const running = application.send(alpha, "Wait for approval");
      const rejected = assert.rejects(
        running,
        action === "timeout" ? /timed out/ : { name: "AbortError" },
      );
      const request = await waitForPermission(alpha);
      const extra = application.requestPermission(alpha, "shell", "echo test");
      if (action === "cancel") {
        application.cancel(alpha);
      } else if (action === "close") {
        await application.dispose();
      } else if (action === "remove") {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      }
      await rejected;
      assert.equal(await extra, false);
      assert.deepEqual(application.getState().permissions, []);
      assert.throws(
        () => application.respondToPermission(request.id, true),
        /closed|no longer pending/,
      );
    });
  }
});

test("closing and reopening restores histories, drafts and SDK context lazily for each repository", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  await application.send(alpha, "Remember ALPHA.");
  application.setDraft(alpha, "Alpha unfinished draft");
  await application.select(beta);
  await application.send(beta, "Remember BETA.");
  application.setDraft(beta, "Beta unfinished draft");
  const pids = await Promise.all([pid(alpha), pid(beta)]);
  await application.dispose();
  for (const child of pids) {
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  }
  const storage = new ApplicationStorage(join(root, "extension storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(restored.getState().activeId, beta);
  assert.equal(restored.getState().draft, "Beta unfinished draft");
  assert.ok(
    restored
      .getState()
      .messages.some((message) => message.content.includes("BETA")),
  );
  assert.ok(
    restored
      .getState()
      .repositories.every((repository) => repository.status === "saved"),
  );
  for (const directory of [alpha, beta]) {
    assert.equal(
      (await requests(directory)).filter(
        (request) => request.method === "session.resume",
      ).length,
      0,
    );
  }
  await restored.select(alpha);
  assert.equal(restored.getState().draft, "Alpha unfinished draft");
  await restored.send(alpha, "What did I say?");
  const answer = restored.getState().messages.at(-1)?.content ?? "";
  assert.match(answer, /ALPHA[\s\S]*What did I say/);
  assert.doesNotMatch(answer, /BETA/);
  assert.equal(restored.getState().draft, "");
  const log = (await readFile(join(alpha, "requests.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  const resume = log.find((request) => request.method === "session.resume");
  assert.equal(resume.params.continuePendingWork, false);
  assert.equal(resume.params.allowTranscriptRecovery, false);
  assert.equal(
    resume.params.sessionId,
    log.find((request) => request.method === "session.create").params.sessionId,
  );
});

test("closing during a request saves an interruption notice and never restarts pending work automatically", async (t) => {
  const { application, root, createApplication, snapshots } = await setup(
    t,
    "persist-hang",
  );
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const running = application.send(alpha, "An interrupted question");
  const rejected = assert.rejects(running, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await application.dispose();
  await rejected;
  const saved = application.getSnapshot();
  assert.ok(saved.sessions.find((session) => session.id === alpha)?.sessionId);
  assert.ok(
    saved.sessions
      .find((session) => session.id === alpha)
      ?.messages.some((message) =>
        /interrupted when the application closed/.test(message.content),
      ),
  );
  const count = snapshots.length;
  await writeFile(join(alpha, "scenario"), "persist");
  const restored = createApplication(saved);
  await restored.refresh();
  await restored.select(alpha);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.sendAndWait",
    ).length,
    1,
  );
  assert.ok(snapshots.length > count);
  assert.equal(
    restored.getState().messages.filter((message) => message.role === "user")
      .length,
    1,
  );
});

test("a missing saved SDK session is reported and only an explicit restart starts fresh", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  await application.send(alpha, "Keep my displayed history.");
  await application.dispose();
  const saved = application.getSnapshot();
  await writeFile(join(alpha, "scenario"), "missing-resume");
  const restored = createApplication(saved);
  await restored.refresh();
  await assert.rejects(restored.select(alpha), /Saved session not found/);
  assert.match(
    restored.getState().error ?? "",
    /Could not resume.*New session/,
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    1,
  );
  await restored.restart(alpha);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    2,
  );
  assert.ok(
    restored
      .getState()
      .messages.some((message) =>
        /Keep my displayed history/.test(message.content),
      ),
  );
  assert.notEqual(
    restored.getSnapshot().sessions.find((session) => session.id === alpha)
      ?.sessionId,
    saved.sessions.find((session) => session.id === alpha)?.sessionId,
  );
});

test("SDK events stream commands, separate output channels, reasoning and messages without duplicate final answers", async (t) => {
  const { application, root, snapshots } = await setup(t, "events");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  assert.equal(application.getState().messages[0]?.title, "session.start");
  await application.send(alpha, "Show everything");
  const transcript = application.getState().messages;
  assert.equal(
    transcript.filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(
    transcript.filter((message) => message.role === "reasoning").length,
    1,
  );
  assert.equal(
    transcript.find((message) => message.role === "reasoning")?.content,
    "Inspect the repository.",
  );
  assert.equal(
    transcript.find((message) => message.role === "tool")?.content,
    "gh pr list\nprintf done",
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "output" && message.content === "first\nsecond\n",
    ),
  );
  assert.ok(
    transcript.some(
      (message) => message.role === "output" && message.content === "warning\n",
    ),
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "output" && message.content === "Command failed",
    ),
  );
  assert.equal(
    transcript.filter(
      (message) => message.role === "assistant" && !message.agentId,
    ).length,
    1,
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.agentId === "child-agent" &&
        message.content === "Subagent answer",
    ),
  );
  assert.ok(
    snapshots.some(
      (snapshot) =>
        snapshot.repositories.find((repository) => repository.id === alpha)
          ?.status === "busy" &&
        snapshot.messages.some((message) => message.role === "output") &&
        !snapshot.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === "## Fixture answer",
        ),
    ),
  );
  await application.select(beta);
  assert.equal(
    application.getState().messages.some((message) => message.role === "tool"),
    false,
  );
  await application.select(alpha);
  await application.send(alpha, "Again");
  assert.equal(
    application
      .getState()
      .messages.filter(
        (message) => message.role === "assistant" && !message.agentId,
      ).length,
    2,
  );
});

test("switching repositories during a request does not misroute messages or cancellation", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await writeFile(join(alpha, "scenario"), "hang:session.sendAndWait");
  await application.select(alpha);
  const running = application.send(alpha, "Stay in alpha");
  const rejected = assert.rejects(running, { name: "AbortError" });
  await assert.rejects(
    application.send(alpha, "Overlapping"),
    /ready repository/,
  );
  await application.select(beta);
  assert.equal(application.getState().activeId, beta);
  assert.deepEqual(application.getState().messages, []);
  application.cancel(alpha);
  await rejected;
  assert.deepEqual(application.getState().messages, []);
  assert.equal(
    application
      .getState()
      .repositories.find((repository) => repository.id === alpha)?.status,
    "error",
  );
  const cancelled = await pid(alpha);
  assert.throws(() => process.kill(cancelled, 0), { code: "ESRCH" });
  await application.send(beta, "Beta still works");
  assert.match(
    application.getState().messages[1]?.content ?? "",
    /Beta still works/,
  );
});

test("a startup timeout is visible, reaps the CLI and allows an explicit restart", async (t) => {
  const { application, root } = await setup(t, "hang:connect", 1_000);
  const alpha = join(root, "alpha");
  await assert.rejects(application.select(alpha), /timed out/);
  assert.match(application.getState().error ?? "", /timed out/);
  const stopped = await pid(alpha);
  assert.throws(() => process.kill(stopped, 0), { code: "ESRCH" });
  await writeFile(join(alpha, "scenario"), "conversation");
  await Promise.all([application.select(alpha), application.select(alpha)]);
  assert.equal(
    application
      .getState()
      .repositories.find((repository) => repository.id === alpha)?.status,
    "ready",
  );
  assert.equal(application.getState().messages[0]?.role, "system");
});

test("unknown paths and malformed UI messages cannot start sessions", async (t) => {
  const { application, root } = await setup(t);
  await assert.rejects(
    application.select(join(root, "alpha", "..")),
    /Unknown repository/,
  );
  await assert.rejects(
    application.send(join(root, "alpha"), "Too early"),
    /ready repository/,
  );
  for (const value of [
    null,
    {},
    { type: "select", id: 1 },
    { type: "send", id: "alpha", question: {} },
    { type: "openExternal", url: "command:workbench.action.terminal.new" },
    { type: "openExternal", url: "javascript:alert(1)" },
    { type: "openExternal", url: "file:///etc/passwd" },
    { type: "openExternal", url: "not a URL" },
    { type: "openExternal", url: 1 },
    { type: "draft", id: "alpha", text: 1 },
    { type: "draft", id: "alpha", text: "x".repeat(20_001) },
    { type: "permission", id: "request", approve: "true" },
    { type: "permission", id: "request" },
    { type: "permission", id: 1, approve: true },
  ]) {
    assert.throws(() => parseApplicationMessage(value));
  }
  assert.deepEqual(
    parseApplicationMessage({
      type: "permission",
      id: "request",
      approve: false,
    }),
    { type: "permission", id: "request", approve: false },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "openExternal",
      url: "https://example.com",
    }),
    { type: "openExternal", url: "https://example.com" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "draft", id: "alpha", text: "" }),
    { type: "draft", id: "alpha", text: "" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "send", id: "alpha", question: "Hello" }),
    {
      type: "send",
      id: "alpha",
      question: "Hello",
    },
  );
  await assert.rejects(readFile(join(root, "alpha", "pid")), {
    code: "ENOENT",
  });
});

test("closing the application before startup completes prevents late CLI spawning", async (t) => {
  const { application, root } = await setup(t);
  const starting = application.select(join(root, "alpha"));
  const rejected = assert.rejects(starting, /closed/);
  await application.dispose();
  await rejected;
  await assert.rejects(readFile(join(root, "alpha", "pid")), {
    code: "ENOENT",
  });
});

test("refresh preserves existing sessions and stops repositories no longer listed", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const child = await pid(alpha);
  await application.refresh();
  assert.equal(await pid(alpha), child);
  await rm(join(alpha, ".git"), { recursive: true });
  await application.refresh();
  assert.equal(application.getState().activeId, undefined);
  assert.deepEqual(
    application.getState().repositories.map((repository) => repository.name),
    ["beta"],
  );
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
});
