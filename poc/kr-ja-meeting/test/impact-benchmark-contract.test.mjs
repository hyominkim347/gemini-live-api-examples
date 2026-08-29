import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadImpactBenchmark,
  scoreImpactBenchmark,
} from "../src/impact-benchmark-contract.mjs";

const EXPECTED_MIX = {
  "direct-dependency": 3,
  "cross-layer": 4,
  "recovery-or-privacy": 3,
  "negative-control": 2,
};

function answer(question, { correct = true, answerTimeMs = 700 } = {}) {
  return {
    questionId: question.id,
    answer: "Observed impact answer",
    unknown: false,
    correct,
    evidence: {
      code: [question.expectedAnswer.evidence.code[0]],
      tests: [question.expectedAnswer.evidence.tests[0]],
    },
    inventedFiles: [],
    inventedRelations: [],
    answerTimeMs,
  };
}

function validResult(benchmark) {
  return {
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    lane: "agent",
    arms: {
      repositorySearch: {
        answers: benchmark.questions.map((question) =>
          answer(question, { answerTimeMs: 1_000 }),
        ),
      },
      understandAnything: {
        answers: benchmark.questions.map((question) => answer(question)),
      },
    },
  };
}

test("the frozen Impact Benchmark contains the agreed twelve evidenced questions", async () => {
  const benchmark = await loadImpactBenchmark();
  const mix = Object.fromEntries(
    Object.keys(EXPECTED_MIX).map((category) => [
      category,
      benchmark.questions.filter((question) => question.category === category).length,
    ]),
  );

  assert.equal(benchmark.analysisSnapshot, "5bf36dd61b6355368d736479c5ffb528b656d544");
  assert.match(benchmark.revision, /^impact-benchmark-v\d+$/);
  assert.match(benchmark.frozenAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(benchmark.freezePolicy, "immutable-after-first-scored-run");
  assert.equal(benchmark.questions.length, 12);
  assert.deepEqual(mix, EXPECTED_MIX);

  for (const question of benchmark.questions) {
    assert.ok(question.prompt);
    assert.ok(question.expectedAnswer.summary);
    assert.ok(question.expectedAnswer.evidence.code.length > 0);
    assert.ok(question.expectedAnswer.evidence.tests.length > 0);
    for (const reference of [
      ...question.expectedAnswer.evidence.code,
      ...question.expectedAnswer.evidence.tests,
    ]) {
      const [path, fragment] = reference.split("#");
      const source = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
      if (fragment) assert.ok(source.includes(fragment), reference);
    }
  }

  assert.equal(benchmark.resultContract.unknown, "boolean");
});

test("the scorer passes a valid Paired Comparison sample", async () => {
  const benchmark = await loadImpactBenchmark();
  const score = scoreImpactBenchmark(benchmark, validResult(benchmark));

  assert.equal(score.pass, true);
  assert.deepEqual(score.failures, []);
  assert.equal(score.metrics.correctAnswers, 12);
  assert.equal(score.metrics.evidencedAnswers, 12);
  assert.equal(score.metrics.inventedFiles, 0);
  assert.equal(score.metrics.inventedRelations, 0);
  assert.equal(score.metrics.medianTimeReduction, 0.3);
});

test("the scorer fails each legacy passGate condition used by the Agent Context Pass Gate", async (t) => {
  const benchmark = await loadImpactBenchmark();

  await t.test("fewer than 10 correct answers", () => {
    const result = validResult(benchmark);
    result.arms.understandAnything.answers.slice(0, 3).forEach((item) => {
      item.correct = false;
    });
    assert.deepEqual(scoreImpactBenchmark(benchmark, result).failures, [
      "correct-answers-below-10",
    ]);
  });

  await t.test("missing code or test evidence", () => {
    const result = validResult(benchmark);
    result.arms.understandAnything.answers[0].evidence.tests = [];
    assert.deepEqual(scoreImpactBenchmark(benchmark, result).failures, [
      "evidence-missing",
    ]);
  });

  await t.test("an invented relation", () => {
    const result = validResult(benchmark);
    result.arms.understandAnything.answers[0].inventedRelations.push(
      "nonexistent-module -> meeting-session",
    );
    assert.deepEqual(scoreImpactBenchmark(benchmark, result).failures, [
      "invented-relation",
    ]);
  });

  await t.test("less than 25 percent median time reduction", () => {
    const result = validResult(benchmark);
    result.arms.understandAnything.answers.forEach((item) => {
      item.answerTimeMs = 751;
    });
    assert.deepEqual(scoreImpactBenchmark(benchmark, result).failures, [
      "median-time-reduction-below-25-percent",
    ]);
  });
});

test("a scored run must name the exact frozen benchmark revision", async () => {
  const benchmark = await loadImpactBenchmark();
  const result = validResult(benchmark);
  result.benchmarkRevision = "impact-benchmark-v2";

  assert.throws(
    () => scoreImpactBenchmark(benchmark, result),
    /benchmark revision does not match the frozen contract/,
  );
});
