import assert from "node:assert/strict";
import test from "node:test";

import { runFinalCanaries } from "../src/final-canary-orchestrator.mjs";

test("final canaries keep service, browser, playout, provider, and human evidence separate", async () => {
  const commands = [];
  const report = await runFinalCanaries({
    run: async (command) => {
      commands.push(command);
      return { status: 0, stdout: `${command}:ok` };
    },
  });

  assert.deepEqual(commands, [
    "npm run check",
    "npm run canary:natural-conversation",
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.evidence.map(({ category, status }) => ({ category, status })), [
    { category: "service", status: "passed" },
    { category: "browser", status: "passed" },
    { category: "playout", status: "local-livekit-gated" },
    { category: "provider", status: "credential-gated" },
    { category: "human", status: "not-claimed" },
  ]);
});

test("optional LiveKit playout and provider canaries reuse their existing commands", async () => {
  const commands = [];
  const report = await runFinalCanaries({
    includePlayout: true,
    includeProvider: true,
    run: async (command) => {
      commands.push(command);
      return { status: 0, stdout: "ok" };
    },
  });

  assert.deepEqual(commands, [
    "npm run check",
    "npm run canary:natural-conversation",
    "npm run canary:playout-continuity",
    "npm run canary:provider-browser",
  ]);
  assert.equal(report.evidence.find(({ category }) => category === "playout").status, "passed");
  assert.equal(report.evidence.find(({ category }) => category === "provider").status, "passed");
});

test("a failed executable category fails the report without upgrading gated evidence", async () => {
  const report = await runFinalCanaries({
    run: async (command) => ({
      status: command.includes("natural-conversation") ? 1 : 0,
      stderr: command.includes("natural-conversation") ? "browser contract failed" : "",
    }),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.evidence.find(({ category }) => category === "browser"), {
    category: "browser",
    status: "failed",
    command: "npm run canary:natural-conversation",
    detail: "browser contract failed",
  });
  assert.equal(report.evidence.find(({ category }) => category === "provider").status, "credential-gated");
  assert.equal(report.evidence.find(({ category }) => category === "human").status, "not-claimed");
});
