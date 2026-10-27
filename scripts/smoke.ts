import assert from "node:assert/strict";
import { askCopilot } from "../src/copilot";
import { buildPrompt } from "../src/prompt";
import { renderResult } from "../src/render";

async function main(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const answer = await askCopilot(
      buildPrompt("Reply with ARRANGED_AGENTS_OK and nothing else."),
      {
        cliPath: process.env.ARRANGED_AGENTS_CLI_PATH ?? "copilot",
        workingDirectory: process.cwd(),
        signal: controller.signal,
      },
    );
    assert.match(answer, /ARRANGED_AGENTS_OK/);
    assert.match(renderResult("Smoke test", answer), /ARRANGED_AGENTS_OK/);
    console.log("Local Copilot CLI and result rendering: OK");
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
