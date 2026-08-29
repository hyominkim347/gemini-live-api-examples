import assert from "node:assert/strict";
import test from "node:test";

import { SpeechActivityDetector } from "../src/speech-activity-detector.mjs";

test("voice followed by sustained silence emits one automatic utterance boundary", () => {
  const events = [];
  const detector = new SpeechActivityDetector({
    onEvent: (event) => events.push(event),
    speechThreshold: 0.05,
    silenceMilliseconds: 500,
  });

  detector.observe(0.01, 0);
  detector.observe(0.08, 100);
  detector.observe(0.09, 250);
  detector.observe(0.01, 600);
  detector.observe(0.01, 749);
  detector.observe(0.01, 750);
  detector.observe(0.01, 1_000);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 100 },
    { type: "speech-end", observedAt: 750 },
  ]);
});

test("stopping the detector closes a currently speaking utterance", () => {
  const events = [];
  const detector = new SpeechActivityDetector({ onEvent: (event) => events.push(event) });

  detector.observe(1, 10);
  detector.stop(20);
  detector.stop(30);

  assert.deepEqual(events, [
    { type: "speech-start", observedAt: 10 },
    { type: "speech-end", observedAt: 20 },
  ]);
});
