import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_INPUT_SAMPLE_RATE,
  ProviderCanaryEvidence,
  ProviderSemanticEvidence,
  publicationName,
} from "../src/provider-canary.mjs";

test("the provider canary sends Live Translate audio at 16 kHz", () => {
  assert.equal(GEMINI_INPUT_SAMPLE_RATE, 16_000);
});

test("provider canary completes only after the real LiveKit and Gemini signals", () => {
  const evidence = new ProviderCanaryEvidence();

  evidence.record("participantsConnected", 4);
  evidence.record("originalTrackSubscribed", true);
  evidence.record("geminiSetupComplete", true);
  evidence.record("translatedFrames", 3);
  evidence.record("translationTrackPublished", true);
  evidence.record("translationTrackSubscribed", true);
  evidence.record("listenerReceivedTranslatedAudio", true);
  evidence.record("freshSessionSetup", true);
  evidence.record("originalCheckExclusive", true);
  assert.equal(evidence.complete, false);

  evidence.record("phraseBoundary", true);
  evidence.record("translationRestoredAtBoundary", true);
  assert.equal(evidence.complete, true);
});

test("publicationName supports the rtc-node and browser LiveKit publication shapes", () => {
  assert.equal(publicationName({ name: "translation:ko" }), "translation:ko");
  assert.equal(
    publicationName({ trackName: "original:ja-1" }),
    "original:ja-1",
  );
  assert.equal(publicationName({}), null);
});

test("the original check must start before the phrase boundary and restore after it", () => {
  const evidence = new ProviderCanaryEvidence();

  assert.throws(
    () => evidence.record("phraseBoundary", true),
    /original check must start before the phrase boundary/,
  );
  evidence.record("originalCheckExclusive", true);
  evidence.record("phraseBoundary", true);
  evidence.record("translationRestoredAtBoundary", true);
});

test("bidirectional provider semantics require three distinct first and last meaning passes", () => {
  const evidence = new ProviderSemanticEvidence();
  for (const direction of ["ko-to-ja", "ja-to-ko"]) {
    for (let trial = 1; trial <= 3; trial += 1) {
      evidence.record({
        direction,
        trialId: `${direction}-${trial}`,
        firstMeaning: true,
        lastMeaning: true,
      });
    }
  }

  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.snapshot(), {
    ok: true,
    "ko-to-ja": [
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
    ],
    "ja-to-ko": [
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
      { firstMeaning: true, lastMeaning: true },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(evidence.snapshot()),
    /audio|pcm|transcript|translation|glossary|api.?key|token|handle|text/i,
  );
});

test("provider semantic evidence fails closed for duplicates, missing trials, or lost meaning", () => {
  const evidence = new ProviderSemanticEvidence();
  evidence.record({
    direction: "ko-to-ja",
    trialId: "ko-to-ja-1",
    firstMeaning: true,
    lastMeaning: false,
  });
  assert.equal(evidence.complete, false);
  assert.throws(() => evidence.record({
    direction: "ko-to-ja",
    trialId: "ko-to-ja-1",
    firstMeaning: true,
    lastMeaning: true,
  }), /duplicate semantic trial/);
  assert.throws(() => evidence.record({
    direction: "en-to-ko",
    trialId: "unsupported",
    firstMeaning: true,
    lastMeaning: true,
  }), /unsupported semantic direction/);
});
