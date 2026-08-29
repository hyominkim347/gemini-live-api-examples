import assert from "node:assert/strict";
import test from "node:test";

import { MeetingEventRecorder } from "../src/meeting-event-recorder.mjs";

test("record emits only the privacy-safe allowlist with an injected timestamp", () => {
  const written = [];
  const recorder = new MeetingEventRecorder({
    meetingId: "meeting-1",
    clock: () => 1_234,
    write(event) { written.push(event); },
  });

  recorder.record({
    type: "speech-started",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    language: "ja",
    result: "started",
    rawAudio: Buffer.from("private audio"),
    nested: {
      transcript: "private words",
      credentials: { apiKey: "secret-key" },
      resumptionHandle: "secret-handle",
    },
  });

  assert.deepEqual(written, [{
    type: "speech-started",
    meetingId: "meeting-1",
    participantId: "participant-1",
    utteranceId: "utterance-1",
    language: "ja",
    timestamp: 1_234,
    result: "started",
  }]);
  assert.equal(JSON.stringify(written).includes("private"), false);
  assert.equal(JSON.stringify(written).includes("secret"), false);
});

test("record rejects unknown event types and invalid safe-field values", () => {
  const recorder = new MeetingEventRecorder({ meetingId: "meeting-1", write() {} });

  assert.throws(() => recorder.record({ type: "raw-transcript", result: "ok" }), /event type/);
  assert.throws(
    () => recorder.record({ type: "speech-started", participantId: { raw: "participant-1" } }),
    /participantId/,
  );
});
