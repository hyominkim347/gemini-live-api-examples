import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const FROZEN_BENCHMARK_SHA256 =
  "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6";
export const FROZEN_RAW_RESULTS_SHA256 =
  "6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0";
export const FROZEN_MANUAL_ADJUDICATION_SHA256 =
  "db4de619d182cc29596de7425cca8b7a4f4d9200a7527adf67c3ca6be06f9f14";
export const FROZEN_REVIEW_ARTIFACT_SHA256 = Object.freeze({
  reviewA: "770ece29a780a1ec72e0bd5e000ca659917c7c8a9ca260fa17f8056c3827918b",
  reviewB: "307c134a238455aabcac29c65f8a34e073e0a016cce01e3ee804b954c8760c57",
  tiebreak: "7785b81e5a97f33d6543bee2020af8570bff5f6ea771ebced970106e8b92e0e5",
});

const PROVIDER = "current-codex-provider-only";
const ORDER_POLICY = "odd-graph-first-even-rg-first";
const GRAPH_ARM = "understandAnythingGraph";
const RG_ARM = "repositorySearchRg";
const SCORER_REVISION = "agent-only-gate-v4-frozen-manual";
const OUTPUT_CONTRACT_VERSION = 4;
const MANUAL_ADJUDICATION_REVISION =
  "frozen-agent-manual-adjudication-v2-provenance";
const MANUAL_RULE_REVISION = "frozen-manual-adjudication-v2-provenance";
const REVIEW_POLICY =
  "two-independent-agent-task-reviews-with-question-tiebreak-v2";
const COORDINATOR_SESSION = "01a04dff-c649-7eb2-b3d4-8c994ec4c6f7";
const REVIEWER_KIND = "codex-agent-task";
const INDEPENDENT_REVIEW_ROLES = [
  "independent-review-1",
  "independent-review-2",
];
const TIEBREAK_ROLE = "direct-02-tiebreak";
const TIEBREAK_QUESTION_ID = "direct-02";
const REVIEW_ARTIFACT_SPECS = Object.freeze({
  reviewA: Object.freeze({
    role: INDEPENDENT_REVIEW_ROLES[0],
    reviewId: "manual-review-a",
    reviewerCanonicalTask: "/root/upstream_exploration",
    artifactPath: "benchmark/agent-only-manual-review-a.v1.json",
    sha256: FROZEN_REVIEW_ARTIFACT_SHA256.reviewA,
    label: "Manual review A artifact",
  }),
  reviewB: Object.freeze({
    role: INDEPENDENT_REVIEW_ROLES[1],
    reviewId: "manual-review-b",
    reviewerCanonicalTask: "/root/remove_developer_lane/final_security_review",
    artifactPath: "benchmark/agent-only-manual-review-b.v1.json",
    sha256: FROZEN_REVIEW_ARTIFACT_SHA256.reviewB,
    label: "Manual review B artifact",
  }),
  tiebreak: Object.freeze({
    role: TIEBREAK_ROLE,
    reviewId: "direct-02-tiebreak",
    reviewerCanonicalTask: "/root/remove_developer_lane",
    artifactPath: "benchmark/agent-only-direct-02-tiebreak.v1.json",
    sha256: FROZEN_REVIEW_ARTIFACT_SHA256.tiebreak,
    label: "direct-02 tiebreak artifact",
  }),
});
const FROZEN_QUESTION_IDS = [
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
const FROZEN_PASS_GATE = {
  minimumCorrectAnswers: 10,
  requiredEvidencedAnswers: 12,
  maximumInventedFiles: 0,
  maximumInventedRelations: 0,
  minimumMedianTimeReduction: 0.25,
};
const MANUAL_ADJUDICATION_RULE = {
  revision: MANUAL_RULE_REVISION,
  inputPolicy: "exact-frozen-benchmark-raw-and-table-digests-only",
  correctnessPolicy: "tracked-question-verdicts-only-no-prose-scoring",
  reviewPolicy: REVIEW_POLICY,
  ambiguityPolicy: "direct-02-disagreement-resolved-by-recorded-tiebreak",
  provenancePolicy: "digest-bound-codex-agent-task-artifacts-no-human-review-claim",
  coordinatorSession: COORDINATOR_SESSION,
  reviewArtifacts: Object.values(REVIEW_ARTIFACT_SPECS).map((artifact) => ({
    reviewId: artifact.reviewId,
    reviewerCanonicalTask: artifact.reviewerCanonicalTask,
    sha256: artifact.sha256,
  })),
  evidencePolicy: "independent-exact-code-and-test-evidence-comparison",
  routingPolicy: "unchanged-frozen-agent-context-pass-gate",
  questionOrder: FROZEN_QUESTION_IDS,
};
export const MANUAL_ADJUDICATION_RULE_SHA256 = sha256(
  JSON.stringify(MANUAL_ADJUDICATION_RULE),
);

const FROZEN_MANUAL_ADJUDICATION_URL = new URL(
  "../benchmark/agent-only-frozen-adjudication.v1.json",
  import.meta.url,
);
const FROZEN_REVIEW_ARTIFACT_URLS = Object.freeze({
  reviewA: new URL("../benchmark/agent-only-manual-review-a.v1.json", import.meta.url),
  reviewB: new URL("../benchmark/agent-only-manual-review-b.v1.json", import.meta.url),
  tiebreak: new URL(
    "../benchmark/agent-only-direct-02-tiebreak.v1.json",
    import.meta.url,
  ),
});

export function adjudicateAgentOnlyGate(input) {
  requireOnlyKeys(input, ["benchmarkText", "rawText"], "Frozen adjudicator input");
  const { benchmarkText, rawText } = input;
  const { benchmark, raw } = verifyFrozenAgentOnlyInputs({ benchmarkText, rawText });
  const manualAdjudication = verifyFrozenManualAdjudicationTable();
  const graphByQuestion = armByQuestion(raw.results, GRAPH_ARM);
  const rgByQuestion = armByQuestion(raw.results, RG_ARM);
  const manualByQuestion = new Map(
    manualAdjudication.questions.map((decision) => [decision.questionId, decision]),
  );
  const questionScores = benchmark.questions.map((question) =>
    adjudicateQuestion(
      question,
      graphByQuestion.get(question.id),
      manualByQuestion.get(question.id),
    ));
  const gate = scorePreAdjudicatedAgentOnlyGate({
    questionScores,
    graphAnswers: [...graphByQuestion.values()],
    repositorySearchAnswers: [...rgByQuestion.values()],
  });

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
      benchmarkSha256: FROZEN_BENCHMARK_SHA256,
      rawResultsSha256: FROZEN_RAW_RESULTS_SHA256,
      manualAdjudicationSha256: FROZEN_MANUAL_ADJUDICATION_SHA256,
    },
    manualAdjudication: {
      revision: manualAdjudication.revision,
      tableSha256: FROZEN_MANUAL_ADJUDICATION_SHA256,
      ruleRevision: MANUAL_RULE_REVISION,
      ruleSha256: MANUAL_ADJUDICATION_RULE_SHA256,
      reviewArtifactSha256: FROZEN_REVIEW_ARTIFACT_SHA256,
      reviewMethod: manualAdjudication.reviewMethod,
    },
    ...gate,
    questionScores,
  };
}

export function verifyFrozenAgentOnlyInputs(input) {
  requireOnlyKeys(input, ["benchmarkText", "rawText"], "Frozen input verifier");
  const { benchmarkText, rawText } = input;
  requireDigest(benchmarkText, FROZEN_BENCHMARK_SHA256, "Frozen Impact Benchmark");
  requireDigest(rawText, FROZEN_RAW_RESULTS_SHA256, "Agent Lane raw artifact");

  const benchmark = parseJson(benchmarkText, "Frozen Impact Benchmark");
  const raw = parseJson(rawText, "Agent Lane raw artifact");
  validateInputs(benchmark, raw);

  return {
    benchmark,
    raw,
    provenance: {
      mode: "frozen-digest-provenance-v1",
      benchmarkSha256: FROZEN_BENCHMARK_SHA256,
      rawResultsSha256: FROZEN_RAW_RESULTS_SHA256,
      benchmarkRevision: benchmark.revision,
      analysisSnapshot: benchmark.analysisSnapshot,
      provider: raw.provider,
      orderPolicy: raw.orderPolicy,
      timeoutMs: raw.timeoutMs,
      completedRuns: raw.completedRuns,
    },
  };
}

function requireOnlyKeys(value, expectedKeys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameOrderedValues(Object.keys(value).sort(), [...expectedKeys].sort())
  ) {
    throw new TypeError(`${label} accepts only ${expectedKeys.join(" and ")}`);
  }
}

export function scorePreAdjudicatedAgentOnlyGate({
  questionScores,
  graphAnswers,
  repositorySearchAnswers,
}) {
  validatePreAdjudicatedFixture({
    questionScores,
    graphAnswers,
    repositorySearchAnswers,
  });
  const correctAnswers = questionScores.filter(({ correct }) => correct).length;
  const evidencedAnswers = questionScores.filter(({ evidenced }) => evidenced).length;
  const inventedFiles = sumLengths(graphAnswers, "inventedFiles");
  const inventedRelations = sumLengths(graphAnswers, "inventedRelations");
  const graphMedianMs = median(graphAnswers.map(({ answerTimeMs }) => answerTimeMs));
  const repositorySearchMedianMs = median(
    repositorySearchAnswers.map(({ answerTimeMs }) => answerTimeMs),
  );
  const medianTimeReduction = round(
    (repositorySearchMedianMs - graphMedianMs) / repositorySearchMedianMs,
  );
  const failures = gateFailures({
    correctAnswers,
    evidencedAnswers,
    inventedFiles,
    inventedRelations,
    medianTimeReduction,
  });

  return {
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
  };
}

export function verifyFrozenManualAdjudicationTable({
  manualAdjudicationText = readFileSync(FROZEN_MANUAL_ADJUDICATION_URL, "utf8"),
} = {}) {
  requireDigest(
    manualAdjudicationText,
    FROZEN_MANUAL_ADJUDICATION_SHA256,
    "Frozen manual adjudication table",
  );
  const table = parseJson(manualAdjudicationText, "Frozen manual adjudication table");
  const reviewArtifacts = verifyFrozenManualReviewArtifacts();
  validateManualAdjudicationTable(table, reviewArtifacts);
  return table;
}

export function verifyFrozenManualReviewArtifacts(input = {
  reviewAText: readFileSync(FROZEN_REVIEW_ARTIFACT_URLS.reviewA, "utf8"),
  reviewBText: readFileSync(FROZEN_REVIEW_ARTIFACT_URLS.reviewB, "utf8"),
  tiebreakText: readFileSync(FROZEN_REVIEW_ARTIFACT_URLS.tiebreak, "utf8"),
}) {
  requireOnlyKeys(
    input,
    ["reviewAText", "reviewBText", "tiebreakText"],
    "Frozen review artifact input",
  );
  const texts = {
    reviewA: input.reviewAText,
    reviewB: input.reviewBText,
    tiebreak: input.tiebreakText,
  };
  for (const key of ["reviewA", "reviewB", "tiebreak"]) {
    requireDigest(
      texts[key],
      REVIEW_ARTIFACT_SPECS[key].sha256,
      REVIEW_ARTIFACT_SPECS[key].label,
    );
  }
  const bundle = {
    reviewA: parseJson(texts.reviewA, REVIEW_ARTIFACT_SPECS.reviewA.label),
    reviewB: parseJson(texts.reviewB, REVIEW_ARTIFACT_SPECS.reviewB.label),
    tiebreak: parseJson(texts.tiebreak, REVIEW_ARTIFACT_SPECS.tiebreak.label),
  };
  validateIndependentReviewArtifact(bundle.reviewA, REVIEW_ARTIFACT_SPECS.reviewA);
  validateIndependentReviewArtifact(bundle.reviewB, REVIEW_ARTIFACT_SPECS.reviewB);
  validateTiebreakArtifact(bundle.tiebreak, REVIEW_ARTIFACT_SPECS.tiebreak);
  return bundle;
}

export function validateManualReviewProvenance({
  table,
  reviewA,
  reviewB,
  tiebreak,
} = {}) {
  if (!tiebreak) throw new TypeError("direct-02 tiebreak artifact is required");
  if (!reviewA || !reviewB) {
    throw new TypeError("Two independent manual review artifacts are required");
  }
  if (reviewA.reviewerCanonicalTask === reviewB.reviewerCanonicalTask) {
    throw new TypeError("Independent review canonical tasks must differ");
  }
  validateIndependentReviewArtifact(reviewA, REVIEW_ARTIFACT_SPECS.reviewA);
  validateIndependentReviewArtifact(reviewB, REVIEW_ARTIFACT_SPECS.reviewB);
  validateTiebreakArtifact(tiebreak, REVIEW_ARTIFACT_SPECS.tiebreak);

  const reviewAByQuestion = new Map(
    reviewA.questions.map((decision) => [decision.questionId, decision]),
  );
  const reviewBByQuestion = new Map(
    reviewB.questions.map((decision) => [decision.questionId, decision]),
  );
  const disagreementQuestionIds = FROZEN_QUESTION_IDS.filter((questionId) =>
    reviewAByQuestion.get(questionId).correct !==
      reviewBByQuestion.get(questionId).correct);
  if (!sameOrderedValues(disagreementQuestionIds, [TIEBREAK_QUESTION_ID])) {
    throw new TypeError("Only direct-02 may require a tiebreak");
  }
  if (tiebreak.correct !== false || tiebreak.ambiguity !== true) {
    throw new TypeError("direct-02 tiebreak must resolve to incorrect with ambiguity");
  }

  validateTableProvenanceReferences(table?.reviewMethod);
  const tableByQuestion = new Map(
    table.questions.map((decision) => [decision.questionId, decision]),
  );
  for (const questionId of FROZEN_QUESTION_IDS) {
    const tableDecision = tableByQuestion.get(questionId);
    const independentVerdicts = [
      reviewAByQuestion.get(questionId).correct ? "correct" : "incorrect",
      reviewBByQuestion.get(questionId).correct ? "correct" : "incorrect",
    ];
    if (!sameOrderedValues(
      tableDecision.reviewProvenance.independent.map(({ verdict }) => verdict),
      independentVerdicts,
    )) {
      throw new TypeError(`Manual review artifact verdict mismatch: ${questionId}`);
    }
    const expectedCorrect = questionId === TIEBREAK_QUESTION_ID
      ? tiebreak.correct
      : reviewAByQuestion.get(questionId).correct;
    if (tableDecision.correct !== expectedCorrect) {
      throw new TypeError(`Manual review final verdict mismatch: ${questionId}`);
    }
  }
  return { disagreementQuestionIds };
}

function validateIndependentReviewArtifact(artifact, expected) {
  requireOnlyKeys(
    artifact,
    [
      "artifactVersion",
      "reviewId",
      "coordinatorSession",
      "reviewerCanonicalTask",
      "reviewerKind",
      "recordedAt",
      "inputDigests",
      "questions",
    ],
    expected.label,
  );
  if (
    artifact.artifactVersion !== 1 ||
    artifact.reviewId !== expected.reviewId ||
    artifact.coordinatorSession !== COORDINATOR_SESSION ||
    artifact.reviewerCanonicalTask !== expected.reviewerCanonicalTask ||
    artifact.reviewerKind !== REVIEWER_KIND ||
    !isRecordedAt(artifact.recordedAt) ||
    !hasFrozenInputDigests(artifact.inputDigests) ||
    !Array.isArray(artifact.questions) ||
    !sameOrderedValues(
      artifact.questions.map(({ questionId }) => questionId),
      FROZEN_QUESTION_IDS,
    )
  ) {
    throw new TypeError(`${expected.label} identity is invalid`);
  }
  for (const decision of artifact.questions) {
    requireOnlyKeys(
      decision,
      ["questionId", "correct", "ambiguity", "rationale"],
      `${expected.label} decision`,
    );
    if (
      typeof decision.correct !== "boolean" ||
      typeof decision.ambiguity !== "boolean" ||
      typeof decision.rationale !== "string" ||
      decision.rationale.trim().length === 0
    ) {
      throw new TypeError(`${expected.label} decision is invalid: ${decision.questionId}`);
    }
  }
}

function validateTiebreakArtifact(artifact, expected) {
  requireOnlyKeys(
    artifact,
    [
      "artifactVersion",
      "reviewId",
      "coordinatorSession",
      "reviewerCanonicalTask",
      "reviewerKind",
      "recordedAt",
      "inputDigests",
      "questionId",
      "correct",
      "ambiguity",
      "rationale",
      "rubric",
    ],
    expected.label,
  );
  if (
    artifact.artifactVersion !== 1 ||
    artifact.reviewId !== expected.reviewId ||
    artifact.coordinatorSession !== COORDINATOR_SESSION ||
    artifact.reviewerCanonicalTask !== expected.reviewerCanonicalTask ||
    artifact.reviewerKind !== REVIEWER_KIND ||
    !isRecordedAt(artifact.recordedAt) ||
    !hasFrozenInputDigests(artifact.inputDigests) ||
    artifact.questionId !== TIEBREAK_QUESTION_ID ||
    typeof artifact.correct !== "boolean" ||
    typeof artifact.ambiguity !== "boolean" ||
    typeof artifact.rationale !== "string" ||
    artifact.rationale.trim().length === 0 ||
    typeof artifact.rubric !== "string" ||
    artifact.rubric.trim().length === 0
  ) {
    throw new TypeError(`${expected.label} identity is invalid`);
  }
}

function validateTableProvenanceReferences(reviewMethod) {
  const references = reviewMethod?.provenanceArtifacts;
  const independent = references?.independentReviews;
  const expectedIndependent = [
    REVIEW_ARTIFACT_SPECS.reviewA,
    REVIEW_ARTIFACT_SPECS.reviewB,
  ];
  if (
    reviewMethod?.coordinatorSession !== COORDINATOR_SESSION ||
    !Array.isArray(independent) ||
    independent.length !== expectedIndependent.length ||
    independent.some((reference, index) =>
      !matchesArtifactReference(reference, expectedIndependent[index])) ||
    !matchesArtifactReference(references?.tiebreak, REVIEW_ARTIFACT_SPECS.tiebreak)
  ) {
    throw new TypeError("Manual review provenance reference is invalid");
  }
}

function matchesArtifactReference(reference, expected) {
  return Boolean(reference) &&
    reference.role === expected.role &&
    reference.reviewId === expected.reviewId &&
    reference.reviewerCanonicalTask === expected.reviewerCanonicalTask &&
    reference.artifactPath === expected.artifactPath &&
    reference.sha256 === expected.sha256 &&
    sameOrderedValues(
      Object.keys(reference).sort(),
      ["role", "reviewId", "reviewerCanonicalTask", "artifactPath", "sha256"].sort(),
    );
}

function hasFrozenInputDigests(inputDigests) {
  return Boolean(inputDigests) &&
    inputDigests.benchmarkSha256 === FROZEN_BENCHMARK_SHA256 &&
    inputDigests.rawResultsSha256 === FROZEN_RAW_RESULTS_SHA256 &&
    sameOrderedValues(
      Object.keys(inputDigests).sort(),
      ["benchmarkSha256", "rawResultsSha256"].sort(),
    );
}

function isRecordedAt(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validateManualAdjudicationTable(table, reviewArtifacts) {
  if (
    table.schemaVersion !== 1 ||
    table.revision !== MANUAL_ADJUDICATION_REVISION ||
    table.benchmarkSha256 !== FROZEN_BENCHMARK_SHA256 ||
    table.rawResultsSha256 !== FROZEN_RAW_RESULTS_SHA256 ||
    table.ruleRevision !== MANUAL_RULE_REVISION ||
    !sameOrderedValues(table.questionOrder, FROZEN_QUESTION_IDS) ||
    !Array.isArray(table.questions) ||
    !sameOrderedValues(
      table.questions.map(({ questionId }) => questionId),
      FROZEN_QUESTION_IDS,
    )
  ) {
    throw new TypeError("Frozen manual adjudication identity is invalid");
  }
  if (
    table.reviewMethod?.policy !== REVIEW_POLICY ||
    table.reviewMethod.coordinatorSession !== COORDINATOR_SESSION ||
    !sameOrderedValues(
      table.reviewMethod.independentReviewRoles,
      INDEPENDENT_REVIEW_ROLES,
    ) ||
    table.reviewMethod.tiebreak?.role !== TIEBREAK_ROLE ||
    table.reviewMethod.tiebreak?.questionId !== TIEBREAK_QUESTION_ID ||
    table.reviewMethod.tiebreak?.trigger !== "independent-review-disagreement"
  ) {
    throw new TypeError("Frozen manual adjudication review method is invalid");
  }
  for (const decision of table.questions) validateManualDecision(decision);
  validateManualReviewProvenance({ table, ...reviewArtifacts });
}

function validateManualDecision(decision) {
  if (
    !Number.isInteger(decision.rawSequence) ||
    decision.rawSequence <= 0 ||
    decision.arm !== GRAPH_ARM ||
    typeof decision.correct !== "boolean" ||
    typeof decision.ambiguity !== "boolean" ||
    typeof decision.rationale !== "string" ||
    decision.rationale.trim().length === 0 ||
    !Array.isArray(decision.reviewProvenance?.independent) ||
    decision.reviewProvenance.independent.length !== 2
  ) {
    throw new TypeError(`Invalid manual adjudication decision: ${decision.questionId}`);
  }
  const independent = decision.reviewProvenance.independent;
  if (
    !sameOrderedValues(
      independent.map(({ role }) => role),
      INDEPENDENT_REVIEW_ROLES,
    ) ||
    independent.some(({ verdict }) => !["correct", "incorrect"].includes(verdict))
  ) {
    throw new TypeError(`Invalid independent review provenance: ${decision.questionId}`);
  }
  const finalVerdict = decision.correct ? "correct" : "incorrect";
  const verdicts = independent.map(({ verdict }) => verdict);
  if (decision.questionId === TIEBREAK_QUESTION_ID) {
    if (
      decision.ambiguity !== true ||
      new Set(verdicts).size !== 2 ||
      decision.reviewProvenance.tiebreak?.role !== TIEBREAK_ROLE ||
      decision.reviewProvenance.tiebreak?.verdict !== finalVerdict
    ) {
      throw new TypeError("direct-02 tiebreak provenance is invalid");
    }
    return;
  }
  if (
    decision.ambiguity !== false ||
    verdicts.some((verdict) => verdict !== finalVerdict) ||
    decision.reviewProvenance.tiebreak !== null
  ) {
    throw new TypeError(`Manual consensus provenance is invalid: ${decision.questionId}`);
  }
}

function adjudicateQuestion(question, answer, manualDecision) {
  if (
    manualDecision.rawSequence !== answer.sequence ||
    manualDecision.arm !== answer.arm
  ) {
    throw new TypeError(`Frozen manual decision does not match raw record: ${question.id}`);
  }
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

  return {
    questionId: question.id,
    validationStatus: answer.validationStatus,
    unknown: answer.unknown,
    evidenced: verified && missingCode.length === 0 && missingTests.length === 0,
    correct: manualDecision.correct,
    manualAdjudication: {
      rawSequence: manualDecision.rawSequence,
      arm: manualDecision.arm,
      ambiguity: manualDecision.ambiguity,
      rationale: manualDecision.rationale,
      reviewProvenance: manualDecision.reviewProvenance,
    },
    expectedCodeEvidence: expectedCode,
    matchedCodeEvidence: matchedCode,
    missingCodeEvidence: missingCode,
    expectedTestEvidence: expectedTests,
    matchedTestEvidence: matchedTests,
    missingTestEvidence: missingTests,
    answerTimeMs: answer.answerTimeMs,
  };
}

function gateFailures({
  correctAnswers,
  evidencedAnswers,
  inventedFiles,
  inventedRelations,
  medianTimeReduction,
}) {
  const failures = [];
  if (correctAnswers < FROZEN_PASS_GATE.minimumCorrectAnswers) {
    failures.push("correct-answers-below-10");
  }
  if (evidencedAnswers < FROZEN_PASS_GATE.requiredEvidencedAnswers) {
    failures.push("evidence-missing");
  }
  if (inventedFiles > FROZEN_PASS_GATE.maximumInventedFiles) {
    failures.push("invented-file");
  }
  if (inventedRelations > FROZEN_PASS_GATE.maximumInventedRelations) {
    failures.push("invented-relation");
  }
  if (medianTimeReduction < FROZEN_PASS_GATE.minimumMedianTimeReduction) {
    failures.push("median-time-reduction-below-25-percent");
  }
  return failures;
}

function validatePreAdjudicatedFixture({
  questionScores,
  graphAnswers,
  repositorySearchAnswers,
}) {
  if (
    !Array.isArray(questionScores) ||
    !sameOrderedValues(
      questionScores.map(({ questionId }) => questionId),
      FROZEN_QUESTION_IDS,
    ) ||
    questionScores.some(({ correct, evidenced }) =>
      typeof correct !== "boolean" || typeof evidenced !== "boolean")
  ) {
    throw new TypeError("Pre-adjudicated question scores are invalid");
  }
  validateMetricAnswers(graphAnswers, "graph");
  validateMetricAnswers(repositorySearchAnswers, "repository search");
}

function validateMetricAnswers(answers, label) {
  if (
    !Array.isArray(answers) ||
    answers.length !== FROZEN_QUESTION_IDS.length ||
    answers.some((answer) =>
      !Number.isFinite(answer.answerTimeMs) ||
      answer.answerTimeMs <= 0 ||
      !Array.isArray(answer.inventedFiles) ||
      !Array.isArray(answer.inventedRelations))
  ) {
    throw new TypeError(`Pre-adjudicated ${label} metrics are invalid`);
  }
}

function validateInputs(benchmark, raw) {
  if (
    benchmark.revision !== "impact-benchmark-v1" ||
    !benchmark.frozenAt ||
    !benchmark.analysisSnapshot ||
    !Array.isArray(benchmark.questions) ||
    !sameOrderedValues(
      benchmark.questions.map(({ id }) => id),
      FROZEN_QUESTION_IDS,
    )
  ) {
    throw new TypeError("Frozen Impact Benchmark identity is invalid");
  }
  if (!samePassGate(benchmark.passGate)) {
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

function samePassGate(gate) {
  return Object.entries(FROZEN_PASS_GATE)
    .every(([key, value]) => gate?.[key] === value);
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

function sameOrderedValues(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
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
