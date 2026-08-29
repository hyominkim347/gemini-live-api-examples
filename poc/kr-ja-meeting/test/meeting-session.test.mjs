import assert from "node:assert/strict";
import test from "node:test";

import { MeetingSession } from "../src/meeting-session.mjs";

test("dynamic roster keeps microphone and speech as separate state", () => {
  const session = new MeetingSession();
  session.join({ id: "ja-1", name: "Yuki", language: "ja" });

  session.setMicrophone("ja-1", true);
  assert.deepEqual(session.snapshot().participants[0], {
    id: "ja-1",
    name: "Yuki",
    language: "ja",
    microphone: "unmuted",
    speech: "silent",
    utteranceId: null,
    audio: { original: false, translation: false, trackId: null, mode: "silent" },
  });

  session.startSpeech("ja-1", "utterance-1");
  assert.equal(session.snapshot().participants[0].speech, "speaking");
  session.endSpeech("ja-1");
  assert.equal(session.snapshot().participants[0].microphone, "unmuted");
  assert.equal(session.snapshot().participants[0].speech, "silent");
});

test("join and leave change the roster without a four-person constraint", () => {
  const session = new MeetingSession();
  session.join({ id: "ja-1", name: "Yuki", language: "ja" });
  session.join({ id: "ko-1", name: "민준", language: "ko" });
  assert.deepEqual(session.participants.map(({ id }) => id), ["ja-1", "ko-1"]);

  session.leave("ja-1");
  assert.deepEqual(session.participants.map(({ id }) => id), ["ko-1"]);
});

test("one automatic speaker still produces the existing listener audio plan", () => {
  const session = new MeetingSession([
    { id: "ja-1", name: "Yuki", language: "ja" },
    { id: "ko-1", name: "민준", language: "ko" },
    { id: "ja-2", name: "Sora", language: "ja" },
  ]);
  session.setMicrophone("ja-1", true);
  session.startSpeech("ja-1", "utterance-1");

  assert.deepEqual(session.audioPlanFor("ko-1"), {
    original: false,
    translation: true,
    trackId: "translation:ko",
    mode: "translated",
  });
  assert.deepEqual(session.audioPlanFor("ja-2"), {
    original: true,
    translation: false,
    trackId: "original:ja-1",
    mode: "same-language-original",
  });
});

test("mic off ends speech but does not remove the participant", () => {
  const session = new MeetingSession([{ id: "ja-1", name: "Yuki", language: "ja" }]);
  session.setMicrophone("ja-1", true);
  session.startSpeech("ja-1", "utterance-1");

  session.setMicrophone("ja-1", false);

  assert.equal(session.activeSpeakerId, null);
  assert.equal(session.participants[0].microphone, "muted");
  assert.equal(session.participants[0].speech, "silent");
});
