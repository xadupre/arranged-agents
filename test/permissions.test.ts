import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PermissionHandler,
  PermissionRequest,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };
import {
  automaticallyApprove,
  permissionHandler,
  urlOrigin,
} from "../src/permissions";

const invocation = { sessionId: "test-session" };
const read: PermissionRequest = {
  kind: "read",
  path: "/outside/repository/README.md",
  intention: "Read a file",
};
const shell: Extract<PermissionRequest, { kind: "shell" }> = {
  kind: "shell",
  fullCommandText: "git status --short",
  intention: "Inspect repository",
  commands: [{ identifier: "git status", readOnly: true }],
  canOfferSessionApproval: true,
  hasWriteFileRedirection: false,
  possiblePaths: [],
  possibleUrls: [],
};
function url(value: string): Extract<PermissionRequest, { kind: "url" }> {
  return { kind: "url", url: value, intention: "Read a remote file" };
}
function automatic(request: PermissionRequest, origins: string[] = []) {
  return automaticallyApprove(request, undefined, origins);
}

test("local reads and HTTPS GitHub file reads are automatically approved", () => {
  assert.equal(automatic(read), true);
  for (const address of [
    "https://github.com/owner/repo/blob/main/README.md",
    "https://raw.githubusercontent.com/owner/repo/main/README.md",
    "https://api.github.com/repos/owner/repo/contents/README.md",
  ]) {
    assert.equal(automatic(url(address)), true, address);
  }
});

test("URL consent is scoped to the exact HTTP origin, not a prefix or hostname suffix", () => {
  assert.equal(
    urlOrigin("https://Example.com:443/a?q=1#heading"),
    "https://example.com",
  );
  assert.equal(
    urlOrigin("http://localhost:8000/path"),
    "http://localhost:8000",
  );
  const origins = ["https://example.com"];
  assert.equal(automatic(url("https://example.com/other"), origins), true);
  for (const address of [
    "http://example.com",
    "https://example.com:8443",
    "https://sub.example.com",
    "https://example.com.evil.test",
    "https://github.com.evil.test/file",
    "https://github.com@evil.test/file",
    "http://github.com/file",
    "https://github.com:8443/file",
    "https://user@example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    assert.equal(automatic(url(address), origins), false, address);
  }
  for (const address of [
    "file:///tmp/file",
    "ftp://example.com",
    "https://user@example.com",
    "invalid",
  ]) {
    assert.equal(urlOrigin(address), undefined);
  }
  assert.equal(
    automatic(
      { ...url("https://other.test"), redirectedFrom: "https://example.com" },
      origins,
    ),
    false,
  );
});

test("shell approval uses all runtime-parsed commands and URL destinations", () => {
  for (const command of [
    "rg pattern src",
    "grep -R pattern .",
    "git diff",
    "gh pr view 21",
    "cat README.md | head -n 10",
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: command,
        commands: [{ identifier: command.split(" ")[0]!, readOnly: true }],
      }),
      true,
      command,
    );
  }
  assert.equal(
    automatic({
      ...shell,
      possibleUrls: [{ url: "https://example.com/data" }],
    }),
    false,
  );
  assert.equal(
    automatic(
      {
        ...shell,
        possibleUrls: [{ url: "https://example.com/data" }],
      },
      ["https://example.com"],
    ),
    true,
  );
  assert.equal(
    automatic({
      ...shell,
      possibleUrls: [
        { url: "https://raw.githubusercontent.com/owner/repo/main/file" },
      ],
    }),
    true,
  );
  assert.equal(automatic({ ...shell, commands: [] }), false);
  assert.equal(
    automatic({
      ...shell,
      hasWriteFileRedirection: true,
      possiblePaths: ["/outside/file"],
    }),
    false,
  );
  for (const command of [
    "git commit",
    "git push",
    "gh pr merge",
    "rm",
    "bash",
    "python",
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: `git status && ${command}`,
        commands: [
          { identifier: "git status", readOnly: true },
          { identifier: command, readOnly: false },
        ],
      }),
      false,
      command,
    );
  }
});

test("only read-only GitHub MCP tools bypass confirmation; writes and unknown tools do not", () => {
  const mcp: Extract<PermissionRequest, { kind: "mcp" }> = {
    kind: "mcp",
    serverName: "github",
    toolName: "get_file_contents",
    toolTitle: "Read file",
    readOnly: true,
  };
  for (const serverName of ["github", "github-mcp", "github-mcp-server"]) {
    assert.equal(automatic({ ...mcp, serverName }), true);
  }
  assert.equal(automatic({ ...mcp, readOnly: false }), false);
  assert.equal(automatic({ ...mcp, serverName: "other" }), false);
  assert.equal(
    automatic({
      kind: "write",
      fileName: "/repo/file",
      intention: "Edit file",
      canOfferSessionApproval: true,
      diff: "+new content",
    }),
    false,
  );
});

test("managed approvals, warnings, and sandbox escalations always require a user", () => {
  for (const request of [read, shell, url("https://github.com/file")]) {
    assert.equal(
      automatic({ ...request, managedApprovalRequired: true }),
      false,
    );
    assert.equal(automatic({ ...request, requestSandboxBypass: true }), false);
    assert.equal(
      automaticallyApprove(
        request,
        {
          kind: "url",
          url: "https://github.com/file",
          intention: "Read file",
          managedApprovalRequired: true,
        },
        [],
      ),
      false,
    );
    assert.equal(
      automaticallyApprove(
        request,
        {
          kind: "url",
          url: "https://github.com/file",
          intention: "Read file",
          requestSandboxBypass: true,
        },
        [],
      ),
      false,
    );
  }
  assert.equal(automatic({ ...shell, warning: "Dangerous command" }), false);
});

test("root consent is explicit, persisted, shared by new handlers, and revocable", async () => {
  let origins: string[] = [];
  const questions: Parameters<
    Parameters<typeof permissionHandler>[0]["ask"]
  >[0][] = [];
  const options = {
    isActive: () => true,
    approvedOrigins: () => origins,
    rememberOrigin: async (origin: string) => {
      origins.push(origin);
    },
    ask: async (description: (typeof questions)[number]) => {
      questions.push(description);
      return true;
    },
  };
  const handler = permissionHandler(options);
  assert.deepEqual(await handler(read, invocation), { kind: "approve-once" });
  assert.equal(questions.length, 0);
  assert.deepEqual(await handler(url("https://example.com/a"), invocation), {
    kind: "approve-once",
  });
  assert.equal(
    questions[0]?.approvalLabel,
    "Allow https://example.com and remember",
  );
  assert.deepEqual(origins, ["https://example.com"]);
  const reopened = permissionHandler(options);
  await reopened(url("https://example.com/b"), invocation);
  assert.equal(questions.length, 1);
  origins = [];
  await reopened(url("https://example.com/c"), invocation);
  assert.equal(questions.length, 2);
});

test("rejection, closure and managed approval never persist URL consent", async () => {
  let active = true;
  let accept = false;
  let closeDuringAsk = false;
  let prompts = 0;
  const remembered: string[] = [];
  const handler = permissionHandler({
    isActive: () => active,
    approvedOrigins: () => [],
    rememberOrigin: async (origin) => {
      remembered.push(origin);
    },
    ask: async (description) => {
      prompts++;
      if (closeDuringAsk) active = false;
      if (prompts > 2) assert.equal(description.approvalLabel, undefined);
      return accept;
    },
  });
  assert.equal(
    (await handler(url("https://example.com"), invocation)).kind,
    "reject",
  );
  accept = true;
  closeDuringAsk = true;
  assert.equal(
    (await handler(url("https://example.com"), invocation)).kind,
    "reject",
  );
  assert.equal((await handler(read, invocation)).kind, "reject");
  assert.equal(prompts, 2);
  active = true;
  closeDuringAsk = false;
  await handler(
    { ...url("https://example.com"), managedApprovalRequired: true },
    invocation,
  );
  await handler(
    { ...url("https://example.com"), requestSandboxBypass: true },
    invocation,
  );
  assert.deepEqual(remembered, []);
});

test("failed persistence does not silently grant a remembered approval", async () => {
  const handler: PermissionHandler = permissionHandler({
    isActive: () => true,
    approvedOrigins: () => [],
    rememberOrigin: async () => {
      throw new Error("Cannot save settings");
    },
    ask: async () => true,
  });
  await assert.rejects(
    async () => handler(url("https://example.com"), invocation),
    /Cannot save settings/,
  );
});
