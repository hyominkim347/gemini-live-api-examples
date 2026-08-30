import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjudicateAgentOnlyGate,
  FROZEN_BENCHMARK_SHA256,
  FROZEN_RAW_RESULTS_SHA256,
  verifyFrozenAgentOnlyInputs,
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
  assert.equal(result.contractVersion, 2);
  assert.deepEqual(result.scorer, {
    revision: "agent-only-gate-v3",
    inputContractVersion: 1,
    outputContractVersion: 2,
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

test("a descriptive paraphrase of the expected impact is semantically correct", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "침묵 hold 시간 변경은 SpeechActivityDetector의 발화 종료 판정 시점과 자동 utterance boundary를 직접 바꾼다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, true);
  assert.equal(result.questionScores[0].semanticCorrectness.correct, true);
  assert.equal(
    result.questionScores[0].semanticCorrectness.ruleRevision,
    "expected-summary-subject-bound-claims-v2",
  );
  assert.match(result.questionScores[0].semanticCorrectness.ruleDigest, /^[a-f0-9]{64}$/);
});

test("keyword coverage cannot hide a negated critical claim", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "Speech Activity Detector utterance 종료 자동 boundary. 판정은 하지 않는다. 이 변경은 영향을 준다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, false);
  assert.ok(
    result.questionScores[0].semanticCorrectness.failureCodes.includes("answer-contradictory"),
  );
});

test("a negated keep claim cannot satisfy the expected cross-layer behavior", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "cross-01",
  );
  answer.answer =
    "BrowserMeetingService가 utterance를 유지하지 않는다. GeminiLiveTranslateSocket의 handle을 제거하고 정확히 한 번 재시도한다. 관련 회의 cleanup 경로가 영향을 받는다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "cross-01");

  assert.equal(score.correct, false);
  assert.ok(score.semanticCorrectness.failureCodes.includes("answer-contradictory"));
});

test("a different subject cannot inherit another component's apply behavior", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "cross-02",
  );
  answer.answer =
    "MeetingSession이 참가자별 listening mode를 복귀시키고 track 및 gain 계획을 적용한다. BrowserAudioPlayout도 이 변경의 영향을 받는다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "cross-02");

  assert.equal(score.correct, false);
  assert.ok(score.semanticCorrectness.failureCodes.includes("claim-group-mismatch"));
});

test("an explicitly negated subject cannot own the expected predicate", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector가 아니라 BrowserAudioPlayout이 발화 종료 판정과 자동 utterance boundary 변경의 영향을 받는다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores[0];

  assert.equal(score.correct, false);
  assert.ok(score.semanticCorrectness.failureCodes.includes("answer-contradictory"));
  assert.ok(
    score.semanticCorrectness.claimGroups[0].failureCodes
      .includes("subject-atom-contradicted"),
  );
});

test("a keyword list without an asserted subject-predicate relation is incorrect", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector 발화 utterance 종료 boundary 판정 automatic hold 변경 영향.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores[0];

  assert.equal(score.correct, false);
  assert.ok(
    score.semanticCorrectness.claimGroups[0].failureCodes
      .includes("predicate-attribution-missing"),
  );
});

test("an inflected impact keyword cannot turn a list into a predicate", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector, 발화, 종료, 판정, 자동, utterance, boundary, impacts";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores[0];

  assert.equal(score.correct, false);
  assert.ok(
    score.semanticCorrectness.claimGroups[0].failureCodes
      .includes("predicate-attribution-missing"),
  );
});

test("an inflected impact keyword between list items is not a predicate", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector, 발화, 종료, 판정, 자동, utterance, impacts, boundary";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores[0];

  assert.equal(score.correct, false);
  assert.ok(
    score.semanticCorrectness.claimGroups[0].failureCodes
      .includes("predicate-attribution-missing"),
  );
});

test("an attributed predicate cannot borrow atoms from unrelated list segments", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "발화, 종료, 판정, 자동, utterance, SpeechActivityDetector impacts boundary";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores[0];

  assert.equal(score.correct, false);
  assert.ok(
    score.semanticCorrectness.claimGroups[0].failureCodes
      .includes("critical-atoms-missing"),
  );
});

test("a negative-control paraphrase preserves the expected no-impact meaning", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-01",
  );
  answer.answer =
    "아니요. command-line Node 예제는 kr-ja-meeting과 연결 관계가 없고 별도 실행된다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-01");

  assert.equal(score.correct, true);
  assert.equal(score.semanticCorrectness.correct, true);
  assert.equal(score.semanticCorrectness.expectedPolarity, "no-impact");
  assert.equal(score.semanticCorrectness.answerPolarity, "no-impact");
});

test("mixed independence and direct-impact cues fail as an explicit polarity conflict", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "Python Twilio 예제는 kr-ja-meeting의 LiveKit 및 Gemini socket 경로와 별도 실행 단위지만 직접 연결되어 영향을 받는다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.answerPolarity, "conflict");
  assert.ok(score.semanticCorrectness.failureCodes.includes("polarity-conflict"));
});

test("polarity conflict detection is order and clause invariant in Korean and English", async () => {
  const input = await fixture();
  const answers = [
    "Python Twilio 예제는 kr-ja-meeting에 직접 연결되어 영향을 받지만 별도 실행 단위다.",
    "Python Twilio 예제는 kr-ja-meeting과 별도 실행 단위다. 그러나 직접 연결되어 영향을 받는다.",
    "The Python Twilio example is an independent runtime unit, but it has a direct dependency on and impacts the kr-ja-meeting LiveKit and Gemini socket path.",
  ];

  for (const answerText of answers) {
    const raw = JSON.parse(input.rawText);
    const answer = raw.results.find(
      ({ arm, questionId }) =>
        arm === "understandAnythingGraph" && questionId === "negative-02",
    );
    answer.answer = answerText;
    const rawText = JSON.stringify(raw);
    const result = adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(rawText),
    });
    const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

    assert.equal(score.correct, false, answerText);
    assert.equal(score.semanticCorrectness.answerPolarity, "conflict", answerText);
    assert.ok(
      score.semanticCorrectness.failureCodes.includes("polarity-conflict"),
      answerText,
    );
  }
});

test("polarity scoping does not depend on a frozen example name", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "The Ruby Signal example is a separate runtime unit. It directly impacts the meeting socket path.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.answerPolarity, "conflict");
});

test("plural English subjects retain base-form impact polarity", async () => {
  const input = await fixture();
  const answers = [
    "The Ruby Signal examples are independent runtime units. The Ruby Signal examples directly impact the meeting socket path.",
    "The components are separate runtime units. They directly affect the meeting socket path.",
    "The modules are independent runtime units. They directly change the meeting socket path.",
    "The adapters are independent runtime units. They directly depend on the meeting socket path.",
  ];

  for (const answerText of answers) {
    const raw = JSON.parse(input.rawText);
    const answer = raw.results.find(
      ({ arm, questionId }) =>
        arm === "understandAnythingGraph" && questionId === "negative-02",
    );
    answer.answer = answerText;
    const rawText = JSON.stringify(raw);
    const result = adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(rawText),
    });
    const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

    assert.equal(score.correct, false, answerText);
    assert.equal(score.semanticCorrectness.answerPolarity, "conflict", answerText);
  }
});

test("equivalent technical subject spellings share one polarity scope", async () => {
  const input = await fixture();
  const answers = [
    "SpeechActivityDetector는 독립 실행 단위다. The speech activity detector directly impacts the meeting socket path.",
    "The SpeechActivityDetector is an independent runtime unit. SpeechActivityDetector directly impacts the meeting socket path.",
  ];

  for (const answerText of answers) {
    const raw = JSON.parse(input.rawText);
    const answer = raw.results.find(
      ({ arm, questionId }) =>
        arm === "understandAnythingGraph" && questionId === "negative-02",
    );
    answer.answer = answerText;
    const rawText = JSON.stringify(raw);
    const result = adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(rawText),
    });
    const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

    assert.equal(score.correct, false, answerText);
    assert.equal(score.semanticCorrectness.answerPolarity, "conflict", answerText);
  }
});

test("renamed unrelated subjects do not create a polarity conflict", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "The Ruby Signal example is a separate runtime unit. The Quartz Relay example directly impacts the meeting socket path.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.answerPolarity, "impact");
});

test("a negated dependency does not erase an asserted independence conflict", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "The Python Twilio example is separate, not connected, but directly impacts kr-ja-meeting.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.answerPolarity, "conflict");
  assert.ok(score.semanticCorrectness.failureCodes.includes("polarity-conflict"));
});

test("a negated same-runtime claim is not a positive dependency", async () => {
  const input = await fixture();
  const answers = [
    "Python Twilio 예제는 kr-ja-meeting과 같은 실행 단위가 아니다.",
    "The Python Twilio example is not the same runtime unit as kr-ja-meeting.",
  ];

  for (const answerText of answers) {
    const raw = JSON.parse(input.rawText);
    const answer = raw.results.find(
      ({ arm, questionId }) =>
        arm === "understandAnythingGraph" && questionId === "negative-02",
    );
    answer.answer = answerText;
    const rawText = JSON.stringify(raw);
    const result = adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(rawText),
    });
    const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

    assert.notEqual(score.semanticCorrectness.answerPolarity, "impact", answerText);
  }
});

test("negated independence cannot override a direct dependency and impact", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "Python Twilio example is not separate from kr-ja-meeting LiveKit and Gemini socket runtime. It has a direct dependency and impact.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.answerPolarity, "impact");
  assert.ok(score.semanticCorrectness.failureCodes.includes("polarity-mismatch"));
});

test("an unrelated impact assertion is semantically incorrect", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer = "BrowserAudioPlayout의 track 및 gain 계획이 직접 영향을 받는다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, false);
  assert.ok(
    result.questionScores[0].semanticCorrectness.failureCodes.includes("claim-group-mismatch"),
  );
});

test("audio and text does not satisfy the expected audio-only contract", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "direct-03",
  );
  answer.answer = input.benchmark.questions
    .find(({ id }) => id === "direct-03")
    .expectedAnswer.summary.replace("audio-only", "audio and text");
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "direct-03");

  assert.equal(score.correct, false);
  assert.deepEqual(
    score.semanticCorrectness.claimGroups[0].missingCriticalAtoms.map(({ concept }) => concept),
    ["only"],
  );
});

test("a positive dependency assertion fails a no-impact negative control", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(
    ({ arm, questionId }) =>
      arm === "understandAnythingGraph" && questionId === "negative-02",
  );
  answer.answer =
    "Python Twilio 예제는 kr-ja-meeting의 LiveKit 및 Gemini socket과 같은 실행 단위이고 직접 연결되어 영향을 준다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });
  const score = result.questionScores.find(({ questionId }) => questionId === "negative-02");

  assert.equal(score.correct, false);
  assert.equal(score.semanticCorrectness.expectedPolarity, "no-impact");
  assert.equal(score.semanticCorrectness.answerPolarity, "impact");
});

test("a scoped missing graph relation does not negate a positive impact claim", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector의 발화 종료 판정과 자동 utterance boundary가 직접 달라진다. 추가 하위 symbol 관계는 없다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, true);
  assert.equal(result.questionScores[0].semanticCorrectness.answerPolarity, "impact");
});

test("an unrelated denied dependency does not conflict with a scoped direct dependency", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "SpeechActivityDetector의 발화 종료 판정과 자동 utterance boundary가 MeetingSession에 직접 의존해 영향을 받는다. BrowserAudioPlayout과는 연결 관계가 없다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].semanticCorrectness.answerPolarity, "impact");
});

test("subject scope survives comma-coordinated unrelated denials", async () => {
  const input = await fixture();
  const answers = [
    "SpeechActivityDetector의 발화 종료 판정과 자동 utterance boundary가 MeetingSession에 직접 의존해 영향을 받지만, BrowserAudioPlayout과는 연결 관계가 없다.",
    "SpeechActivityDetector directly depends on MeetingSession and impacts the automatic utterance boundary, while BrowserAudioPlayout has no relation to it.",
  ];

  for (const answerText of answers) {
    const raw = JSON.parse(input.rawText);
    const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
    answer.answer = answerText;
    const rawText = JSON.stringify(raw);
    const result = adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(rawText),
    });

    assert.equal(
      result.questionScores[0].semanticCorrectness.answerPolarity,
      "impact",
      answerText,
    );
  }
});

test("NFKC normalization and reordered explanation preserve the same claim", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer =
    "추가 설명이다. 자동 utterance boundary와 발화 종료 판정 시점은 ＳｐｅｅｃｈＡｃｔｉｖｉｔｙＤｅｔｅｃｔｏｒ 변경으로 직접 달라진다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, true);
});

test("semantic correctness does not depend on a question id", async () => {
  const input = await fixture();
  const original = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText: input.rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: input.expectedRawSha256,
  });
  const renamedBenchmark = structuredClone(input.benchmark);
  renamedBenchmark.questions[0].id = "renamed-direct-question";
  const renamedBenchmarkText = JSON.stringify(renamedBenchmark);
  const renamedRawText = JSON.stringify(passingRaw(renamedBenchmark));
  const renamed = adjudicateAgentOnlyGate({
    benchmarkText: renamedBenchmarkText,
    rawText: renamedRawText,
    expectedBenchmarkSha256: sha256(renamedBenchmarkText),
    expectedRawSha256: sha256(renamedRawText),
  });

  assert.deepEqual(
    renamed.questionScores[0].semanticCorrectness,
    original.questionScores[0].semanticCorrectness,
  );
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
  assert.equal(result.metrics.correctAnswers, 12);
  assert.equal(result.metrics.evidencedAnswers, 11);
  assert.equal(result.questionScores[0].correct, true);
  assert.equal(result.questionScores[0].evidenced, false);
  assert.deepEqual(result.questionScores[0].missingCodeEvidence, [
    "poc/kr-ja-meeting/src/speech-activity-detector.mjs#SpeechActivityDetector",
  ]);
  assert.deepEqual(result.questionScores[0].missingTestEvidence, [
    "poc/kr-ja-meeting/test/speech-activity-detector.test.mjs#voice followed by sustained silence emits one automatic utterance boundary",
  ]);
});

test("opposite meaning is incorrect even when frozen evidence is complete", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer = "이 변경은 예상된 동작과 정반대이며 영향이 없다.";
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.resultRouting, "Agent Context Candidate");
  assert.equal(result.metrics.correctAnswers, 11);
  assert.equal(result.metrics.evidencedAnswers, 12);
  assert.equal(result.questionScores[0].correct, false);
  assert.equal(result.questionScores[0].evidenced, true);
  assert.equal(result.questionScores[0].semanticCorrectness.correct, false);
  assert.ok(result.questionScores[0].semanticCorrectness.failureCodes.includes("polarity-mismatch"));
});

test("meaning-changing punctuation is not normalized into a correct assertion", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.answer = `${answer.answer.slice(0, -1)}?`;
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].semanticCorrectness.correct, false);
  assert.equal(result.questionScores[0].correct, false);
  assert.equal(result.questionScores[0].evidenced, true);
});

test("correct meaning remains independent from invented or unverified evidence", async () => {
  const input = await fixture();
  const raw = JSON.parse(input.rawText);
  const answer = raw.results.find(({ arm }) => arm === "understandAnythingGraph");
  answer.validationStatus = "unsupported";
  answer.unverifiedEvidence = ["not verified"];
  answer.inventedFiles = ["invented.mjs"];
  const rawText = JSON.stringify(raw);

  const result = adjudicateAgentOnlyGate({
    benchmarkText: input.benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: sha256(rawText),
  });

  assert.equal(result.questionScores[0].correct, true);
  assert.equal(result.questionScores[0].evidenced, false);
  assert.equal(result.metrics.correctAnswers, 12);
  assert.equal(result.metrics.evidencedAnswers, 11);
  assert.equal(result.resultRouting, "Stop Rule");
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
  assert.equal(result.metrics.correctAnswers, 11);
  assert.equal(result.metrics.evidencedAnswers, 9);
  assert.equal(result.metrics.inventedFiles, 1);
  assert.equal(result.metrics.inventedRelations, 1);
  assert.deepEqual(result.failures, [
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

test("frozen input verification does not accept caller-selected digests", async () => {
  const input = await fixture();
  assert.throws(
    () => verifyFrozenAgentOnlyInputs({
      benchmarkText: input.benchmarkText,
      rawText: input.rawText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: input.expectedRawSha256,
    }),
    /digest mismatch/,
  );

  const changed = JSON.parse(input.rawText);
  changed.provider = "arbitrary-legacy-provider";
  const changedText = JSON.stringify(changed);
  assert.throws(
    () => adjudicateAgentOnlyGate({
      benchmarkText: input.benchmarkText,
      rawText: changedText,
      expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
      expectedRawSha256: sha256(changedText),
    }),
    /identity is invalid/,
  );
});

test("the frozen AIN-7643 raw artifact deterministically activates the Stop Rule", {
  skip: !existsSync(actualRawPath),
}, async () => {
  const [benchmarkText, rawText] = await Promise.all([
    readFile(benchmarkUrl, "utf8"),
    readFile(actualRawPath, "utf8"),
  ]);
  const verified = verifyFrozenAgentOnlyInputs({ benchmarkText, rawText });
  const result = adjudicateAgentOnlyGate({
    benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: FROZEN_RAW_RESULTS_SHA256,
  });
  const repeated = adjudicateAgentOnlyGate({
    benchmarkText,
    rawText,
    expectedBenchmarkSha256: FROZEN_BENCHMARK_SHA256,
    expectedRawSha256: FROZEN_RAW_RESULTS_SHA256,
  });

  assert.deepEqual(verified.provenance, {
    mode: "frozen-digest-provenance-v1",
    benchmarkSha256: FROZEN_BENCHMARK_SHA256,
    rawResultsSha256: FROZEN_RAW_RESULTS_SHA256,
    benchmarkRevision: "impact-benchmark-v1",
    analysisSnapshot: "5bf36dd61b6355368d736479c5ffb528b656d544",
    provider: "current-codex-provider-only",
    orderPolicy: "odd-graph-first-even-rg-first",
    timeoutMs: 600_000,
    completedRuns: 24,
  });
  assert.equal(result.resultRouting, "Stop Rule");
  assert.equal(result.metrics.correctAnswers, 5);
  assert.equal(result.metrics.evidencedAnswers, 0);
  assert.equal(result.metrics.inventedFiles, 0);
  assert.equal(result.metrics.inventedRelations, 0);
  assert.equal(result.metrics.graphMedianMs, 36_840.065);
  assert.equal(result.metrics.repositorySearchMedianMs, 33_217.775);
  assert.equal(result.metrics.medianTimeReduction, -0.109);
  assert.deepEqual(
    result.questionScores.filter(({ correct }) => correct).map(({ questionId }) => questionId),
    ["direct-01", "direct-02", "cross-02", "negative-01", "negative-02"],
  );
  assert.deepEqual(repeated, result);
  const retryAudit = result.questionScores
    .find(({ questionId }) => questionId === "cross-01")
    .semanticCorrectness.claimGroups[1].criticalAtoms;
  assert.ok(retryAudit.some(({ concept, surface }) => concept === "retry" && surface === "재시도"));
  assert.ok(retryAudit.every(({ surface }) => surface !== "재시"));
});
