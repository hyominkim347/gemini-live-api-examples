import { createHash } from "node:crypto";

export const FROZEN_BENCHMARK_SHA256 =
  "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6";
export const FROZEN_RAW_RESULTS_SHA256 =
  "6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0";

const PROVIDER = "current-codex-provider-only";
const ORDER_POLICY = "odd-graph-first-even-rg-first";
const GRAPH_ARM = "understandAnythingGraph";
const RG_ARM = "repositorySearchRg";
const SCORER_REVISION = "agent-only-gate-v1";
const OUTPUT_CONTRACT_VERSION = 1;

export function adjudicateAgentOnlyGate({
  benchmarkText,
  rawText,
  expectedBenchmarkSha256 = FROZEN_BENCHMARK_SHA256,
  expectedRawSha256 = FROZEN_RAW_RESULTS_SHA256,
}) {
  requireDigest(benchmarkText, expectedBenchmarkSha256, "Frozen Impact Benchmark");
  requireDigest(rawText, expectedRawSha256, "Agent Lane raw artifact");

  const benchmark = parseJson(benchmarkText, "Frozen Impact Benchmark");
  const raw = parseJson(rawText, "Agent Lane raw artifact");
  validateInputs(benchmark, raw);

  const graphByQuestion = armByQuestion(raw.results, GRAPH_ARM);
  const rgByQuestion = armByQuestion(raw.results, RG_ARM);
  const questionScores = benchmark.questions.map((question) =>
    adjudicateQuestion(question, graphByQuestion.get(question.id)),
  );
  const correctAnswers = questionScores.filter(({ correct }) => correct).length;
  const evidencedAnswers = questionScores.filter(({ evidenced }) => evidenced).length;
  const graphAnswers = [...graphByQuestion.values()];
  const rgAnswers = [...rgByQuestion.values()];
  const inventedFiles = sumLengths(graphAnswers, "inventedFiles");
  const inventedRelations = sumLengths(graphAnswers, "inventedRelations");
  const graphMedianMs = median(graphAnswers.map(({ answerTimeMs }) => answerTimeMs));
  const repositorySearchMedianMs = median(rgAnswers.map(({ answerTimeMs }) => answerTimeMs));
  const medianTimeReduction = round(
    (repositorySearchMedianMs - graphMedianMs) / repositorySearchMedianMs,
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
    contractVersion: OUTPUT_CONTRACT_VERSION,
    scorer: {
      revision: SCORER_REVISION,
      inputContractVersion: raw.contractVersion,
      outputContractVersion: OUTPUT_CONTRACT_VERSION,
    },
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    analysisSnapshot: benchmark.analysisSnapshot,
    inputDigests: {
      benchmarkSha256: expectedBenchmarkSha256,
      rawResultsSha256: expectedRawSha256,
    },
    resultRouting: failures.length === 0 ? "Agent Context Candidate" : "Stop Rule",
    failures,
    metrics: {
      correctAnswers,
      evidencedAnswers,
      inventedFiles,
      inventedRelations,
      graphMedianMs,
      repositorySearchMedianMs,
      medianTimeReduction,
    },
    questionScores,
  };
}

function adjudicateQuestion(question, answer) {
  const verified =
    answer.validationStatus === "grounded" &&
    answer.unknown === false &&
    answer.unverifiedEvidence.length === 0 &&
    answer.inventedFiles.length === 0 &&
    answer.inventedRelations.length === 0;
  const actualCode = new Set(answer.evidence.code.map(codeEvidenceKey));
  const actualTests = new Set(answer.evidence.tests.map(testEvidenceKey));
  const expectedCode = question.expectedAnswer.evidence.code;
  const expectedTests = question.expectedAnswer.evidence.tests;
  const matchedCode = expectedCode.filter((value) => actualCode.has(value));
  const matchedTests = expectedTests.filter((value) => actualTests.has(value));
  const missingCode = expectedCode.filter((value) => !actualCode.has(value));
  const missingTests = expectedTests.filter((value) => !actualTests.has(value));
  const evidenced = verified && missingCode.length === 0 && missingTests.length === 0;
  const correct = evidenced;

  return {
    questionId: question.id,
    validationStatus: answer.validationStatus,
    unknown: answer.unknown,
    evidenced,
    correct,
    expectedCodeEvidence: expectedCode,
    matchedCodeEvidence: matchedCode,
    missingCodeEvidence: missingCode,
    expectedTestEvidence: expectedTests,
    matchedTestEvidence: matchedTests,
    missingTestEvidence: missingTests,
    answerTimeMs: answer.answerTimeMs,
  };
}

function validateInputs(benchmark, raw) {
  if (
    benchmark.revision !== "impact-benchmark-v1" ||
    !benchmark.frozenAt ||
    !benchmark.analysisSnapshot ||
    !Array.isArray(benchmark.questions) ||
    benchmark.questions.length !== 12 ||
    new Set(benchmark.questions.map(({ id }) => id)).size !== 12
  ) {
    throw new TypeError("Frozen Impact Benchmark identity is invalid");
  }
  const gate = benchmark.passGate;
  if (
    gate?.minimumCorrectAnswers !== 10 ||
    gate.requiredEvidencedAnswers !== 12 ||
    gate.maximumInventedFiles !== 0 ||
    gate.maximumInventedRelations !== 0 ||
    gate.minimumMedianTimeReduction !== 0.25
  ) {
    throw new TypeError("Frozen Agent Context Pass Gate changed");
  }
  for (const question of benchmark.questions) {
    if (
      !question.expectedAnswer?.summary ||
      !Array.isArray(question.expectedAnswer.evidence?.code) ||
      !Array.isArray(question.expectedAnswer.evidence?.tests) ||
      question.expectedAnswer.evidence.code.length === 0 ||
      question.expectedAnswer.evidence.tests.length === 0
    ) {
      throw new TypeError(`Frozen expected evidence is invalid: ${question.id}`);
    }
  }

  if (
    raw.contractVersion !== 1 ||
    raw.analysisSnapshot !== benchmark.analysisSnapshot ||
    raw.benchmarkRevision !== benchmark.revision ||
    raw.benchmarkFrozenAt !== benchmark.frozenAt ||
    raw.lane !== "agent" ||
    raw.provider !== PROVIDER ||
    raw.scored !== false ||
    raw.completedRuns !== 24 ||
    raw.orderPolicy !== ORDER_POLICY ||
    raw.timeoutMs !== 600_000 ||
    !Array.isArray(raw.results) ||
    raw.results.length !== 24
  ) {
    throw new TypeError("Agent Lane raw artifact identity is invalid");
  }
  validateRuns(benchmark, raw.results);
}

function validateRuns(benchmark, results) {
  const expectedRuns = [];
  for (const [index, question] of benchmark.questions.entries()) {
    const arms = index % 2 === 0 ? [GRAPH_ARM, RG_ARM] : [RG_ARM, GRAPH_ARM];
    expectedRuns.push(...arms.map((arm) => ({ questionId: question.id, arm })));
  }
  const ordered = [...results].sort((left, right) => left.sequence - right.sequence);
  for (const [index, answer] of ordered.entries()) {
    const expected = expectedRuns[index];
    if (
      answer.sequence !== index + 1 ||
      answer.questionId !== expected.questionId ||
      answer.arm !== expected.arm ||
      answer.provider !== PROVIDER ||
      answer.freshContext !== true ||
      typeof answer.answer !== "string" ||
      typeof answer.unknown !== "boolean" ||
      !["grounded", "unsupported", "unknown"].includes(answer.validationStatus) ||
      !Array.isArray(answer.evidence?.code) ||
      !Array.isArray(answer.evidence?.tests) ||
      !Array.isArray(answer.evidence?.relations) ||
      !Array.isArray(answer.inventedFiles) ||
      !Array.isArray(answer.inventedRelations) ||
      !Array.isArray(answer.unverifiedEvidence) ||
      !Number.isFinite(answer.answerTimeMs) ||
      answer.answerTimeMs <= 0 ||
      Object.hasOwn(answer, "correct") ||
      Object.hasOwn(answer, "pass")
    ) {
      throw new TypeError(`Invalid raw Agent Lane record at sequence ${index + 1}`);
    }
    if (
      answer.unknown &&
      (answer.validationStatus !== "unknown" ||
        answer.evidence.code.length > 0 ||
        answer.evidence.tests.length > 0 ||
        answer.evidence.relations.length > 0)
    ) {
      throw new TypeError(`Unknown raw answer contains unsupported claims: ${answer.questionId}`);
    }
  }
}

function armByQuestion(results, arm) {
  const answers = results.filter((answer) => answer.arm === arm);
  if (answers.length !== 12) throw new TypeError(`${arm} must contain twelve answers`);
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  if (byQuestion.size !== 12) throw new TypeError(`${arm} contains duplicate questions`);
  return byQuestion;
}

function codeEvidenceKey({ path, symbol }) {
  return symbol === "file" ? path : `${path}#${symbol}`;
}

function testEvidenceKey({ path, test }) {
  return `${path}#${test}`;
}

function sumLengths(answers, key) {
  return answers.reduce((total, answer) => total + answer[key].length, 0);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = sorted.length / 2;
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function requireDigest(text, expected, label) {
  if (typeof text !== "string" || sha256(text) !== expected) {
    throw new Error(`${label} digest mismatch`);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON: ${error.message}`);
  }
}
