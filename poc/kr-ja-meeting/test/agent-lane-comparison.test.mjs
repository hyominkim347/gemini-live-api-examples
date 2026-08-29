import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildArmPrompt,
  buildCodexExecArgs,
  prepareAgentComparison,
  verifyRawAnswer,
} from "../scripts/agent-lane-comparison.mjs";

const SNAPSHOT = "5bf36dd61b6355368d736479c5ffb528b656d544";

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ua-agent-comparison-"));
  const snapshotRoot = resolve(root, "snapshot");
  const artifactRoot = resolve(root, "pilot-run");
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

test("prepare freezes the Impact Benchmark into a crossed Agent Lane Paired Comparison without scorer data", async () => {
  const paths = await fixture();
  const prepared = await prepareAgentComparison({
    pilotArtifactRoot: paths.artifactRoot,
    outputDir: paths.outputDir,
    timeoutMs: 123_000,
    now: () => "2026-08-30T00:00:00.000Z",
  });
  const planText = await readFile(prepared.planPath, "utf8");
  const plan = JSON.parse(planText);

  assert.equal(plan.scored, false);
  assert.equal(plan.questions.length, 12);
  assert.equal(plan.runs.length, 24);
  assert.deepEqual(plan.runs.slice(0, 4).map(({ questionId, arm }) => [questionId, arm]), [
    ["direct-01", "understandAnythingGraph"],
    ["direct-01", "repositorySearchRg"],
    ["direct-02", "repositorySearchRg"],
    ["direct-02", "understandAnythingGraph"],
  ]);
  assert.ok(plan.runs.every((run) => run.timeoutMs === 123_000));
  assert.doesNotMatch(planText, /expectedAnswer|passGate|minimumCorrect|scorer/);

  const graphMaterial = await readFile(resolve(prepared.graphMaterialRoot, "knowledge-graph.json"), "utf8");
  const rgCode = await readFile(resolve(prepared.rgMaterialRoot, paths.codePath), "utf8");
  assert.match(graphMaterial, /tested_by/);
  assert.match(rgCode, /affectedBehavior/);
  await assert.rejects(readFile(resolve(prepared.rgMaterialRoot, "benchmark.json"), "utf8"), /ENOENT/);
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
  assert.deepEqual(args, [
    "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only",
    "--cd", "/tmp/material", "--output-schema", "/tmp/schema.json",
    "--output-last-message", "/tmp/answer.json", "-",
  ]);
  assert.equal(args.includes("resume"), false);
  assert.equal(args.includes("--oss"), false);
  assert.equal(args.includes("--local-provider"), false);
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
