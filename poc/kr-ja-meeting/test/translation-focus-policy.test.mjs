import assert from "node:assert/strict";
import test from "node:test";

import { TranslationFocusPolicy } from "../src/translation-focus-policy.mjs";

test("first speaker keeps focus through a short overlap and hands off after ending", () => {
  let now = 0;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    minimumFocusHoldMilliseconds: 500,
    overlapWarningMilliseconds: 1_000,
  });

  policy.speechStarted("ja-1");
  now = 100;
  policy.speechStarted("ko-1");

  now = 499;
  assert.deepEqual(policy.snapshot(), {
    speakingParticipantIds: ["ja-1", "ko-1"],
    translationFocusId: "ja-1",
    focusSelectedAt: 0,
    focusProtectedUntil: 500,
    overlap: {
      active: true,
      detected: false,
      participantIds: ["ja-1", "ko-1"],
      startedAt: 100,
      message: null,
    },
  });

  now = 600;
  policy.speechEnded("ja-1");
  assert.equal(policy.snapshot().translationFocusId, "ko-1");
  assert.deepEqual(policy.snapshot().speakingParticipantIds, ["ko-1"]);
});

test("long overlap becomes a warning without removing either speaker", () => {
  let now = 10;
  const policy = new TranslationFocusPolicy({
    clock: () => now,
    overlapWarningMilliseconds: 1_000,
  });
  policy.speechStarted("ja-1");
  now = 30;
  policy.speechStarted("ko-1");

  now = 1_030;
  assert.deepEqual(policy.snapshot().overlap, {
    active: true,
    detected: true,
    participantIds: ["ja-1", "ko-1"],
    startedAt: 30,
    message: "동시에 말하고 있어 일부 통역이 불완전할 수 있습니다.",
  });
});
