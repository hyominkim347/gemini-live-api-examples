import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_INPUT_SAMPLE_RATE,
  ProviderCanaryEvidence,
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
