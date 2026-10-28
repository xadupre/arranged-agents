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
import { describePermission } from "../src/presentation";
import { generatePostMortem, type PostMortemSource } from "../src/postmortem";

const analysePostMortem = (source: PostMortemSource, signal: AbortSignal) =>
  generatePostMortem(
    source,
    async (prompt) => {
      const entries: unknown[] = JSON.parse(prompt.split("\n").at(-1)!);
      return JSON.stringify({
        rows: [
          {
            first: 1,
            last: entries.length,
            phase: "Delivery",
            objective: "Complete the task",
            production: "Agent answers, commands and changes",
            filesAndCommits: "As recorded",
            validation: "Recorded validation",
            errors: "Recorded errors and corrections",
          },
        ],
      });
    },
    signal,
  );

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
  const streamingChanges: boolean[] = [];
  const updates = new EventEmitter();
  const applications: AgentApplication[] = [];
  const createApplication = (saved?: SavedApplication): AgentApplication => {
    const application: AgentApplication = new AgentApplication(
      root,
      (repository, requestId) =>
        new CopilotConversation({
          cliPath: join(__dirname, "fixtures", "copilot.js"),
          workingDirectory: repository.path,
          timeoutMs,
          onPermissionRequest: async (request, invocation) => ({
            kind: (await application.requestPermission(
              repository.id,
              describePermission(request, invocation.promptRequest),
              requestId,
            ))
              ? "approve-once"
              : "reject",
          }),
          onUserInputRequest: (request) =>
            application.askQuestion(repository.id, request, requestId),
        }),
      (streaming = false) => {
        changes++;
        streamingChanges.push(streaming);
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
    streamingChanges,
    createApplication,
    waitForRecovery: async () => {
      const signal = AbortSignal.timeout(10_000);
      for (;;) {
        if (
          application
            .getState()
            .messages.some((message) => message.title === "Copilot recovery")
        )
          return;
        await once(updates, "change", { signal });
      }
    },
    waitForPermission: async (repositoryId: string, except?: string) => {
      for (;;) {
        const request = application
          .getState()
          .permissions.find(
            (entry) =>
              entry.repositoryId === repositoryId && entry.id !== except,
          );
        if (request) {
          return request;
        }
        await once(updates, "change");
      }
    },
    waitForQuestion: async (repositoryId: string, except?: string) => {
      for (;;) {
        const request = application
          .getState()
          .questions.find(
            (entry) =>
              entry.repositoryId === repositoryId && entry.id !== except,
          );
        if (request) {
          return request;
        }
        await once(updates, "change");
      }
    },
  };
}

async function requests(
  directory: string,
): Promise<
  { method: string; params?: { sessionId?: string; prompt?: string } }[]
> {
  return (await readFile(join(directory, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

async function pid(directory: string): Promise<number> {
  return Number(await readFile(join(directory, "pid"), "utf8"));
}

test("PostMortems survive saving and session archives, and export the exact analysed conversation rather than later work", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  await application.send(alpha, "Produce a commit for this PR");
  const sources = application.getState().messages;
  await application.createPostMortem(alpha, analysePostMortem);
  const report = application.getState().postMortem;
  assert.ok(report);
  assert.deepEqual(application.getState().messages, sources);
  assert.equal(report.sourceCount, sources.length);
  application.setDraft(alpha, "Keep this draft");
  await application.send(alpha, "Later work must not enter the older export");
  const exported = JSON.parse(application.exportPostMortem(alpha));
  assert.deepEqual(
    exported.sources,
    sources.map((message, index) => ({ index: index + 1, ...message })),
  );
  assert.deepEqual(exported.rows, report.rows);
  await application.dispose();
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(
    restored.exportPostMortem(alpha),
    JSON.stringify(exported, null, 2) + "\n",
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.resume",
    ).length,
    0,
  );
  await restored.createPostMortem(alpha, analysePostMortem);
  assert.equal(restored.getState().postMortem?.sourceCount, sources.length + 2);
  await restored.newSession(alpha);
  assert.equal(restored.getState().postMortem, undefined);
  await restored.deleteSessions(alpha, false);
  assert.equal(restored.getState().postMortem?.sourceCount, sources.length + 2);
});

test("PostMortem failures and cancellation preserve the main conversation, draft and previous report", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const child = await pid(alpha);
  await application.send(alpha, "Finish the task");
  await application.createPostMortem(alpha, analysePostMortem);
  application.setDraft(alpha, "Unsent draft");
  const before = application.exportPostMortem(alpha);
  await assert.rejects(
    application.createPostMortem(alpha, async () => {
      throw new Error("Analysis failed");
    }),
    /Analysis failed/,
  );
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getState().postMortemError, "Analysis failed");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = application.createPostMortem(
    alpha,
    (_source, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  await started;
  assert.equal(application.getState().postMortemBusy, true);
  await assert.rejects(
    application.send(alpha, "Do not mutate a snapshot in progress"),
    /PostMortem/,
  );
  assert.throws(() => application.newSession(alpha), /PostMortem/);
  application.cancel(alpha);
  await cancelled;
  assert.equal(application.exportPostMortem(alpha), before);
  assert.equal(application.getState().draft, "Unsent draft");
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.doesNotThrow(() => process.kill(child, 0));
});

test("PostMortem waits for completed work and shutdown or removal cannot attach a late report", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const sending = application.send(alpha, "Finish this task first");
  const permission = await waitForPermission(alpha);
  assert.throws(
    () => application.createPostMortem(alpha, analysePostMortem),
    /work to finish/,
  );
  application.respondToPermission(permission.id, true);
  await sending;
  for (const action of ["remove", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root } = await setup(t, "persist");
      const alpha = join(root, "alpha");
      await application.select(alpha);
      await application.send(alpha, "Completed task");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = application.createPostMortem(
        alpha,
        (_source, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            entered();
          }),
      );
      const cancelled = assert.rejects(pending, { name: "AbortError" });
      await started;
      if (action === "remove") {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      } else await application.dispose();
      await cancelled;
      assert.equal(
        application
          .getSnapshot()
          .sessions.find((session) => session.id === alpha)?.postMortem,
        undefined,
      );
    });
  }
});

test("parallel questions run immediately with visible context and isolated approvals, while OFF messages drain FIFO", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const mainPid = await pid(alpha);
  const mainId = application.getSnapshot().sessions[0]!.sessionId;
  const main = application.send(alpha, "Main task");
  const mainPermission = await waitForPermission(alpha);
  const firstQueued = application.send(alpha, "First follow-up", false);
  const secondQueued = application.send(alpha, "Second follow-up", false);
  const side = application.send(alpha, "Parallel question");
  const sidePermission = await waitForPermission(alpha, mainPermission.id);
  const sidePid = await pid(alpha);
  assert.notEqual(sidePid, mainPid);
  assert.match(sidePermission.summary, /^Parallel /);
  assert.equal(application.getState().repositories[0]?.parallelCount, 1);
  assert.equal(application.getState().repositories[0]?.queuedCount, 2);
  const sends = (await requests(alpha)).filter(
    (request) => request.method === "session.sendAndWait",
  );
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.params?.sessionId, mainId);
  assert.match(sends[1]?.params?.prompt ?? "", /Main task/);
  assert.match(sends[1]?.params?.prompt ?? "", /Parallel question/);
  application.respondToPermission(sidePermission.id, true);
  await side;
  assert.throws(() => process.kill(sidePid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(mainPid, 0));
  assert.deepEqual(application.getState().permissions, [mainPermission]);
  assert.equal(application.getState().repositories[0]?.queuedCount, 2);
  application.respondToPermission(mainPermission.id, true);
  await main;
  const firstPermission = await waitForPermission(alpha);
  application.respondToPermission(firstPermission.id, true);
  await firstQueued;
  const secondPermission = await waitForPermission(alpha);
  application.respondToPermission(secondPermission.id, true);
  await secondQueued;
  const finalSends = (await requests(alpha)).filter(
    (request) => request.method === "session.sendAndWait",
  );
  assert.deepEqual(
    finalSends.slice(2).map((request) => request.params?.prompt),
    ["First follow-up", "Second follow-up"],
  );
  assert.ok(
    finalSends
      .slice(2)
      .every((request) => request.params?.sessionId === mainId),
  );
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getState().repositories[0]?.queuedCount, 0);
  assert.equal(
    application
      .getState()
      .messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.content === "Repository access approved",
      ).length,
    4,
  );
  assert.equal(application.getSnapshot().sessions[0]?.history?.length, 1);
});

test("finishing the main task does not clear a parallel question, and queued messages wait for both", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const main = application.send(alpha, "Main task");
  const mainQuestion = await waitForQuestion(alpha);
  const side = application.send(alpha, "Side question");
  const sideQuestion = await waitForQuestion(alpha, mainQuestion.id);
  const queued = application.send(alpha, "After both", false);
  assert.match(sideQuestion.question, /^Parallel /);
  application.answerQuestion(mainQuestion.id, "Targeted");
  await main;
  assert.deepEqual(application.getState().questions, [sideQuestion]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.equal(application.getState().repositories[0]?.queuedCount, 1);
  application.answerQuestion(sideQuestion.id, "All");
  await side;
  const queuedQuestion = await waitForQuestion(alpha);
  application.answerQuestion(queuedQuestion.id, "Targeted");
  await queued;
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.deepEqual(application.getState().questions, []);
});

test("parallel stream IDs and failures stay isolated from the main conversation", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const main = application.send(alpha, "Main task");
  const permission = await waitForPermission(alpha);
  await writeFile(join(alpha, "scenario"), "empty");
  await assert.rejects(
    application.send(alpha, "Fail independently"),
    /no answer/,
  );
  assert.deepEqual(application.getState().permissions, [permission]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) => message.error && message.title?.startsWith("Parallel "),
      ),
  );
  await writeFile(join(alpha, "scenario"), "events");
  await application.send(alpha, "First stream");
  await application.send(alpha, "Second stream");
  const messages = application.getState().messages;
  assert.equal(
    messages.filter(
      (message) =>
        message.role === "tool" && message.title?.endsWith("bash - completed"),
    ).length,
    2,
  );
  assert.equal(
    messages.filter(
      (message) =>
        message.role === "assistant" &&
        !message.agentId &&
        message.content === "## Fixture answer",
    ).length,
    2,
  );
  assert.deepEqual(application.getState().permissions, [permission]);
  application.respondToPermission(permission.id, true);
  await main;
});

test("parallel SDK IDs persist for repository deletion, while a saved queue is never resumed", async (t) => {
  const { application, root, createApplication } = await setup(
    t,
    "persist-hang",
  );
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const mainId = application.getSnapshot().sessions[0]!.sessionId;
  const main = application.send(alpha, "Long-running main task");
  const mainRejected = assert.rejects(main, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await writeFile(join(alpha, "scenario"), "persist");
  await application.send(alpha, "Independent request");
  const queued = application.send(alpha, "Never automatically replay", false);
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  const entry = restored
    .getSnapshot()
    .sessions.find((session) => session.id === alpha);
  const sideId = entry?.history?.[0]?.sessionId;
  assert.ok(sideId && sideId !== mainId);
  assert.ok(
    entry?.messages.some(
      (message) =>
        message.content === "Never automatically replay" &&
        message.title === "Not sent - previous application ended",
    ),
  );
  await application.closeSession(alpha);
  await Promise.all([mainRejected, queuedRejected]);
  await restored.deleteSessions(alpha, true);
  assert.deepEqual(
    new Set(
      (await requests(alpha))
        .filter((request) => request.method === "session.delete")
        .map((request) => request.params?.sessionId),
    ),
    new Set([mainId, sideId]),
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.sendAndWait",
    ).length,
    2,
  );
  assert.equal(restored.getState().repositories[0]?.sessionCount, 0);
});

test("a main-request failure cancels its queue without hiding or stopping active parallel work", async (t) => {
  const { application, root, waitForPermission, waitForQuestion } = await setup(
    t,
    "permission-error",
  );
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const main = application.send(alpha, "Fail after approval");
  const mainRejected = assert.rejects(main, /Main request failed/);
  const permission = await waitForPermission(alpha);
  const queued = application.send(alpha, "Do not send after failure", false);
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  await writeFile(join(alpha, "scenario"), "question");
  const side = application.send(alpha, "Keep working independently");
  const question = await waitForQuestion(alpha);
  application.respondToPermission(permission.id, true);
  await Promise.all([mainRejected, queuedRejected]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.deepEqual(application.getState().questions, [question]);
  await writeFile(join(alpha, "scenario"), "events");
  await application.send(alpha, "Another parallel request");
  application.answerQuestion(question.id, "Targeted");
  await side;
  assert.equal(application.getState().repositories[0]?.status, "error");
  assert.match(application.getState().error ?? "", /Main request failed/);
});

test("cancel, close and repository removal stop parallel work and never replay queued requests", async (t) => {
  for (const action of ["cancel", "close", "remove", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForPermission, createApplication } =
        await setup(t, "permission");
      const alpha = join(root, "alpha");
      await application.select(alpha);
      const mainPid = await pid(alpha);
      const main = application.send(alpha, "Main task");
      const mainRejected = assert.rejects(main, { name: "AbortError" });
      const mainPermission = await waitForPermission(alpha);
      const side = application.send(alpha, "Parallel task");
      const sideRejected = assert.rejects(side, { name: "AbortError" });
      await waitForPermission(alpha, mainPermission.id);
      const sidePid = await pid(alpha);
      const queued = application.send(alpha, "Must not run", false);
      const queuedRejected = assert.rejects(queued, { name: "AbortError" });
      if (action === "cancel") application.cancel(alpha);
      else if (action === "close") await application.closeSession(alpha);
      else if (action === "dispose") await application.dispose();
      else {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      }
      await Promise.all([mainRejected, sideRejected, queuedRejected]);
      assert.deepEqual(application.getState().permissions, []);
      assert.throws(() => process.kill(mainPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(sidePid, 0), { code: "ESRCH" });
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "session.sendAndWait",
        ).length,
        2,
      );
      const saved = application.getSnapshot();
      const entry = saved.sessions.find((session) => session.id === alpha);
      assert.ok(
        entry?.messages.some(
          (message) =>
            message.content === "Must not run" &&
            message.title === "Not sent - queue cancelled",
        ),
      );
      assert.equal(entry?.history?.length, 1);
      const restored = createApplication(saved);
      await restored.refresh();
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "session.sendAndWait",
        ).length,
        2,
      );
    });
  }
});

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
  assert.equal(alphaPermission.content, "README.md");
  assert.match(alphaPermission.summary, /Read this file/);
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
      const extra = application.requestPermission(alpha, {
        kind: "shell",
        summary: "Run this command?",
        content: "echo test",
        details: "echo test",
      });
      const questionRejected = assert.rejects(
        application.askQuestion(alpha, { question: "Pending question" }),
        { name: "AbortError" },
      );
      if (action === "cancel") {
        application.cancel(alpha);
      } else if (action === "close") {
        await application.dispose();
      } else if (action === "remove") {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      }
      await rejected;
      await questionRejected;
      assert.equal(await extra, false);
      assert.deepEqual(application.getState().permissions, []);
      assert.deepEqual(application.getState().questions, []);
      assert.throws(
        () => application.respondToPermission(request.id, true),
        /closed|no longer pending/,
      );
    });
  }
});

test("SDK questions accept selected and freeform replies for the correct repository", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  const first = application.send(alpha, "Choose tests");
  const question = await waitForQuestion(alpha);
  assert.equal(question.question, "Which test suite should run?");
  await application.select(beta);
  application.answerQuestion(question.id, "Targeted");
  await first;
  assert.deepEqual(application.getState().questions, []);
  await application.select(alpha);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Targeted; freeform: false/,
  );
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) => message.role === "user" && message.content === "Targeted",
      ),
  );
  const second = application.send(alpha, "Custom answer");
  const next = await waitForQuestion(alpha);
  const restricted = application.askQuestion(alpha, {
    question: "Choose only",
    choices: ["One"],
    allowFreeform: false,
  });
  const restrictedId = application.getState().questions.at(-1)!.id;
  assert.throws(
    () => application.answerQuestion(restrictedId, "Other"),
    /proposed answers/,
  );
  application.answerQuestion(restrictedId, "One");
  assert.deepEqual(await restricted, { answer: "One", wasFreeform: false });
  application.answerQuestion(next.id, "Only changed files");
  await second;
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Only changed files; freeform: true/,
  );
  assert.throws(
    () => application.answerQuestion(next.id, "Again"),
    /no longer pending/,
  );
  const third = application.send(alpha, "Cancel this question");
  const rejected = assert.rejects(third, { name: "AbortError" });
  await waitForQuestion(alpha);
  application.cancel(alpha);
  await rejected;
  assert.deepEqual(application.getState().questions, []);
});

test("repository actions close lazily, archive fresh sessions and delete only that repository through the SDK", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  await application.send(alpha, "Remember FIRST");
  application.setDraft(alpha, "First draft");
  const firstId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  const originalPid = await pid(alpha);
  await application.closeSession(alpha);
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().draft, "First draft");
  await application.closeSession(beta);
  await assert.rejects(readFile(join(beta, "pid")), { code: "ENOENT" });
  await application.select(alpha);
  await application.send(alpha, "Recall FIRST");
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Remember FIRST/,
  );
  await application.newSession(alpha);
  assert.deepEqual(application.getState().messages, []);
  assert.equal(application.getState().draft, "");
  await application.send(alpha, "Remember SECOND");
  application.setDraft(alpha, "Second draft");
  const secondId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  await application.newSession(alpha);
  await application.send(alpha, "Remember THIRD");
  const thirdId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  assert.ok(firstId && secondId && thirdId);
  assert.equal(new Set([firstId, secondId, thirdId]).size, 3);
  assert.equal(application.getState().repositories[0]?.sessionCount, 3);
  await application.select(beta);
  await application.send(beta, "Do not touch BETA");
  const betaPid = await pid(beta);
  const betaSnapshot = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === beta);
  const resumesBefore = (await requests(alpha)).filter(
    (entry) => entry.method === "session.resume",
  ).length;
  await application.deleteSessions(alpha, false);
  assert.equal(application.getState().activeId, beta);
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().repositories[0]?.sessionCount, 2);
  assert.equal(
    (await requests(alpha)).filter((entry) => entry.method === "session.resume")
      .length,
    resumesBefore,
  );
  assert.deepEqual(
    application.getSnapshot().sessions.find((entry) => entry.id === beta),
    betaSnapshot,
  );
  assert.doesNotThrow(() => process.kill(betaPid, 0));
  await application.select(alpha);
  assert.equal(application.getState().draft, "Second draft");
  assert.match(application.getState().messages.at(-1)?.content ?? "", /SECOND/);
  assert.doesNotMatch(
    application.getState().messages.at(-1)?.content ?? "",
    /FIRST|THIRD/,
  );
  await application.deleteSessions(alpha, true);
  assert.deepEqual(application.getState().messages, []);
  assert.equal(application.getState().draft, "");
  assert.equal(application.getState().repositories[0]?.sessionCount, 0);
  assert.equal(application.getState().repositories[0]?.status, "idle");
  assert.deepEqual(
    (await requests(alpha))
      .filter((entry) => entry.method === "session.delete")
      .map((entry) => entry.params?.sessionId),
    [thirdId, secondId, firstId],
  );
  assert.equal(
    (await requests(beta)).filter((entry) => entry.method === "session.delete")
      .length,
    0,
  );
  assert.deepEqual(
    application.getSnapshot().sessions.find((entry) => entry.id === beta),
    betaSnapshot,
  );
});

test("archived histories persist and deletion failures retain remaining sessions for retry", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  await application.send(alpha, "Keep older");
  const firstId = application.getSnapshot().sessions[0]!.sessionId;
  assert.ok(firstId);
  await application.newSession(alpha);
  await application.send(alpha, "Delete newer");
  await application.dispose();
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(restored.getState().repositories[0]?.sessionCount, 2);
  await writeFile(join(alpha, "fail-delete-id"), firstId);
  await assert.rejects(restored.deleteSessions(alpha, true), /Deletion denied/);
  assert.equal(restored.getState().repositories[0]?.sessionCount, 1);
  assert.equal(restored.getSnapshot().sessions[0]?.sessionId, firstId);
  assert.match(
    restored.getState().messages.at(-1)?.content ?? "",
    /Keep older/,
  );
  assert.match(restored.getState().error ?? "", /Deletion denied/);
  await rm(join(alpha, "fail-delete-id"));
  await restored.deleteSessions(alpha, true);
  assert.equal(restored.getState().repositories[0]?.sessionCount, 0);
  await storage.save(restored.getSnapshot());
  const reopened = createApplication(await storage.load());
  await reopened.refresh();
  assert.equal(reopened.getState().repositories[0]?.sessionCount, 0);
  assert.deepEqual(reopened.getState().messages, []);
});

test("deletion clears local history if the recorded SDK session is already absent", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  assert.ok(sessionId);
  await application.closeSession(alpha);
  await rm(join(alpha, `history-${sessionId}.json`));
  await application.deleteSessions(alpha, false);
  assert.equal(application.getState().repositories[0]?.sessionCount, 0);
  assert.equal(
    (await requests(alpha)).filter((entry) => entry.method === "session.delete")
      .length,
    0,
  );
});

test("shutdown while deletion closes the old client prevents a replacement CLI from starting", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const child = await pid(alpha);
  const before = await requests(alpha);
  const deleting = application.deleteSessions(alpha, true);
  const rejected = assert.rejects(deleting, /closed/i);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await application.dispose();
  await rejected;
  assert.deepEqual(await requests(alpha), before);
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  assert.ok(application.getSnapshot().sessions[0]?.sessionId);
});

test("closing a busy repository keeps its resumable ID and deleting during shutdown is bounded", async (t) => {
  const { application, root } = await setup(t, "persist-hang");
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  const sending = application.send(alpha, "Interrupted request");
  const interrupted = assert.rejects(sending, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await application.closeSession(alpha);
  await interrupted;
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().draft, "Interrupted request");
  assert.equal(application.getState().repositories[0]?.generation, 1);
  await writeFile(join(alpha, "scenario"), "hang:session.delete");
  const deleting = application.deleteSessions(alpha, true);
  const cancelled = assert.rejects(deleting, { name: "AbortError" });
  await waitForRequest(alpha, "session.delete");
  assert.throws(() => application.newSession(alpha), /already running/);
  await assert.rejects(application.select(alpha), /already running/);
  await application.dispose();
  await cancelled;
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  const child = await pid(alpha);
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
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
  const { application, root, snapshots, streamingChanges } = await setup(
    t,
    "events",
  );
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.select(alpha);
  assert.equal(application.getState().messages[0]?.title, "session.start");
  await application.send(alpha, "Show everything");
  assert.ok(streamingChanges.includes(true));
  const firstBusy = snapshots.findIndex((snapshot) =>
    snapshot.repositories.some(
      (repository) => repository.id === alpha && repository.status === "busy",
    ),
  );
  assert.notEqual(firstBusy, -1);
  assert.equal(streamingChanges[firstBusy], false);
  assert.equal(streamingChanges.at(-1), false);
  const transcript = application.getState().messages;
  const fragments = transcript.filter(
    (message) => message.title === `Tool input: bash`,
  );
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0]?.role, "system");
  assert.equal(fragments[0]?.content, '{"command":"gh pr list\\nprintf done"}');
  assert.ok(
    transcript.some(
      (message) =>
        message.title === "tool.execution_progress" &&
        message.role === "system",
    ),
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "tool" && message.title === "bash - completed",
    ),
  );
  assert.ok(
    transcript.some(
      (message) => message.error && message.content === "Command failed",
    ),
  );
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
  await application.select(beta);
  await assert.rejects(
    application.send(alpha, "Wrong selected repository"),
    /ready repository/,
  );
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

test("a crashed process resumes its session without replaying the original prompt, then drains queued work", async (t) => {
  const { application, root, waitForRecovery } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await writeFile(join(alpha, "crashes-left"), "1");
  await application.select(alpha);
  const originalPid = await pid(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  const sending = application.send(alpha, "Finish the original task");
  await waitForRecovery();
  const queued = application.send(alpha, "Run this only after recovery", false);
  await Promise.all([sending, queued]);
  const log = await requests(alpha);
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  assert.deepEqual(
    log
      .filter((request) => request.method === "session.resume")
      .map((request) => request.params?.sessionId),
    [sessionId],
  );
  const prompts = log
    .filter((request) => request.method === "session.sendAndWait")
    .map((request) => request.params?.prompt);
  assert.equal(prompts.length, 3);
  assert.notEqual(prompts[1], prompts[0]);
  assert.match(prompts[1] ?? "", /Do not blindly repeat commands/);
  assert.ok(prompts[1]?.includes(prompts[0]!));
  assert.match(prompts[2] ?? "", /Run this only after recovery/);
  const state = application.getState();
  assert.equal(state.repositories[0]?.status, "ready");
  assert.equal(state.error, undefined);
  assert.equal(
    state.messages.filter((message) => message.role === "user").length,
    2,
  );
  assert.ok(
    state.messages.some(
      (message) =>
        message.error && /Automatic recovery 1\/3/.test(message.content),
    ),
  );
  assert.ok(
    state.messages.some(
      (message) => message.title === "bash - interrupted" && message.error,
    ),
  );
  assert.ok(
    state.messages.some(
      (message) => message.content === "Partial answer before the crash",
    ),
  );
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
});

test("repeated process crashes stop after three restarts and preserve context for explicit recovery", async (t) => {
  const { application, root } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await writeFile(join(alpha, "crashes-left"), "4");
  await application.select(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  await assert.rejects(
    application.send(alpha, "Keep the failed task"),
    /after 3 automatic restarts/,
  );
  const log = await requests(alpha);
  assert.equal(log.filter((request) => request.method === "connect").length, 4);
  assert.equal(
    log.filter((request) => request.method === "session.resume").length,
    3,
  );
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  assert.equal(application.getState().repositories[0]?.status, "error");
  assert.equal(application.getState().draft, "Keep the failed task");
  assert.ok(
    application
      .getState()
      .messages.filter((message) => message.role === "tool")
      .every((message) => message.title?.endsWith(" - interrupted")),
  );
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  const pids = (await readFile(join(alpha, "pids"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  for (const child of pids)
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  await application.select(alpha);
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
});

test("cancelling or closing during crash recovery prevents another process or prompt from starting", async (t) => {
  for (const action of ["cancel", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForRecovery } = await setup(
        t,
        "crash:session.sendAndWait",
        15_000,
      );
      const alpha = join(root, "alpha");
      await writeFile(join(alpha, "crashes-left"), "4");
      await application.select(alpha);
      const sending = application.send(alpha, "Cancel this recovery");
      const cancelled = assert.rejects(sending, { name: "AbortError" });
      await waitForRecovery();
      if (action === "cancel") application.cancel(alpha);
      else await application.dispose();
      await cancelled;
      const log = await requests(alpha);
      assert.equal(
        log.filter((request) => request.method === "connect").length,
        1,
      );
      assert.equal(
        log.filter((request) => request.method === "session.sendAndWait")
          .length,
        1,
      );
      const child = Number(
        (await readFile(join(alpha, "pids"), "utf8")).trim(),
      );
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    });
  }
});

test("an idle process crash reconnects on the next message without losing the previous context", async (t) => {
  const { application, root } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await application.select(alpha);
  await application.send(alpha, "Remember the first request");
  process.kill(await pid(alpha), "SIGKILL");
  await application.send(alpha, "Now complete the second request");
  assert.equal(application.getState().repositories[0]?.status, "ready");
  const answer = application.getState().messages.at(-1)?.content ?? "";
  assert.match(answer, /Remember the first request/);
  assert.match(answer, /Now complete the second request/);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    1,
  );
});

test("a parallel process recovers independently without stopping the main request", async (t) => {
  const { application, root } = await setup(t, "persist-hang", 15_000);
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const mainPid = await pid(alpha);
  const main = application.send(alpha, "Keep working in the main session");
  const cancelled = assert.rejects(main, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await writeFile(join(alpha, "scenario"), "crash:session.sendAndWait");
  await writeFile(join(alpha, "crashes-left"), "1");
  await application.send(alpha, "Recover only this side request");
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.ok(
    application
      .getState()
      .messages.some((message) =>
        message.title?.includes(": Copilot recovery"),
      ),
  );
  assert.doesNotThrow(() => process.kill(mainPid, 0));
  application.cancel(alpha);
  await cancelled;
});

test("a crash while awaiting approval discards the obsolete permission and requires a fresh decision after recovery", async (t) => {
  const { application, root, waitForPermission } = await setup(
    t,
    "crash:permission",
    15_000,
  );
  const alpha = join(root, "alpha");
  await application.select(alpha);
  const child = await pid(alpha);
  const sending = application.send(alpha, "Continue after explicit approval");
  const original = await waitForPermission(alpha);
  process.kill(child, "SIGKILL");
  const recovered = await waitForPermission(alpha, original.id);
  assert.notEqual(recovered.id, original.id);
  assert.equal(application.getState().permissions.length, 1);
  assert.throws(
    () => application.respondToPermission(original.id, true),
    /no longer pending/,
  );
  application.respondToPermission(recovered.id, true);
  await sending;
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.deepEqual(application.getState().permissions, []);
});

test("startup process crashes are retried but authentication errors are not", async (t) => {
  for (const scenario of ["crash:connect", "unauthenticated"]) {
    await t.test(scenario, async (t) => {
      const { application, root } = await setup(t, scenario, 15_000);
      const alpha = join(root, "alpha");
      await writeFile(join(alpha, "crashes-left"), "1");
      if (scenario === "unauthenticated")
        await assert.rejects(application.select(alpha), /Not authenticated/);
      else {
        await application.select(alpha);
        assert.equal(application.getState().repositories[0]?.status, "ready");
      }
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "connect",
        ).length,
        scenario === "unauthenticated" ? 1 : 2,
      );
    });
  }
});

test("unknown paths and malformed UI messages cannot start sessions", async (t) => {
  const { application, root } = await setup(t);
  assert.deepEqual(parseApplicationMessage({ type: "settings" }), {
    type: "settings",
  });
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
    { type: "send", id: "alpha", question: "Hello", parallel: "false" },
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
    { type: "answer", id: "request", answer: "" },
    { type: "answer", id: "request", answer: true },
    { type: "answer", id: "request", answer: "x".repeat(20_001) },
    { type: "delete-all-sessions", id: 1 },
    { type: "delete-session", id: "alpha" },
  ]) {
    assert.throws(() => parseApplicationMessage(value));
  }
  assert.deepEqual(
    parseApplicationMessage({
      type: "answer",
      id: "question",
      answer: "Targeted",
    }),
    { type: "answer", id: "question", answer: "Targeted" },
  );
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
