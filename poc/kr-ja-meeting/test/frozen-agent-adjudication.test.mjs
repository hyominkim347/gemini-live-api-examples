import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjudicateAgentOnlyGate,
  FROZEN_BENCHMARK_SHA256,
  FROZEN_MANUAL_ADJUDICATION_SHA256,
  FROZEN_RAW_RESULTS_SHA256,
  MANUAL_ADJUDICATION_RULE_SHA256,
  scorePreAdjudicatedAgentOnlyGate,
  verifyFrozenManualAdjudicationTable,
} from "../src/agent-only-pilot-gate.mjs";

const benchmarkUrl = new URL("../benchmark/impact-benchmark.v1.json", import.meta.url);
const tableUrl = new URL(
  "../benchmark/agent-only-frozen-adjudication.v1.json",
  import.meta.url,
);
const actualRawPath = process.env.UA_AGENT_RAW_RESULTS_PATH ??
  "/private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison/raw-results.json";

async function frozenTableInputs() {
  const [benchmarkText, manualAdjudicationText] = await Promise.all([
    readFile(benchmarkUrl, "utf8"),
    readFile(tableUrl, "utf8"),
  ]);
  return { benchmarkText, manualAdjudicationText };
}

async function frozenInputs() {
  const { benchmarkText } = await frozenTableInputs();
  return {
    benchmarkText,
    rawText: await readFile(actualRawPath, "utf8"),
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const questionIds = [
  "direct-01",
  "direct-02",
  "direct-03",
  "cross-01",
  "cross-02",
  "cross-03",
  "cross-04",
  "recovery-01",
  "recovery-02",
  "privacy-01",
  "negative-01",
  "negative-02",
];

function preAdjudicatedFixture({
  correctAnswers = 12,
  evidencedAnswers = 12,
  graphAnswerTimeMs = 1_000,
  repositorySearchAnswerTimeMs = 2_000,
  inventedFiles = 0,
  inventedRelations = 0,
} = {}) {
  return {
    questionScores: questionIds.map((questionId, index) => ({
      questionId,
      correct: index < correctAnswers,
      evidenced: index < evidencedAnswers,
    })),
    graphAnswers: questionIds.map((_, index) => ({
      answerTimeMs: graphAnswerTimeMs,
      inventedFiles: index < inventedFiles ? [`invented-${index}.mjs`] : [],
      inventedRelations: index < inventedRelations
        ? [{ source: "a", type: "calls", target: `b-${index}` }]
        : [],
    })),
    repositorySearchAnswers: questionIds.map(() => ({
      answerTimeMs: repositorySearchAnswerTimeMs,
      inventedFiles: [],
      inventedRelations: [],
    })),
  };
}

test("the exact frozen manual adjudication records four correct answers and Stop Rule", {
  skip: !existsSync(actualRawPath),
}, async () => {
  const input = await frozenInputs();
  const result = adjudicateAgentOnlyGate(input);

  assert.deepEqual(result.scorer, {
    revision: "agent-only-gate-v4-frozen-manual",
    inputContractVersion: 1,
    outputContractVersion: 3,
  });
  assert.equal(result.resultRouting, "Stop Rule");
  assert.equal(result.metrics.correctAnswers, 4);
  assert.deepEqual(
    result.questionScores.filter(({ correct }) => correct).map(({ questionId }) => questionId),
    ["direct-01", "cross-02", "negative-01", "negative-02"],
  );
  const direct02 = result.questionScores.find(({ questionId }) => questionId === "direct-02");
  assert.equal(direct02.correct, false);
  assert.equal(direct02.manualAdjudication.ambiguity, true);
  assert.equal(result.manualAdjudication.tableSha256, FROZEN_MANUAL_ADJUDICATION_SHA256);
  assert.equal(result.manualAdjudication.ruleSha256, MANUAL_ADJUDICATION_RULE_SHA256);
  assert.deepEqual(result.metrics, {
    correctAnswers: 4,
    evidencedAnswers: 0,
    inventedFiles: 0,
    inventedRelations: 0,
    graphMedianMs: 36840.065,
    repositorySearchMedianMs: 33217.775,
    medianTimeReduction: -0.109,
  });
  assert.match(FROZEN_BENCHMARK_SHA256, /^[a-f0-9]{64}$/);
  assert.match(FROZEN_RAW_RESULTS_SHA256, /^[a-f0-9]{64}$/);
});

test("the tracked table is exact, ordered, and reviewable without the raw artifact", async () => {
  const { benchmarkText, manualAdjudicationText } = await frozenTableInputs();
  const table = verifyFrozenManualAdjudicationTable({ manualAdjudicationText });

  assert.equal(sha256(benchmarkText), FROZEN_BENCHMARK_SHA256);
  assert.equal(sha256(manualAdjudicationText), FROZEN_MANUAL_ADJUDICATION_SHA256);
  assert.deepEqual(table.questionOrder, questionIds);
  assert.deepEqual(table.questions.map(({ questionId }) => questionId), questionIds);
  assert.deepEqual(
    table.questions.filter(({ correct }) => correct).map(({ questionId }) => questionId),
    ["direct-01", "cross-02", "negative-01", "negative-02"],
  );
  assert.deepEqual(
    table.questions.map(({ rawSequence }) => rawSequence),
    [1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24],
  );
  assert.ok(table.questions.every(({ arm }) => arm === "understandAnythingGraph"));
  assert.deepEqual(
    table.questions.find(({ questionId }) => questionId === "direct-02")
      .reviewProvenance.tiebreak,
    { role: "direct-02-tiebreak", verdict: "incorrect" },
  );
  assert.match(MANUAL_ADJUDICATION_RULE_SHA256, /^[a-f0-9]{64}$/);
});

test("modified frozen inputs are rejected even when the caller supplies custom digests", {
  skip: !existsSync(actualRawPath),
}, async () => {
  const input = await frozenInputs();
  const changed = JSON.parse(input.rawText);
  changed.results.find(({ arm }) => arm === "understandAnythingGraph").answer =
    "Arbitrary prose that claims every expected impact.";
  const rawText = JSON.stringify(changed);

  assert.throws(
    () => adjudicateAgentOnlyGate({
      ...input,
      rawText,
      expectedRawSha256: sha256(rawText),
    }),
    /Frozen adjudicator input accepts only benchmarkText and rawText/,
  );

  const changedBenchmark = JSON.parse(input.benchmarkText);
  changedBenchmark.questions[0].expectedAnswer.summary = "Caller-selected expectation";
  const benchmarkText = JSON.stringify(changedBenchmark);
  assert.throws(
    () => adjudicateAgentOnlyGate({
      ...input,
      benchmarkText,
      expectedBenchmarkSha256: sha256(benchmarkText),
    }),
    /Frozen adjudicator input accepts only benchmarkText and rawText/,
  );

  assert.throws(
    () => adjudicateAgentOnlyGate({ ...input, rawText }),
    /Agent Lane raw artifact digest mismatch/,
  );
  assert.throws(
    () => adjudicateAgentOnlyGate({ ...input, benchmarkText }),
    /Frozen Impact Benchmark digest mismatch/,
  );
});

test("manual table tampering or a missing question is rejected", async () => {
  const { manualAdjudicationText } = await frozenTableInputs();
  const tampered = JSON.parse(manualAdjudicationText);
  tampered.questions[0].correct = false;
  const missing = JSON.parse(manualAdjudicationText);
  missing.questions.pop();
  missing.questionOrder.pop();

  for (const changedText of [JSON.stringify(tampered), JSON.stringify(missing)]) {
    assert.throws(
      () => verifyFrozenManualAdjudicationTable({ manualAdjudicationText: changedText }),
      /Frozen manual adjudication table digest mismatch/,
    );
  }
});

test("pre-adjudicated structured fixtures exercise the frozen gate without prose scoring", () => {
  const candidate = scorePreAdjudicatedAgentOnlyGate(preAdjudicatedFixture({
    correctAnswers: 10,
    graphAnswerTimeMs: 1_500,
    repositorySearchAnswerTimeMs: 2_000,
  }));
  assert.equal(candidate.resultRouting, "Agent Context Candidate");
  assert.deepEqual(candidate.failures, []);
  assert.equal(candidate.metrics.correctAnswers, 10);
  assert.equal(candidate.metrics.medianTimeReduction, 0.25);

  const belowCorrect = scorePreAdjudicatedAgentOnlyGate(
    preAdjudicatedFixture({ correctAnswers: 9 }),
  );
  assert.deepEqual(belowCorrect.failures, ["correct-answers-below-10"]);

  const unsafe = scorePreAdjudicatedAgentOnlyGate(preAdjudicatedFixture({
    evidencedAnswers: 11,
    graphAnswerTimeMs: 1_600,
    repositorySearchAnswerTimeMs: 2_000,
    inventedFiles: 1,
    inventedRelations: 1,
  }));
  assert.deepEqual(unsafe.failures, [
    "evidence-missing",
    "invented-file",
    "invented-relation",
    "median-time-reduction-below-25-percent",
  ]);
});

test("pre-adjudicated fixtures reject a missing question instead of shifting order", () => {
  const fixture = preAdjudicatedFixture();
  fixture.questionScores.splice(3, 1);

  assert.throws(
    () => scorePreAdjudicatedAgentOnlyGate(fixture),
    /Pre-adjudicated question scores are invalid/,
  );
});

test("arbitrary prose cannot create a Candidate without explicit structured verdicts", () => {
  const fixture = preAdjudicatedFixture();
  fixture.questionScores = questionIds.map((questionId) => ({
    questionId,
    answer: "This prose repeats every expected keyword.",
    evidenced: true,
  }));

  assert.throws(
    () => scorePreAdjudicatedAgentOnlyGate(fixture),
    /Pre-adjudicated question scores are invalid/,
  );
});
