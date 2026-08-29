import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjudicateAgentOnlyGate,
  FROZEN_BENCHMARK_SHA256,
  FROZEN_RAW_RESULTS_SHA256,
} from "../src/agent-only-pilot-gate.mjs";

const benchmarkUrl = new URL("../benchmark/impact-benchmark.v1.json", import.meta.url);
const actualRawPath = process.env.UA_AGENT_RAW_RESULTS_PATH ??
  "/private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison/raw-results.json";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function splitEvidence(value, key) {
  const separator = value.indexOf("#");
  return separator === -1
    ? { path: value, [key]: "file" }
    : { path: value.slice(0, separator), [key]: value.slice(separator + 1) };
}

function passingRaw(benchmark) {
  const results = [];
  for (const [index, question] of benchmark.questions.entries()) {
    const common = {
      runId: `${index + 1}-graph`,
      questionId: question.id,
      provider: "current-codex-provider-only",
      freshContext: true,
      answer: question.expectedAnswer.summary,
      unknown: false,
      evidence: {
        code: question.expectedAnswer.evidence.code.map((value) => splitEvidence(value, "symbol")),
        tests: question.expectedAnswer.evidence.tests.map((value) => splitEvidence(value, "test")),
        relations: [],
      },
      inventedFiles: [],
      inventedRelations: [],
      unverifiedEvidence: [],
      validationStatus: "grounded",
    };
    const graph = { ...common, arm: "understandAnythingGraph", answerTimeMs: 1_000 };
    const rg = {
      ...common,
      runId: `${index + 1}-rg`,
      arm: "repositorySearchRg",
      answerTimeMs: 2_000,
    };
    const crossed = index % 2 === 0 ? [graph, rg] : [rg, graph];
    for (const answer of crossed) {
      results.push({ ...answer, sequence: results.length + 1 });
    }
  }
  return {
    contractVersion: 1,
    analysisSnapshot: benchmark.analysisSnapshot,
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    lane: "agent",
    provider: "current-codex-provider-only",
    scored: false,
    completedRuns: 24,
    orderPolicy: "odd-graph-first-even-rg-first",
    timeoutMs: 600_000,
    results,
  };
}

async function fixture() {
  const benchmarkText = await readFile(benchmarkUrl, "utf8");
  const benchmark = JSON.parse(benchmarkText);
  const rawText = JSON.stringify(passingRaw(benchmark));
  return {
    benchmark,
    benchmarkText,
    rawText,
    expectedRawSha256: sha256(rawText),
  };
}

test("a frozen, grounded Agent Lane result records Agent Context Candidate", async () => {
  const input = await fixture();
  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText: input.rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: input.expectedRawSha256,
  });

  assert.equal(result.resultRouting, "Agent Context Candidate");
  assert.deepEqual(result.scorer, {
    revision: "agent-only-gate-v1",
    inputContractVersion: 1,
    outputContractVersion: 1,
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.metrics, {
    correctAnswers: 12,
    evidencedAnswers: 12,
    inventedFiles: 0,
    inventedRelations: 0,
    graphMedianMs: 1000,
    repositorySearchMedianMs: 2000,
    medianTimeReduction: 0.5,
  });
  assert.deepEqual(result.questionScores[0].matchedCodeEvidence, [
    "poc/kr-ja-meeting/src/speech-activity-detector.mjs#SpeechActivityDetector",
  ]);
  assert.deepEqual(result.questionScores[0].missingTestEvidence, []);
});

test("grounded but unrelated evidence does not satisfy the frozen evidence gate", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.evidence.code = [{ path: "unrelated.mjs", symbol: "Unrelated" }];
  answer.evidence.tests = [{ path: "unrelated.test.mjs", test: "unrelated" }];
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.resultRouting, "Stop Rule");
  assert.equal(result.metrics.correctAnswers, 11);
  assert.equal(result.metrics.evidencedAnswers, 11);
  assert.deepEqual(result.questionScores[0].missingCodeEvidence, [
    "poc/kr-ja-meeting/src/speech-activity-detector.mjs#SpeechActivityDetector",
  ]);
  assert.deepEqual(result.questionScores[0].missingTestEvidence, [
    "poc/kr-ja-meeting/test/speech-activity-detector.test.mjs#voice followed by sustained silence emits one automatic utterance boundary",
  ]);
});

test("unknown, unsupported, or invented evidence activates the Stop Rule", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const [unknown, unsupported, invented] = raw.results.filter(
    (answer) => answer.arm === "understandAnythingGraph",
  );
  unknown.unknown = true;
  unknown.validationStatus = "unknown";
  unknown.evidence = { code: [], tests: [], relations: [] };
  unsupported.validationStatus = "unsupported";
  unsupported.unverifiedEvidence = ["not verified"];
  invented.inventedFiles = ["invented.mjs"];
  invented.inventedRelations = [{ source: "a", type: "calls", target: "b" }];
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.resultRouting, "Stop Rule");
  assert.equal(result.metrics.correctAnswers, 9);
  assert.equal(result.metrics.evidencedAnswers, 9);
  assert.equal(result.metrics.inventedFiles, 1);
  assert.equal(result.metrics.inventedRelations, 1);
  assert.deepEqual(result.failures, [
    "correct-answers-below-10",
    "evidence-missing",
    "invented-file",
    "invented-relation",
  ]);
});

test("changed benchmark or raw bytes fail before adjudication", async () => {
  const input = await fixture();
  assert.throws(
    () => adjudicateAgentOnlyGate({
      benchmarkText: `${input.benchmarkText}\n`,
      rawText: input.rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: input.expectedRawSha256,
    }),
    /Frozen Impact Benchmark digest mismatch/,
  );
  assert.throws(
    () => adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText: `${input.rawText}\n`,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: input.expectedRawSha256,
    }),
    /Agent Lane raw artifact digest mismatch/,
  );
});

test("the frozen AIN-7643 raw artifact deterministically activates the Stop Rule", {
  skip: !existsSync(actualRawPath),
}, async () => {
  const [benchmarkText, rawText] = await Promise.all([
    readFile(benchmarkUrl, "utf8"),
    readFile(actualRawPath, "utf8"),
  ]);
  const result = adjudicateAgentOnlyGate({
    benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: FROZEN_RAW_RESULTS_SHA256,
  });

  assert.equal(result.resultRouting, "Stop Rule");
  assert.equal(result.metrics.correctAnswers, 0);
  assert.equal(result.metrics.evidencedAnswers, 0);
  assert.equal(result.metrics.inventedFiles, 0);
  assert.equal(result.metrics.inventedRelations, 0);
  assert.equal(result.metrics.graphMedianMs, 36_840.065);
  assert.equal(result.metrics.repositorySearchMedianMs, 33_217.775);
  assert.equal(result.metrics.medianTimeReduction, -0.109);
});
