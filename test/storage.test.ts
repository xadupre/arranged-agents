import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ApplicationStorage, type SavedApplication } from "../src/storage";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "arranged-agents-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot: SavedApplication = {
    version: 1,
    root: "/projects",
    activeId: "/projects/alpha",
    sessions: [
      {
        id: "/projects/alpha",
        sessionId: "saved-session",
        draft: "Unfinished",
        messages: [{ role: "user", content: "Remember this" }],
      },
    ],
  };
  return { directory, snapshot };
}

test("history saves are atomic, serialized, private and isolated by launch root", async (t) => {
  const { directory, snapshot } = await setup(t);
  snapshot.sessions[0]!.messages.push({
    role: "output",
    content: "Command failed",
    error: true,
  });
  snapshot.sessions[0]!.history = [
    {
      sessionId: "older-session",
      draft: "Older draft",
      messages: [{ role: "user", content: "Earlier conversation" }],
    },
  ];
  const storage = new ApplicationStorage(directory, snapshot.root);
  assert.equal(await storage.load(), undefined);
  const later = {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      draft: "Latest draft",
    })),
  };
  await Promise.all([storage.save(snapshot), storage.save(later)]);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.load())), later);
  assert.equal(
    await new ApplicationStorage(directory, "/other-root").load(),
    undefined,
  );
  assert.equal(
    (await readdir(dirname(storage.filename))).filter((name) =>
      name.endsWith(".tmp"),
    ).length,
    0,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(storage.filename)).mode & 0o777, 0o600);
  }
});

test("corrupt or mismatched history fails explicitly without overwriting the saved data", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  for (const corrupt of [
    "{broken",
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, root: "/different-root" }),
    JSON.stringify({
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], history: [{}] }],
    }),
    JSON.stringify({
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], postMortem: {} }],
    }),
    JSON.stringify({
      ...snapshot,
      sessions: [
        {
          id: "alpha",
          draft: "",
          messages: [{ role: "script", content: "bad" }],
        },
      ],
    }),
  ]) {
    await writeFile(storage.filename, corrupt);
    await assert.rejects(storage.load());
    assert.equal(await readFile(storage.filename, "utf8"), corrupt);
  }
});

test("save failures propagate and a later save can retry after the storage directory is repaired", async (t) => {
  const { directory, snapshot } = await setup(t);
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "not a directory");
  const storage = new ApplicationStorage(blocked, snapshot.root);
  await assert.rejects(storage.save(snapshot));
  await rm(blocked);
  await mkdir(blocked);
  await storage.save(snapshot);
  assert.equal((await storage.load())?.sessions[0]?.draft, "Unfinished");
});
