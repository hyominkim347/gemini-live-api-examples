import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FROZEN_REVIEW_ARTIFACT_SHA256,
  validateManualReviewProvenance,
  verifyFrozenManualReviewArtifacts,
} from "../src/agent-only-pilot-gate.mjs";

const tableUrl = new URL(
  "../benchmark/agent-only-frozen-adjudication.v1.json",
  import.meta.url,
);
const reviewAUrl = new URL(
  "../benchmark/agent-only-manual-review-a.v1.json",
  import.meta.url,
);
const reviewBUrl = new URL(
  "../benchmark/agent-only-manual-review-b.v1.json",
  import.meta.url,
);
const tiebreakUrl = new URL(
  "../benchmark/agent-only-direct-02-tiebreak.v1.json",
  import.meta.url,
);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function provenanceInputs() {
  const [tableText, reviewAText, reviewBText, tiebreakText] = await Promise.all([
    readFile(tableUrl, "utf8"),
    readFile(reviewAUrl, "utf8"),
    readFile(reviewBUrl, "utf8"),
    readFile(tiebreakUrl, "utf8"),
  ]);
  return {
    table: JSON.parse(tableText),
    texts: { reviewAText, reviewBText, tiebreakText },
  };
}

test("the frozen review bundle binds two agent tasks and the direct-02 tiebreak", async () => {
  const { table, texts } = await provenanceInputs();
  const bundle = verifyFrozenManualReviewArtifacts(texts);
  const summary = validateManualReviewProvenance({ table, ...bundle });

  assert.deepEqual(summary.disagreementQuestionIds, ["direct-02"]);
  assert.equal(bundle.reviewA.questions.filter(({ correct }) => correct).length, 5);
  assert.equal(bundle.reviewB.questions.filter(({ correct }) => correct).length, 4);
  assert.equal(bundle.tiebreak.questionId, "direct-02");
  assert.equal(bundle.tiebreak.correct, false);
  assert.equal(bundle.tiebreak.ambiguity, true);
  assert.notEqual(
    bundle.reviewA.reviewerCanonicalTask,
    bundle.reviewB.reviewerCanonicalTask,
  );
  for (const artifact of [bundle.reviewA, bundle.reviewB, bundle.tiebreak]) {
    assert.equal(artifact.coordinatorSession, "01a04dff-c649-7eb2-b3d4-8c994ec4c6f7");
    assert.equal(artifact.reviewerKind, "codex-agent-task");
    assert.match(artifact.recordedAt, /^2026-08-30T03:2[12]:\d{2}Z$/);
    assert.equal(Object.hasOwn(artifact, "reviewedAt"), false);
    assert.equal(Object.hasOwn(artifact, "humanReviewer"), false);
  }
  assert.deepEqual(
    {
      reviewA: sha256(texts.reviewAText),
      reviewB: sha256(texts.reviewBText),
      tiebreak: sha256(texts.tiebreakText),
    },
    FROZEN_REVIEW_ARTIFACT_SHA256,
  );
});

test("missing or tampered review artifacts fail closed", async () => {
  const { texts } = await provenanceInputs();
  const tamperedReview = JSON.parse(texts.reviewAText);
  tamperedReview.questions[0].correct = false;

  assert.throws(
    () => verifyFrozenManualReviewArtifacts({ ...texts, reviewBText: null }),
    /Manual review B artifact digest mismatch/,
  );
  assert.throws(
    () => verifyFrozenManualReviewArtifacts({
      ...texts,
      reviewAText: JSON.stringify(tamperedReview),
    }),
    /Manual review A artifact digest mismatch/,
  );
});

test("the independent reviews cannot resolve to the same canonical task", async () => {
  const { table, texts } = await provenanceInputs();
  const bundle = verifyFrozenManualReviewArtifacts(texts);
  const sameReviewer = structuredClone(bundle.reviewB);
  sameReviewer.reviewerCanonicalTask = bundle.reviewA.reviewerCanonicalTask;

  assert.throws(
    () => validateManualReviewProvenance({
      table,
      reviewA: bundle.reviewA,
      reviewB: sameReviewer,
      tiebreak: bundle.tiebreak,
    }),
    /Independent review canonical tasks must differ/,
  );
});

test("the sole disagreement requires a false direct-02 tiebreak", async () => {
  const { table, texts } = await provenanceInputs();
  const bundle = verifyFrozenManualReviewArtifacts(texts);

  assert.throws(
    () => validateManualReviewProvenance({
      table,
      reviewA: bundle.reviewA,
      reviewB: bundle.reviewB,
    }),
    /direct-02 tiebreak artifact is required/,
  );

  const extraDisagreement = structuredClone(bundle.reviewB);
  extraDisagreement.questions.find(({ questionId }) => questionId === "direct-03")
    .correct = true;
  assert.throws(
    () => validateManualReviewProvenance({
      table,
      reviewA: bundle.reviewA,
      reviewB: extraDisagreement,
      tiebreak: bundle.tiebreak,
    }),
    /Only direct-02 may require a tiebreak/,
  );

  const passingTiebreak = { ...bundle.tiebreak, correct: true };
  assert.throws(
    () => validateManualReviewProvenance({
      table,
      reviewA: bundle.reviewA,
      reviewB: bundle.reviewB,
      tiebreak: passingTiebreak,
    }),
    /direct-02 tiebreak must resolve to incorrect/,
  );
});

test("the table must reference every exact provenance artifact digest", async () => {
  const { table, texts } = await provenanceInputs();
  const bundle = verifyFrozenManualReviewArtifacts(texts);
  const changedTable = structuredClone(table);
  changedTable.reviewMethod.provenanceArtifacts.independentReviews[0].sha256 =
    "0".repeat(64);

  assert.throws(
    () => validateManualReviewProvenance({ table: changedTable, ...bundle }),
    /Manual review provenance reference is invalid/,
  );
});
