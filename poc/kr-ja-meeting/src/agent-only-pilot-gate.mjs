import { createHash } from "node:crypto";

export const FROZEN_BENCHMARK_SHA256 =
  "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6";
export const FROZEN_RAW_RESULTS_SHA256 =
  "6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0";

const PROVIDER = "current-codex-provider-only";
const ORDER_POLICY = "odd-graph-first-even-rg-first";
const GRAPH_ARM = "understandAnythingGraph";
const RG_ARM = "repositorySearchRg";
const SCORER_REVISION = "agent-only-gate-v3";
const OUTPUT_CONTRACT_VERSION = 2;
const SEMANTIC_RULE_REVISION = "expected-summary-subject-bound-claims-v1";
const SOFT_MATCH_NUMERATOR = 2;
const SOFT_MATCH_DENOMINATOR = 3;
const ANSWER_CLAUSE_WINDOW = 1;

const SEMANTIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "가",
  "과",
  "관련",
  "그",
  "및",
  "받는다",
  "보장",
  "복구",
  "사이",
  "사이에",
  "영향",
  "없다",
  "없음",
  "또는",
  "와",
  "을",
  "이",
  "있다",
  "직접",
  "함께",
  "한다",
  "한다는",
  "동작",
  "경로",
  "단위",
  "단위다",
  "후",
]);

const SEMANTIC_CONCEPT_DEFINITIONS = [
  { concept: "utterance", kind: "entity", aliases: ["utterance", "발화"] },
  { concept: "boundary", kind: "action", aliases: ["boundary", "경계", "종료"] },
  { concept: "decision", kind: "action", aliases: ["decision", "판정", "확정", "조건"] },
  { concept: "automatic", kind: "modifier", aliases: ["automatic", "자동"] },
  { concept: "listening", kind: "entity", aliases: ["listening", "청취", "듣기"] },
  { concept: "create", kind: "action", aliases: ["create", "make", "만들", "만드"] },
  { concept: "plan", kind: "entity", aliases: ["plan", "계획"] },
  { concept: "translation", kind: "entity", aliases: ["translation", "번역"] },
  { concept: "only", kind: "modifier", aliases: ["only", "전용", "배타"] },
  { concept: "original", kind: "entity", aliases: ["original", "원음"] },
  { concept: "check", kind: "action", aliases: ["check", "확인"] },
  { concept: "audio", kind: "entity", aliases: ["audio", "음성"] },
  { concept: "session", kind: "entity", aliases: ["session", "세션"] },
  { concept: "resumption", kind: "entity", aliases: ["resumption", "resume", "재개"] },
  { concept: "keep", kind: "action", aliases: ["keep", "retain", "maintain", "유지"] },
  { concept: "handle", kind: "entity", aliases: ["handle", "핸들"] },
  { concept: "remove", kind: "action", aliases: ["remove", "clear", "제거", "지우", "비우"] },
  { concept: "once", kind: "modifier", aliases: ["once", "단일"] },
  { concept: "retry", kind: "action", aliases: ["retry", "재시도"] },
  { concept: "cleanup", kind: "action", aliases: ["cleanup", "정리"] },
  { concept: "meeting", kind: "entity", aliases: ["meeting", "회의"] },
  { concept: "participant", kind: "entity", aliases: ["participant", "참가자", "개인"] },
  { concept: "mode", kind: "entity", aliases: ["mode", "모드"] },
  { concept: "restore", kind: "action", aliases: ["restore", "return", "복귀", "돌아"] },
  { concept: "apply", kind: "action", aliases: ["apply", "적용", "전환"] },
  { concept: "track", kind: "entity", aliases: ["track", "트랙"] },
  { concept: "hold", kind: "modifier", aliases: ["hold", "대기"] },
  { concept: "drain", kind: "action", aliases: ["drain", "드레인"] },
  { concept: "close", kind: "action", aliases: ["close", "닫", "중지", "중단"] },
  { concept: "next", kind: "modifier", aliases: ["next", "다음"] },
  { concept: "subscription", kind: "entity", aliases: ["subscription", "subscribe", "구독"] },
  { concept: "order", kind: "action", aliases: ["order", "sequence", "순서"] },
  { concept: "browser", kind: "entity", aliases: ["browser", "브라우저"] },
  { concept: "playout", kind: "entity", aliases: ["playout", "재생"] },
  { concept: "failure", kind: "entity", aliases: ["failure", "실패"] },
  { concept: "event", kind: "entity", aliases: ["event", "이벤트", "사건"] },
  { concept: "recorder", kind: "entity", aliases: ["recorder", "기록"] },
  { concept: "correlated", kind: "modifier", aliases: ["correlated", "상관"] },
  { concept: "timeline", kind: "entity", aliases: ["timeline", "타임라인"] },
  { concept: "expired", kind: "modifier", aliases: ["expired", "만료"] },
  { concept: "reconnect", kind: "action", aliases: ["reconnect", "재연결"] },
  { concept: "socket", kind: "entity", aliases: ["socket", "소켓"] },
  { concept: "contaminate", kind: "action", aliases: ["contaminate", "오염"] },
  { concept: "wait", kind: "action", aliases: ["wait", "기다"] },
  { concept: "bridge", kind: "entity", aliases: ["bridge", "브리지"] },
  { concept: "microphone", kind: "entity", aliases: ["microphone", "마이크"] },
  { concept: "prevent-residue", kind: "action", aliases: ["prevent", "남기지"] },
  { concept: "privacy", kind: "entity", aliases: ["privacy", "개인정보"] },
  { concept: "safe", kind: "modifier", aliases: ["safe", "안전"] },
  { concept: "allowlist", kind: "entity", aliases: ["allowlist", "허용"] },
  { concept: "field", kind: "entity", aliases: ["field", "필드"] },
  { concept: "memory", kind: "entity", aliases: ["memory", "메모리"] },
  { concept: "store", kind: "action", aliases: ["store", "storage", "보관", "저장"] },
  { concept: "end", kind: "modifier", aliases: ["end", "종료"] },
  { concept: "dispose", kind: "action", aliases: ["dispose", "discard", "delete", "폐기", "삭제"] },
  { concept: "example", kind: "entity", aliases: ["example", "예제"] },
  { concept: "package", kind: "entity", aliases: ["package", "패키지"] },
  { concept: "runtime", kind: "entity", aliases: ["runtime", "실행"] },
  { concept: "dependency", kind: "entity", aliases: ["dependency", "relationship", "relation", "의존", "관계", "연결"] },
  { concept: "separate", kind: "modifier", aliases: ["separate", "independent", "별도", "독립"] },
  { concept: "command", kind: "entity", aliases: ["command", "cli"] },
  { concept: "line", kind: "entity", aliases: ["line", "cli"] },
  { concept: "kr", kind: "entity", aliases: ["kr", "한국어"] },
  { concept: "ja", kind: "entity", aliases: ["ja", "일본어"] },
];

const CRITICAL_SEMANTIC_CONCEPTS = [
  "boundary",
  "decision",
  "create",
  "only",
  "check",
  "keep",
  "remove",
  "once",
  "retry",
  "cleanup",
  "restore",
  "apply",
  "hold",
  "drain",
  "close",
  "next",
  "order",
  "reconnect",
  "contaminate",
  "wait",
  "prevent-residue",
  "store",
  "end",
  "dispose",
];
const CRITICAL_SEMANTIC_CONCEPT_SET = new Set(CRITICAL_SEMANTIC_CONCEPTS);
const SEMANTIC_RULE_DEFINITION = {
  revision: SEMANTIC_RULE_REVISION,
  answerClauseWindow: ANSWER_CLAUSE_WINDOW,
  expectedClausePolicy: "sentence-comma-and-technical-subject-conjunction",
  answerClausePolicy: "sentence",
  atomNegationPolicy: "explicit-marker-two-before-three-after-v2",
  identifierPolicy: "full-or-two-thirds-subtokens",
  polarityPolicy: "explicit-impact-or-explicit-independence-v1",
  softMatch: `${SOFT_MATCH_NUMERATOR}/${SOFT_MATCH_DENOMINATOR}`,
  criticalMatch: "all",
  subjectMatch: "each-predicate-clause-leading-identifier-or-first-entity-all",
  claimGroupMatch: "all",
  criticalConcepts: CRITICAL_SEMANTIC_CONCEPTS,
  stopWords: [...SEMANTIC_STOP_WORDS].sort(),
  concepts: SEMANTIC_CONCEPT_DEFINITIONS,
};
const SEMANTIC_RULE_DIGEST = sha256(JSON.stringify(SEMANTIC_RULE_DEFINITION));

export function adjudicateAgentOnlyGate({
  benchmarkText,
  rawText,
  expectedBenchmarkSha256 = FROZEN_BENCHMARK_SHA256,
  expectedRawSha256 = FROZEN_RAW_RESULTS_SHA256,
}) {
  const { benchmark, raw } = verifyAgentOnlyInputs({
    benchmarkText,
    rawText,
    expectedBenchmarkSha256,
    expectedRawSha256,
  });

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

export function verifyFrozenAgentOnlyInputs({
  benchmarkText,
  rawText,
}) {
  return verifyAgentOnlyInputs({
    benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: FROZEN_RAW_RESULTS_SHA256,
  });
}

function verifyAgentOnlyInputs({
  benchmarkText,
  rawText,
  expectedBenchmarkSha256,
  expectedRawSha256,
}) {
  requireDigest(benchmarkText, expectedBenchmarkSha256, "Frozen Impact Benchmark");
  requireDigest(rawText, expectedRawSha256, "Agent Lane raw artifact");

  const benchmark = parseJson(benchmarkText, "Frozen Impact Benchmark");
  const raw = parseJson(rawText, "Agent Lane raw artifact");
  validateInputs(benchmark, raw);

  return {
    benchmark,
    raw,
    provenance: {
      mode: "frozen-digest-provenance-v1",
      benchmarkSha256: expectedBenchmarkSha256,
      rawResultsSha256: expectedRawSha256,
      benchmarkRevision: benchmark.revision,
      analysisSnapshot: benchmark.analysisSnapshot,
      provider: raw.provider,
      orderPolicy: raw.orderPolicy,
      timeoutMs: raw.timeoutMs,
      completedRuns: raw.completedRuns,
    },
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
  const semanticCorrectness = evaluateSemanticCorrectness(
    question.expectedAnswer.summary,
    answer.answer,
    { unknown: answer.unknown },
  );
  const correct = semanticCorrectness.correct;

  return {
    questionId: question.id,
    validationStatus: answer.validationStatus,
    unknown: answer.unknown,
    evidenced,
    correct,
    semanticCorrectness,
    expectedCodeEvidence: expectedCode,
    matchedCodeEvidence: matchedCode,
    missingCodeEvidence: missingCode,
    expectedTestEvidence: expectedTests,
    matchedTestEvidence: matchedTests,
    missingTestEvidence: missingTests,
    answerTimeMs: answer.answerTimeMs,
  };
}

function evaluateSemanticCorrectness(expectedSummary, answer, { unknown }) {
  const expectedPolarity = semanticPolarity(expectedSummary);
  const answerPolarity = semanticPolarity(answer);
  const interrogative = /\?\s*$/.test(answer.normalize("NFKC").trim());
  const answerClauses = splitAnswerClauses(answer);
  const answerWindows = clauseWindows(answerClauses).map(({ text, indexes }) => ({
    indexes,
    atoms: semanticAtoms(text),
  }));
  const expectedClauses = splitExpectedClaimClauses(expectedSummary)
    .map((text) => ({ text, atoms: semanticAtoms(text) }))
    .filter(({ atoms }) => atoms.length > 0);

  let inheritedSubjectAtoms = [];
  const claimGroups = expectedClauses.map(({ text, atoms }, index) => {
    const ownSubjectAtoms = subjectAtomsForClaim(text, atoms);
    const subjectAtoms = ownSubjectAtoms.length > 0
      ? ownSubjectAtoms
      : inheritedSubjectAtoms;
    if (ownSubjectAtoms.length > 0) inheritedSubjectAtoms = ownSubjectAtoms;
    return scoreClaimGroup({
      index,
      text,
      atoms,
      subjectAtoms,
      answerWindows,
      polarityCompatible: expectedPolarity === answerPolarity,
    });
  });

  const failureCodes = [];
  if (unknown) failureCodes.push("answer-unknown");
  if (interrogative) failureCodes.push("answer-interrogative");
  if (
    answerPolarity === "contradictory" ||
    claimGroups.some(({ contradictedCriticalAtoms }) => contradictedCriticalAtoms.length > 0)
  ) {
    failureCodes.push("answer-contradictory");
  }
  if (expectedPolarity !== answerPolarity) failureCodes.push("polarity-mismatch");
  if (claimGroups.length === 0) failureCodes.push("expected-claims-empty");
  if (claimGroups.some(({ passed }) => !passed)) failureCodes.push("claim-group-mismatch");
  const correct = failureCodes.length === 0;

  return {
    ruleRevision: SEMANTIC_RULE_REVISION,
    ruleDigest: SEMANTIC_RULE_DIGEST,
    expectedPolarity,
    answerPolarity,
    guards: {
      unknown,
      interrogative,
      polarityCompatible: expectedPolarity === answerPolarity,
    },
    claimGroups,
    failureCodes,
    correct,
  };
}

function scoreClaimGroup({
  index,
  text,
  atoms,
  subjectAtoms,
  answerWindows,
  polarityCompatible,
}) {
  const criticalAtoms = atoms.filter(({ concept }) =>
    CRITICAL_SEMANTIC_CONCEPT_SET.has(concept));
  const softAtoms = atoms.filter(({ concept }) =>
    !CRITICAL_SEMANTIC_CONCEPT_SET.has(concept));
  const requiredSoftMatches = Math.ceil(
    (softAtoms.length * SOFT_MATCH_NUMERATOR) / SOFT_MATCH_DENOMINATOR,
  );
  const subjectClauses = answerWindows.flatMap((window) => {
    const matchedSubjectAtoms = matchSemanticAtoms(subjectAtoms, window.atoms);
    const missingSubjectAtoms = missingSemanticAtoms(subjectAtoms, matchedSubjectAtoms);
    const subjectPassed = subjectAtoms.length > 0 && missingSubjectAtoms.length === 0;
    return subjectPassed ? [{
      answerClauseIndexes: window.indexes,
      matchedSubjectAtoms,
      atoms: window.atoms,
    }] : [];
  });
  const subjectScopedAtoms = subjectClauses.flatMap(({ atoms }) => atoms);
  const matchedCriticalAtoms = matchSemanticAtoms(criticalAtoms, subjectScopedAtoms);
  const matchedSoftAtoms = matchSemanticAtoms(softAtoms, subjectScopedAtoms);
  const matchedSubjectAtoms = matchSemanticAtoms(subjectAtoms, subjectScopedAtoms);
  const missingCriticalAtoms = missingSemanticAtoms(criticalAtoms, matchedCriticalAtoms);
  const missingSoftAtoms = missingSemanticAtoms(softAtoms, matchedSoftAtoms);
  const missingSubjectAtoms = missingSemanticAtoms(subjectAtoms, matchedSubjectAtoms);
  const contradictedCriticalAtoms = criticalAtoms
    .filter((expectedAtom) => subjectScopedAtoms.some((answerAtom) =>
      answerAtom.concept === expectedAtom.concept &&
      answerAtom.negated !== expectedAtom.negated))
    .map(({ concept, kind, surface, negated }) => ({ concept, kind, surface, negated }));
  const criticalPassed =
    missingCriticalAtoms.length === 0 && contradictedCriticalAtoms.length === 0;
  const softPassed = matchedSoftAtoms.length >= requiredSoftMatches;
  const subjectPassed = subjectClauses.length > 0;
  const passed = polarityCompatible && criticalPassed && softPassed && subjectPassed;
  const failureCodes = [];
  if (!polarityCompatible) failureCodes.push("polarity-mismatch");
  if (missingCriticalAtoms.length > 0) failureCodes.push("critical-atoms-missing");
  if (contradictedCriticalAtoms.length > 0) failureCodes.push("critical-atom-contradicted");
  if (!softPassed) failureCodes.push("soft-atom-coverage-below-two-thirds");
  if (!subjectPassed) failureCodes.push("subject-atom-missing");

  return {
    index,
    expectedClause: text,
    criticalAtoms: atomAudit(criticalAtoms),
    softAtoms: atomAudit(softAtoms),
    requiredSoftMatches,
    subjectAtoms: atomAudit(subjectAtoms),
    answerClauseIndexes: subjectClauses.flatMap(({ answerClauseIndexes }) =>
      answerClauseIndexes),
    matchedCriticalAtoms,
    missingCriticalAtoms,
    matchedSoftAtoms,
    missingSoftAtoms,
    matchedSubjectAtoms,
    missingSubjectAtoms,
    contradictedCriticalAtoms,
    criticalPassed,
    softPassed,
    subjectPassed,
    passed,
    failureCodes,
  };
}

function matchSemanticAtoms(expectedAtoms, answerAtoms) {
  const answerByConcept = new Map(
    answerAtoms.map((atom) => [semanticAtomKey(atom), atom]),
  );
  return expectedAtoms.flatMap((expectedAtom) => {
    let answerAtom = answerByConcept.get(semanticAtomKey(expectedAtom));
    let aliasRule;
    if (!answerAtom && expectedAtom.identifierSubconcepts?.length > 0) {
      const matchedSubconcepts = expectedAtom.identifierSubconcepts.filter((concept) =>
        answerByConcept.has(`${concept}:asserted`));
      const required = Math.ceil(
        (expectedAtom.identifierSubconcepts.length * SOFT_MATCH_NUMERATOR) /
          SOFT_MATCH_DENOMINATOR,
      );
      if (matchedSubconcepts.length >= required) {
        answerAtom = {
          surface: matchedSubconcepts
            .map((concept) => answerByConcept.get(`${concept}:asserted`).surface)
            .join(" + "),
        };
        aliasRule = "identifier-subtokens-two-thirds";
      }
    }
    if (!answerAtom) return [];
    return [{
      concept: expectedAtom.concept,
      kind: expectedAtom.kind,
      negated: expectedAtom.negated,
      expectedSurface: expectedAtom.surface,
      answerSurface: answerAtom.surface,
      aliasRule: aliasRule ?? (expectedAtom.surface === answerAtom.surface
        ? "normalized-token"
        : "versioned-ko-en-alias"),
    }];
  });
}

function missingSemanticAtoms(expectedAtoms, matchedAtoms) {
  const matched = new Set(matchedAtoms.map(semanticAtomKey));
  return atomAudit(expectedAtoms.filter((atom) => !matched.has(semanticAtomKey(atom))));
}

function atomAudit(atoms) {
  return atoms.map(({ concept, kind, surface, identifierSubconcepts, negated = false }) => ({
    concept,
    kind,
    surface,
    negated,
    ...(identifierSubconcepts ? { identifierSubconcepts } : {}),
  }));
}

function semanticAtomKey({ concept, negated = false }) {
  return `${concept}:${negated ? "negated" : "asserted"}`;
}

function semanticPolarity(value) {
  const normalized = normalizeSemanticText(value);
  if (/\?\s*$/.test(value.normalize("NFKC").trim()) || /(?:^|\s)(?:unknown|모름|알\s+수\s+없)/u.test(normalized)) {
    return "uncertain";
  }
  if (/(?:정반대|opposite)/u.test(normalized)) return "contradictory";

  const positiveImpact = /(?:영향|달라|바꾸|변경|affect|impact|change)/u.test(normalized);
  const explicitNoImpact =
    /영향[^.!?]{0,20}(?:없|않)/u.test(normalized) ||
    /(?:no|without)\s+(?:direct\s+)?impact/u.test(normalized);
  const independence =
    /(?:별도|독립)\s*(?:실행|단위)?/u.test(normalized) ||
    /(?:separate|independent)(?:\s+(?:runtime|unit))?/u.test(normalized);
  const deniedDependency =
    /(?:관련|연결|의존|dependency|relationship|relation)[^.!?]{0,20}(?:없|않|no|not)/u.test(normalized);
  const negativeLead = /^(?:아니요|no)(?:\s|$)/u.test(normalized);
  if (explicitNoImpact || independence || (deniedDependency && (negativeLead || !positiveImpact))) {
    return "no-impact";
  }
  if (positiveImpact) return "impact";
  return "unspecified";
}

function semanticAtoms(value) {
  const atoms = [];
  for (const identifier of technicalIdentifiers(value)) {
    atoms.push({
      concept: `identifier:${identifier.normalize("NFKC").toLocaleLowerCase("und")}`,
      kind: "entity",
      surface: identifier,
      negated: false,
      identifierSubconcepts: identifierConcepts(identifier),
    });
  }
  const tokens = semanticTokens(value);
  for (const [index, token] of tokens.entries()) {
    const definitions = definitionsForToken(token);
    if (definitions.length === 0) {
      const forms = koreanParticleForms(token);
      const canonical = forms.at(-1);
      if (
        !forms.some((form) => SEMANTIC_STOP_WORDS.has(form)) &&
        canonical.length > 1
      ) {
        atoms.push({
          concept: canonical,
          kind: "entity",
          surface: token,
          negated: tokenIsNegated(tokens, index),
        });
      }
      continue;
    }
    for (const definition of definitions) {
      atoms.push({
        concept: definition.concept,
        kind: definition.kind,
        surface: token,
        negated: tokenIsNegated(tokens, index),
      });
    }
  }
  const unique = new Map();
  for (const atom of atoms) {
    const key = semanticAtomKey(atom);
    if (!unique.has(key)) unique.set(key, atom);
  }
  return [...unique.values()];
}

function tokenIsNegated(tokens, index) {
  const window = tokens.slice(Math.max(0, index - 2), index + 4);
  return window.some((value) => /^(?:않|없|아니|못|not|never|without)/u.test(value));
}

function subjectAtomsForClaim(text, atoms) {
  const normalizedText = text.normalize("NFKC").trim();
  const leadingIdentifier = technicalIdentifiers(normalizedText)
    .find((identifier) => normalizedText.startsWith(identifier));
  if (leadingIdentifier) {
    const concept = `identifier:${leadingIdentifier.normalize("NFKC").toLocaleLowerCase("und")}`;
    const identifierAtom = atoms.find((atom) => atom.concept === concept);
    return identifierAtom ? [identifierAtom] : [];
  }
  const firstEntity = atoms.find(({ kind }) => kind === "entity");
  return firstEntity ? [firstEntity] : [];
}

function identifierConcepts(identifier) {
  const concepts = [];
  for (const token of normalizeSemanticText(identifier).split(" ")) {
    const definitions = definitionsForToken(token);
    const values = definitions.length > 0
      ? definitions.map(({ concept }) => concept)
      : [token];
    for (const concept of values) {
      if (!concepts.includes(concept)) concepts.push(concept);
    }
  }
  return concepts;
}

function definitionsForToken(token) {
  const forms = koreanParticleForms(token);
  return SEMANTIC_CONCEPT_DEFINITIONS.filter(({ aliases }) =>
    aliases.some((alias) => forms.some((form) => semanticAliasMatches(form, alias))));
}

function semanticAliasMatches(token, alias) {
  if (token === alias) return true;
  if (/^[가-힣]{2,}$/u.test(alias) && token.startsWith(alias)) return true;
  if (/^[a-z][a-z0-9-]+$/u.test(alias) && token === `${alias}s`) return true;
  return false;
}

function technicalIdentifiers(value) {
  return value.normalize("NFKC").match(/\b[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g) ?? [];
}

function semanticTokens(value) {
  return normalizeSemanticText(value).split(" ").filter(Boolean);
}

function normalizeSemanticText(value) {
  return value
    .normalize("NFKC")
    .replace(/정확히\s+한\s+번(?:만)?/gu, " once ")
    .replace(/한\s+번(?:만)?/gu, " once ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z0-9])([가-힣])/g, "$1 $2")
    .replace(/([가-힣])([A-Za-z0-9])/g, "$1 $2")
    .toLocaleLowerCase("und")
    .replace(/[^a-z0-9가-힣]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function koreanParticleForms(token) {
  if (!/^[가-힣]{3,}$/u.test(token)) return [token];
  const stripped = token.replace(/(?:에서는|에서|으로|에게|까지|부터|처럼|보다|하고|이며|은|는|이|가|을|를|과|와)$/u, "");
  return stripped.length >= 2 && stripped !== token ? [token, stripped] : [token];
}

function splitExpectedClaimClauses(value) {
  return value
    .normalize("NFKC")
    .split(/[,;!?]+|(?<=[가-힣])\.(?=\s|$)/u)
    .flatMap((clause) => clause.split(/(?:와|과)\s+(?=[A-Z])/u))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function splitAnswerClauses(value) {
  return value
    .normalize("NFKC")
    .split(/[;!?]+|(?<=[가-힣])\.(?=\s|$)/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function clauseWindows(clauses) {
  const windows = [];
  for (let start = 0; start < clauses.length; start += 1) {
    for (
      let length = 1;
      length <= ANSWER_CLAUSE_WINDOW && start + length <= clauses.length;
      length += 1
    ) {
      windows.push({
        indexes: Array.from({ length }, (_, offset) => start + offset),
        text: clauses.slice(start, start + length).join(". "),
      });
    }
  }
  return windows;
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
