import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildArmPrompt,
  buildCodexExecArgs,
  buildCrossedRuns,
  prepareAgentComparison,
  validateComparisonPlanControls,
  validateComparisonPlanSeal,
  verifyRawAnswer,
} from "../scripts/agent-lane-comparison.mjs";

const SNAPSHOT = "5bf36dd61b6355368d736479c5ffb528b656d544";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ua-agent-comparison-"));
  const snapshotRoot = resolve(root, "snapshot");
  const artifactRoot = resolve(root, ".ua-pilot", "pilot-run");
  const outputDir = resolve(root, ".ua-pilot", "agent-lane-comparison");
  const graphDir = resolve(snapshotRoot, ".ua");
  const codePath = "poc/kr-ja-meeting/src/example.mjs";
  const testPath = "poc/kr-ja-meeting/test/example.test.mjs";
  await mkdir(resolve(snapshotRoot, "poc/kr-ja-meeting/src"), { recursive: true });
  await mkdir(resolve(snapshotRoot, "poc/kr-ja-meeting/test"), { recursive: true });
  await mkdir(graphDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(resolve(snapshotRoot, codePath), "export function affectedBehavior() { return true; }\n");
  await writeFile(resolve(snapshotRoot, testPath), "test('affected behavior stays grounded', () => {});\n");
  await writeFile(resolve(artifactRoot, "pilot-plan.json"), JSON.stringify({
    analysisSnapshot: SNAPSHOT,
    provider: "current-codex-provider-only",
    snapshotCheckout: snapshotRoot,
    artifacts: { graphDirectory: graphDir },
  }));
  await writeFile(resolve(artifactRoot, "corpus-manifest.json"), JSON.stringify({
    analysisSnapshot: SNAPSHOT,
    included: [
      { path: codePath, category: "code" },
      { path: testPath, category: "test" },
    ],
  }));
  const codeNode = `file:${codePath}`;
  const testNode = `file:${testPath}`;
  await writeFile(resolve(graphDir, "knowledge-graph.json"), JSON.stringify({
    project: { gitCommitHash: SNAPSHOT },
    nodes: [
      { id: codeNode, type: "file", filePath: codePath, name: "example.mjs" },
      { id: `function:${codePath}:affectedBehavior`, type: "function", filePath: codePath, name: "affectedBehavior" },
      { id: testNode, type: "file", filePath: testPath, name: "example.test.mjs" },
      { id: `test:${testPath}:affected`, type: "function", filePath: testPath, name: "affected behavior stays grounded" },
    ],
    edges: [{ source: codeNode, type: "tested_by", target: testNode }],
    layers: [],
    tour: [],
  }));
  return {
    root,
    snapshotRoot,
    artifactRoot,
    outputDir,
    codePath,
    testPath,
    codeNode,
    testNode,
  };
}

test("the frozen twelve questions use the crossed Agent Lane order without scorer data", async () => {
  const benchmark = JSON.parse(await readFile(
    new URL("../benchmark/impact-benchmark.v1.json", import.meta.url),
    "utf8",
  ));
  const questions = benchmark.questions.map(({ id, category, prompt }) => ({ id, category, prompt }));
  const runs = buildCrossedRuns(questions, 123_000);

  assert.equal(questions.length, 12);
  assert.equal(runs.length, 24);
  assert.deepEqual(runs.slice(0, 4).map(({ questionId, arm }) => [questionId, arm]), [
    ["direct-01", "understandAnythingGraph"],
    ["direct-01", "repositorySearchRg"],
    ["direct-02", "repositorySearchRg"],
    ["direct-02", "understandAnythingGraph"],
  ]);
  assert.ok(runs.every((run) => run.timeoutMs === 123_000));
  assert.doesNotMatch(JSON.stringify({ questions, runs }), /expectedAnswer|passGate|minimumCorrect|scorer/);
});

test("prepared comparison controls reject a changed run path and plan bytes", async () => {
  const benchmarkText = await readFile(
    new URL("../benchmark/impact-benchmark.v1.json", import.meta.url),
    "utf8",
  );
  const benchmark = JSON.parse(benchmarkText);
  const questions = benchmark.questions.map(({ id, category, prompt }) => ({ id, category, prompt }));
  const plan = {
    contractVersion: 1,
    scored: false,
    lane: "agent",
    provider: "current-codex-provider-only",
    analysisSnapshot: SNAPSHOT,
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    benchmarkSha256: sha256(benchmarkText),
    preparedAt: "2026-08-30T00:00:00.000Z",
    timeoutMs: 600_000,
    orderPolicy: "odd-graph-first-even-rg-first",
    pilotArtifact: {
      planSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      corpusDigestSha256: "c".repeat(64),
      graphSha256: "d".repeat(64),
    },
    materialDigests: {
      understandAnythingGraph: "e".repeat(64),
      repositorySearchRg: "f".repeat(64),
    },
    questions,
    runs: buildCrossedRuns(questions, 600_000),
  };
  validateComparisonPlanControls({ plan, benchmark, benchmarkText });
  const unsafe = structuredClone(plan);
  unsafe.runs[0].runId = "../escaped";
  assert.throws(
    () => validateComparisonPlanControls({ plan: unsafe, benchmark, benchmarkText }),
    /invalid/,
  );

  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const schemaText = "{}\n";
  const sealText = JSON.stringify({
    contractVersion: 1,
    planSha256: sha256(planText),
    schemaSha256: sha256(schemaText),
  });
  validateComparisonPlanSeal({ planText, sealText, schemaText });
  assert.throws(
    () => validateComparisonPlanSeal({ planText: `${planText} `, sealText, schemaText }),
    /changed after prepare/,
  );
});

test("each arm prompt contains only its question and material contract", () => {
  const graphPrompt = buildArmPrompt({
    question: { id: "q-01", prompt: "What changes?" },
    arm: "understandAnythingGraph",
  });
  const rgPrompt = buildArmPrompt({
    question: { id: "q-01", prompt: "What changes?" },
    arm: "repositorySearchRg",
  });
  assert.match(graphPrompt, /knowledge-graph\.json/);
  assert.doesNotMatch(graphPrompt, /repository search|expectedAnswer|score|previous answer/i);
  assert.match(rgPrompt, /\brg\b/);
  assert.doesNotMatch(rgPrompt, /knowledge-graph|expectedAnswer|score|previous answer/i);
});

test("fresh invocations use the current Codex provider, read-only sandbox, and no resume", () => {
  const args = buildCodexExecArgs({
    materialRoot: "/tmp/material",
    schemaPath: "/tmp/schema.json",
    answerPath: "/tmp/answer.json",
  });
  assert.equal(args.includes("--sandbox"), false);
  assert.ok(args.some((value) => value.includes("default_permissions=\"ua_pilot_material_only\"")));
  assert.ok(args.some((value) => value.includes('"/tmp/material"="read"')));
  assert.ok(args.some((value) => value.includes("network={enabled=false}")));
  assert.equal(args.includes("resume"), false);
  assert.equal(args.includes("--oss"), false);
  assert.equal(args.includes("--local-provider"), false);
});

test("prepare rejects a self-asserted Pilot Artifact without current verification evidence", async () => {
  const paths = await fixture();
  await assert.rejects(
    prepareAgentComparison({
      pilotArtifactRoot: paths.artifactRoot,
      outputDir: paths.outputDir,
    }),
    /prepare evidence|artifact verification|inventory verification|complete pinned|missing/i,
  );
});

test("verification records grounded code, tests, relations, and measured time without a score", async () => {
  const paths = await fixture();
  const raw = await verifyRawAnswer({
    pilotArtifactRoot: paths.artifactRoot,
    run: { runId: "01-graph", sequence: 1, questionId: "q-01", arm: "understandAnythingGraph" },
    question: { id: "q-01", prompt: "Question 1: what changes?" },
    answerTimeMs: 2_345,
    answer: {
      answer: "affectedBehavior and its regression test change together.",
      unknown: false,
      evidence: {
        code: [{ path: paths.codePath, symbol: "affectedBehavior" }],
        tests: [{ path: paths.testPath, test: "affected behavior stays grounded" }],
        relations: [{ source: paths.codeNode, type: "tested_by", target: paths.testNode }],
      },
    },
  });
  assert.equal(raw.answerTimeMs, 2_345);
  assert.deepEqual(raw.inventedFiles, []);
  assert.deepEqual(raw.inventedRelations, []);
  assert.deepEqual(raw.unverifiedEvidence, []);
  assert.equal(raw.validationStatus, "grounded");
  assert.equal(Object.hasOwn(raw, "correct"), false);
  assert.equal(Object.hasOwn(raw, "pass"), false);
});

test("verification records invented evidence and preserves an evidence-free unknown", async () => {
  const paths = await fixture();
  const invented = await verifyRawAnswer({
    pilotArtifactRoot: paths.artifactRoot,
    run: { runId: "01-graph", sequence: 1, questionId: "q-01", arm: "understandAnythingGraph" },
    question: { id: "q-01", prompt: "Question 1: what changes?" },
    answerTimeMs: 100,
    answer: {
      answer: "invented",
      unknown: false,
      evidence: {
        code: [{ path: "invented.mjs", symbol: "nope" }],
        tests: [],
        relations: [{ source: paths.codeNode, type: "calls", target: paths.testNode }],
      },
    },
  });
  assert.deepEqual(invented.inventedFiles, ["invented.mjs"]);
  assert.equal(invented.inventedRelations.length, 1);
  assert.equal(invented.validationStatus, "unsupported");

  const unknown = await verifyRawAnswer({
    pilotArtifactRoot: paths.artifactRoot,
    run: { runId: "01-rg", sequence: 2, questionId: "q-01", arm: "repositorySearchRg" },
    question: { id: "q-01", prompt: "Question 1: what changes?" },
    answerTimeMs: 101,
    answer: {
      answer: "unknown",
      unknown: true,
      evidence: { code: [], tests: [], relations: [] },
    },
  });
  assert.equal(unknown.validationStatus, "unknown");
  assert.deepEqual(unknown.inventedFiles, []);
  assert.deepEqual(unknown.inventedRelations, []);
});
