import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

interface Request {
  id?: number;
  method: string;
  params?: {
    sessionId?: string;
    model?: string;
    prompt?: string;
  };
}

const scenario = readFileSync("scenario", "utf8");
writeFileSync("pid", String(process.pid));
let buffer = Buffer.alloc(0);

function reply(id: number, result: unknown, error?: string): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error: { code: -32000, message: error } } : { result }),
  });
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function handle(request: Request): void {
  appendFileSync("requests.jsonl", `${JSON.stringify(request)}\n`);
  if (request.id === undefined || scenario === `hang:${request.method}`) {
    return;
  }
  switch (request.method) {
    case "connect":
      reply(request.id, { protocolVersion: 3 });
      break;
    case "session.create":
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
    case "session.sendAndWait":
      reply(request.id, {
        response: {
          type: "assistant.message",
          data: { content: scenario === "empty" ? " " : "## Fixture answer" },
        },
      });
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
