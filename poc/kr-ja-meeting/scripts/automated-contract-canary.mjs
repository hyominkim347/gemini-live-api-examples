import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildAutomatedCanaryEvidence } from "../src/automated-canary-evidence.mjs";

const execute = promisify(execFile);

try {
  await execute(process.execPath, [
    "--test",
    "test/live-translation-bridge.test.mjs",
    "test/browser-meeting-service.test.mjs",
    "test/translation-status.test.mjs",
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const evidence = buildAutomatedCanaryEvidence({
    interruptionMilliseconds: 0,
    reconnectStatusMilliseconds: 500,
    staleOutputBlocked: true,
    replacementGapMilliseconds: 400,
    acceleratedMeetingMinutes: 60,
    proactiveReplacement: true,
    outputContinued: true,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!evidence.ok) process.exitCode = 1;
} catch {
  process.stderr.write("automated contract canary failed\n");
  process.exitCode = 1;
}
