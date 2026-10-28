import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCopilot } from "../src/copilot";
import { buildPrompt } from "../src/prompt";
import { renderResult } from "../src/render";

async function main(): Promise<void> {
  const workingDirectory = await mkdtemp(
    join(tmpdir(), "arranged-agents-smoke-"),
  );
  try {
    const answer = await askCopilot(
      buildPrompt("Reply with ARRANGED_AGENTS_OK and nothing else."),
      {
        cliPath: process.env.ARRANGED_AGENTS_CLI_PATH ?? "copilot",
        workingDirectory,
      },
    );
    assert.match(answer, /ARRANGED_AGENTS_OK/);
    assert.match(renderResult("Smoke test", answer), /ARRANGED_AGENTS_OK/);
    console.log("Local Copilot CLI and result rendering: OK");
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
