import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildCodexExecArgs,
  prepareCalibration,
  verifyEvidenceAnswer,
} from "../scripts/agent-lane-calibration.mjs";

const SNAPSHOT = "5bf36dd61b6355368d736479c5ffb528b656d544";
const QUESTION =
  "Live Translate가 completion event를 보내지 않을 때 phraseBoundary()는 번역 오디오를 " +
  "유실하지 않고 다음 입력 구간을 어떻게 시작하며, 첫 audible output이 없으면 어떻게 실패하는가?";

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ua-agent-lane-"));
  const snapshotRoot = resolve(root, "analysis-snapshot");
  const uaRoot = resolve(snapshotRoot, ".ua");
  const pilotArtifactRoot = resolve(root, "pilot-run");
  const outputDir = resolve(root, "agent-lane");
  const sourcePath = "poc/kr-ja-meeting/src/live-translation-bridge.mjs";
  const testPath = "poc/kr-ja-meeting/test/live-translation-bridge.test.mjs";
  await mkdir(resolve(snapshotRoot, "poc/kr-ja-meeting/src"), { recursive: true });
  await mkdir(resolve(snapshotRoot, "poc/kr-ja-meeting/test"), { recursive: true });
  await mkdir(uaRoot, { recursive: true });
  await mkdir(pilotArtifactRoot, { recursive: true });
  await writeFile(
    resolve(snapshotRoot, sourcePath),
    "export class LiveTranslationBridge { async phraseBoundary() { return this.waitForAudioDrain(); } async waitForAudioDrain() {} }\n",
  );
  await writeFile(
    resolve(snapshotRoot, testPath),
    "test('a phrase boundary drains translated audio when Live Translate omits completion events', () => {});\n",
  );
  await writeFile(resolve(pilotArtifactRoot, "pilot-plan.json"), JSON.stringify({
    analysisSnapshot: SNAPSHOT,
    provider: "current-codex-provider-only",
    snapshotCheckout: snapshotRoot,
  }));
  await writeFile(resolve(pilotArtifactRoot, "corpus-manifest.json"), JSON.stringify({
    analysisSnapshot: SNAPSHOT,
    included: [
      { path: sourcePath, category: "code" },
      { path: testPath, category: "test" },
    ],
  }));
  await writeFile(resolve(uaRoot, "knowledge-graph.json"), JSON.stringify({
    project: { gitCommitHash: SNAPSHOT },
    nodes: [
      { id: `file:${sourcePath}`, type: "file", name: "live-translation-bridge.mjs", filePath: sourcePath },
      { id: `class:${sourcePath}:LiveTranslationBridge`, type: "class", name: "LiveTranslationBridge", filePath: sourcePath },
      { id: `file:${testPath}`, type: "file", name: "live-translation-bridge.test.mjs", filePath: testPath },
    ],
    edges: [
      { source: `file:${sourcePath}`, type: "contains", target: `class:${sourcePath}:LiveTranslationBridge` },
      { source: `file:${sourcePath}`, type: "tested_by", target: `file:${testPath}` },
    ],
    layers: [],
    tour: [],
  }));
  return { root, snapshotRoot, pilotArtifactRoot, outputDir, sourcePath, testPath };
}

function validAnswer(paths) {
  return {
    status: "answered",
    question: QUESTION,
    affectedBehavior: "phraseBoundary waits for translated audio and fails closed when no audible output arrives.",
    codeEvidence: [
      { path: paths.sourcePath, symbol: "LiveTranslationBridge.phraseBoundary" },
    ],
    testEvidence: [
      {
        path: paths.testPath,
        test: "a phrase boundary drains translated audio when Live Translate omits completion events",
      },
    ],
    graphNodeIds: [
      `file:${paths.sourcePath}`,
      `class:${paths.sourcePath}:LiveTranslationBridge`,
      `file:${paths.testPath}`,
    ],
    graphRelations: [
      {
        source: `file:${paths.sourcePath}`,
        type: "tested_by",
        target: `file:${paths.testPath}`,
      },
    ],
  };
}

test("prepare exposes one unscored calibration without benchmark answers", async () => {
  const paths = await fixture();
  const prepared = await prepareCalibration({
    pilotArtifactRoot: paths.pilotArtifactRoot,
    outputDir: paths.outputDir,
    now: () => "2026-08-30T00:00:00.000Z",
  });

  const prompt = await readFile(prepared.promptPath, "utf8");
  const protocol = JSON.parse(await readFile(prepared.protocolPath, "utf8"));
  assert.equal(protocol.scored, false);
  assert.equal(protocol.provider, "current-codex-provider-only");
  assert.equal(protocol.freshContext.required, true);
  assert.equal(protocol.question, QUESTION);
  assert.match(prompt, /비채점 calibration/);
  assert.match(prompt, /unknown/);
  assert.doesNotMatch(prompt, /impact-benchmark|expectedAnswer|direct-01|12문항/);
});

test("a graph-grounded Evidence Answer passes with exact file, symbol, test, and relation", async () => {
  const paths = await fixture();
  const report = await verifyEvidenceAnswer({
    pilotArtifactRoot: paths.pilotArtifactRoot,
    answer: validAnswer(paths),
    answerTimeMs: 2_345,
  });

  assert.equal(report.status, "answered");
  assert.equal(report.passed, true);
  assert.equal(report.answerTimeMs, 2_345);
  assert.deepEqual(report.errors, []);
});

test("an answer that names a nonexistent file fails", async () => {
  const paths = await fixture();
  const answer = validAnswer(paths);
  answer.codeEvidence[0].path = "poc/kr-ja-meeting/src/invented.mjs";
  await assert.rejects(
    verifyEvidenceAnswer({
      pilotArtifactRoot: paths.pilotArtifactRoot,
      answer,
      answerTimeMs: 100,
    }),
    /invented file evidence/,
  );
});

test("an answer that names a nonexistent graph relation fails", async () => {
  const paths = await fixture();
  const answer = validAnswer(paths);
  answer.graphRelations[0].type = "calls";
  await assert.rejects(
    verifyEvidenceAnswer({
      pilotArtifactRoot: paths.pilotArtifactRoot,
      answer,
      answerTimeMs: 100,
    }),
    /invented graph relation/,
  );
});

test("insufficient evidence is reported as unknown instead of guessed", async () => {
  const paths = await fixture();
  const answer = validAnswer(paths);
  answer.status = "unknown";
  answer.affectedBehavior = "unknown";
  answer.codeEvidence = [];
  answer.testEvidence = [];
  answer.graphNodeIds = [];
  answer.graphRelations = [];
  const report = await verifyEvidenceAnswer({
    pilotArtifactRoot: paths.pilotArtifactRoot,
    answer,
    answerTimeMs: 321,
  });

  assert.equal(report.status, "unknown");
  assert.equal(report.passed, true);
  assert.deepEqual(report.errors, []);
});

test("fresh context invocation keeps the current OpenAI Codex provider and read-only snapshot", () => {
  const args = buildCodexExecArgs({
    snapshotRoot: "/tmp/analysis-snapshot",
    schemaPath: "/tmp/answer.schema.json",
    answerPath: "/tmp/raw-answer.json",
  });
  assert.deepEqual(args, [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp/analysis-snapshot",
    "--output-schema",
    "/tmp/answer.schema.json",
    "--output-last-message",
    "/tmp/raw-answer.json",
    "-",
  ]);
  assert.equal(args.includes("resume"), false);
  assert.equal(args.includes("--oss"), false);
  assert.equal(args.includes("--local-provider"), false);
});
