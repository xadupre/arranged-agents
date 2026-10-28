import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

interface Request {
  id?: number;
  method: string;
  params?: {
    sessionId?: string;
    model?: string;
    prompt?: string;
    result?: { kind: string };
  };
  result?: { answer: string; wasFreeform: boolean };
  error?: { message: string };
}

const scenario = readFileSync("scenario", "utf8");
writeFileSync("pid", String(process.pid));
let buffer = Buffer.alloc(0);
const prompts: string[] = [];
let pendingSend: number | undefined;
let eventSequence = 0;

function notify(
  sessionId: string | undefined,
  type: string,
  data: object,
  agentId?: string,
): void {
  transmit({
    jsonrpc: "2.0",
    method: "session.event",
    params: {
      sessionId,
      event: {
        id: `event-${++eventSequence}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        type,
        data,
        ...(agentId ? { agentId } : {}),
      },
    },
  });
}

function transmit(message: object): void {
  const body = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function reply(id: number, result: unknown, error?: string): void {
  transmit({
    jsonrpc: "2.0",
    id,
    ...(error ? { error: { code: -32000, message: error } } : { result }),
  });
}

function handle(request: Request): void {
  appendFileSync("requests.jsonl", `${JSON.stringify(request)}\n`);
  if (scenario === "question" && request.id === -1) {
    if (pendingSend === undefined) {
      throw new Error("User answer without a pending request.");
    }
    reply(pendingSend, {
      response: {
        type: "assistant.message",
        data: {
          content:
            request.error?.message ??
            `Answer: ${request.result?.answer}; freeform: ${request.result?.wasFreeform}`,
        },
      },
    });
    pendingSend = undefined;
    return;
  }
  if (request.id === undefined || scenario === `hang:${request.method}`) {
    return;
  }
  switch (request.method) {
    case "connect":
      reply(request.id, { protocolVersion: 3 });
      break;
    case "session.create":
      if (scenario.startsWith("persist") || scenario === "postmortem") {
        writeFileSync(`history-${request.params?.sessionId}.json`, "[]");
      }
      if (scenario === "events") {
        notify(request.params?.sessionId, "session.start", {
          context: { cwd: process.cwd() },
        });
      }
      reply(
        request.id,
        { sessionId: request.params?.sessionId },
        scenario === "unauthenticated"
          ? "Not authenticated. Run copilot login."
          : request.params?.model === "invalid-model"
            ? "Invalid model: invalid-model"
            : undefined,
      );
      break;
    case "session.resume": {
      const filename = `history-${request.params?.sessionId}.json`;
      if (scenario === "missing-resume" || !existsSync(filename)) {
        reply(request.id, undefined, "Saved session not found.");
        break;
      }
      const saved: string[] = JSON.parse(readFileSync(filename, "utf8"));
      prompts.push(...saved);
      reply(request.id, { sessionId: request.params?.sessionId });
      break;
    }
    case "session.getMetadata": {
      const sessionId = request.params?.sessionId;
      reply(request.id, {
        session: existsSync(`history-${sessionId}.json`)
          ? {
              sessionId,
              startTime: new Date().toISOString(),
              modifiedTime: new Date().toISOString(),
            }
          : undefined,
      });
      break;
    }
    case "session.delete": {
      const sessionId = request.params?.sessionId;
      if (
        existsSync("fail-delete-id") &&
        readFileSync("fail-delete-id", "utf8") === sessionId
      ) {
        reply(request.id, { success: false, error: "Deletion denied" });
      } else {
        unlinkSync(`history-${sessionId}.json`);
        reply(request.id, { success: true });
      }
      break;
    }
    case "session.sendAndWait":
      if (scenario === "postmortem") {
        const entries: unknown[] = JSON.parse(
          request.params?.prompt?.split("\n").at(-1) ?? "[]",
        );
        reply(request.id, {
          response: {
            type: "assistant.message",
            data: {
              content: JSON.stringify({
                rows: [
                  {
                    first: 1,
                    last: entries.length,
                    phase: "Implementation and delivery",
                    objective: "Complete the requested task",
                    production: "Code, tests and a commit",
                    filesAndCommits: "As recorded in the source conversation",
                    validation: "Reported test results; consult sources",
                    errors: "Recorded errors and corrections",
                  },
                ],
              }),
            },
          },
        });
        break;
      }
      if (scenario === "question") {
        pendingSend = request.id;
        transmit({
          jsonrpc: "2.0",
          id: -1,
          method: "userInput.request",
          params: {
            sessionId: request.params?.sessionId,
            question: "Which test suite should run?",
            choices: ["Targeted", "All"],
            allowFreeform: true,
          },
        });
        break;
      }
      if (scenario === "permission" || scenario === "permission-error") {
        pendingSend = request.id;
        transmit({
          jsonrpc: "2.0",
          method: "session.event",
          params: {
            sessionId: request.params?.sessionId,
            event: {
              id: "permission-event",
              parentId: null,
              timestamp: new Date().toISOString(),
              type: "permission.requested",
              data: {
                requestId: "permission-request",
                permissionRequest: { kind: "read", path: "README.md" },
              },
            },
          },
        });
        break;
      }
      prompts.push(request.params?.prompt ?? "");
      if (scenario.startsWith("persist")) {
        writeFileSync(
          `history-${request.params?.sessionId}.json`,
          JSON.stringify(prompts),
        );
        if (scenario === "persist-hang") {
          break;
        }
      }
      if (scenario === "events") {
        const sessionId = request.params?.sessionId;
        const messageId = `message-${prompts.length}`;
        notify(sessionId, "user.message", { content: request.params?.prompt });
        notify(sessionId, "assistant.reasoning_delta", {
          reasoningId: messageId,
          deltaContent: "Inspect ",
        });
        notify(sessionId, "assistant.reasoning_delta", {
          reasoningId: messageId,
          deltaContent: "the repository.",
        });
        notify(sessionId, "assistant.reasoning", {
          reasoningId: messageId,
          content: "Inspect the repository.",
        });
        for (const inputDelta of [
          '{"command":',
          '"gh pr list\\nprintf done"}',
        ]) {
          notify(sessionId, "assistant.tool_call_delta", {
            toolCallId: messageId,
            toolName: "bash",
            inputDelta,
          });
        }
        notify(sessionId, "tool.execution_progress", {
          toolCallId: messageId,
          progressMessage: "Preparing command",
        });
        notify(sessionId, "tool.execution_start", {
          toolCallId: messageId,
          toolName: "bash",
          arguments: { command: "gh pr list\nprintf done" },
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stdout",
          sequence: 0,
          text: "first\n",
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stderr",
          sequence: 1,
          text: "warning\n",
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stdout",
          sequence: 2,
          text: "second\n",
        });
        notify(sessionId, "tool.execution_complete", {
          toolCallId: messageId,
          success: true,
          result: { content: "first\nsecond\nwarning" },
        });
        notify(sessionId, "tool.execution_complete", {
          toolCallId: "failed-command",
          success: false,
          error: { message: "Command failed" },
        });
        notify(sessionId, "assistant.message_start", { messageId });
        notify(sessionId, "assistant.message_delta", {
          messageId,
          deltaContent: "## Fixture ",
        });
        notify(sessionId, "assistant.message_delta", {
          messageId,
          deltaContent: "answer",
        });
        notify(sessionId, "assistant.message", {
          messageId,
          content: "## Fixture answer",
        });
        notify(
          sessionId,
          "assistant.message",
          { messageId, content: "Subagent answer" },
          "child-agent",
        );
      }
      reply(request.id, {
        response: {
          type: "assistant.message",
          data: {
            content:
              scenario === "empty"
                ? " "
                : scenario === "conversation" || scenario.startsWith("persist")
                  ? `## Fixture answer\n\n${prompts.join("\n\n")}`
                  : "## Fixture answer",
          },
        },
      });
      break;
    case "session.permissions.handlePendingPermissionRequest":
      reply(request.id, { success: true });
      if (pendingSend === undefined) {
        throw new Error("Permission decision without a pending request.");
      }
      if (scenario === "permission-error") {
        reply(pendingSend, undefined, "Main request failed");
        pendingSend = undefined;
        break;
      }
      reply(pendingSend, {
        response: {
          type: "assistant.message",
          data: {
            content:
              request.params?.result?.kind === "approve-once"
                ? "Repository access approved"
                : "Repository access denied",
          },
        },
      });
      pendingSend = undefined;
      break;
    case "session.detach":
      reply(request.id, { success: true });
      break;
    case "runtime.shutdown":
      reply(request.id, {});
      process.stdin.pause();
      break;
    default:
      reply(request.id, undefined, `Unexpected request: ${request.method}`);
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const length = Number(
      /Content-Length: (\d+)/i.exec(buffer.toString("utf8", 0, headerEnd))?.[1],
    );
    if (!Number.isFinite(length)) {
      throw new Error("Missing Content-Length in SDK request.");
    }
    const end = headerEnd + 4 + length;
    if (buffer.length < end) {
      return;
    }
    const request: Request = JSON.parse(
      buffer.toString("utf8", headerEnd + 4, end),
    );
    buffer = buffer.subarray(end);
    handle(request);
  }
});
