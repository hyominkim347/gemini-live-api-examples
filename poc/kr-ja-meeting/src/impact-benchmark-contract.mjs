import { readFile } from "node:fs/promises";

const DEFAULT_BENCHMARK_URL = new URL(
  "../benchmark/impact-benchmark.v1.json",
  import.meta.url,
);

export async function loadImpactBenchmark(url = DEFAULT_BENCHMARK_URL) {
  const benchmark = JSON.parse(await readFile(url, "utf8"));
  validateBenchmark(benchmark);
  return benchmark;
}

export function scoreImpactBenchmark(benchmark, result) {
  validateBenchmark(benchmark);
  validateResultIdentity(benchmark, result);

  const baseline = validateArm(benchmark, result.arms?.repositorySearch, "repositorySearch");
  const candidate = validateArm(
    benchmark,
    result.arms?.understandAnything,
    "understandAnything",
  );

  const correctAnswers = candidate.filter((answer) => answer.correct).length;
  const evidencedAnswers = candidate.filter(hasCompleteEvidence).length;
  const inventedFiles = candidate.reduce(
    (count, answer) => count + answer.inventedFiles.length,
    0,
  );
  const inventedRelations = candidate.reduce(
    (count, answer) => count + answer.inventedRelations.length,
    0,
  );
  const baselineMedianMs = median(baseline.map((answer) => answer.answerTimeMs));
  const candidateMedianMs = median(candidate.map((answer) => answer.answerTimeMs));
  const medianTimeReduction = round(
    (baselineMedianMs - candidateMedianMs) / baselineMedianMs,
  );

  const failures = [];
  if (correctAnswers < benchmark.passGate.minimumCorrectAnswers) {
    failures.push("correct-answers-below-10");
  }
  if (evidencedAnswers < benchmark.passGate.requiredEvidencedAnswers) {
    failures.push("evidence-missing");
  }
  if (inventedFiles > benchmark.passGate.maximumInventedFiles) {
    failures.push("invented-file");
  }
  if (inventedRelations > benchmark.passGate.maximumInventedRelations) {
    failures.push("invented-relation");
  }
  if (medianTimeReduction < benchmark.passGate.minimumMedianTimeReduction) {
    failures.push("median-time-reduction-below-25-percent");
  }

  return {
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    lane: result.lane,
    pass: failures.length === 0,
    failures,
    metrics: {
      correctAnswers,
      evidencedAnswers,
      inventedFiles,
      inventedRelations,
      baselineMedianMs,
      candidateMedianMs,
      medianTimeReduction,
    },
  };
}

function validateBenchmark(benchmark) {
  if (!benchmark || !Array.isArray(benchmark.questions)) {
    throw new TypeError("Impact Benchmark questions are required");
  }
  if (new Set(benchmark.questions.map((question) => question.id)).size !== 12) {
    throw new TypeError("Impact Benchmark must contain twelve unique questions");
  }
  if (!benchmark.revision || !benchmark.frozenAt) {
    throw new TypeError("Impact Benchmark revision and frozen timestamp are required");
  }
}

function validateResultIdentity(benchmark, result) {
  if (result?.benchmarkRevision !== benchmark.revision) {
    throw new TypeError("benchmark revision does not match the frozen contract");
  }
  if (result.benchmarkFrozenAt !== benchmark.frozenAt) {
    throw new TypeError("benchmark frozen timestamp does not match the frozen contract");
  }
  if (!new Set(["developer", "agent"]).has(result.lane)) {
    throw new TypeError("lane must be developer or agent");
  }
}

function validateArm(benchmark, arm, name) {
  if (!Array.isArray(arm?.answers) || arm.answers.length !== 12) {
    throw new TypeError(`${name} must contain twelve answers`);
  }
  const expectedIds = benchmark.questions.map((question) => question.id);
  const actualIds = arm.answers.map((answer) => answer.questionId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new TypeError(`${name} answers must follow the frozen question order`);
  }
  for (const answer of arm.answers) {
    if (
      typeof answer.answer !== "string" ||
      typeof answer.unknown !== "boolean" ||
      typeof answer.correct !== "boolean" ||
      !Array.isArray(answer.evidence?.code) ||
      !Array.isArray(answer.evidence?.tests) ||
      !Array.isArray(answer.inventedFiles) ||
      !Array.isArray(answer.inventedRelations) ||
      !Number.isFinite(answer.answerTimeMs) ||
      answer.answerTimeMs <= 0
    ) {
      throw new TypeError(`${name} contains an invalid answer record`);
    }
  }
  return arm.answers;
}

function hasCompleteEvidence(answer) {
  return answer.evidence.code.length > 0 && answer.evidence.tests.length > 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = sorted.length / 2;
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
