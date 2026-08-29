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
    listeningMode: "translation-focused",
    audio: { mode: "silent", tracks: [] },
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

test("one automatic speaker produces relation-based listener audio plans", () => {
  const session = new MeetingSession([
    { id: "ja-1", name: "Yuki", language: "ja" },
    { id: "ko-1", name: "민준", language: "ko" },
    { id: "ja-2", name: "Sora", language: "ja" },
  ]);
  session.setMicrophone("ja-1", true);
  session.startSpeech("ja-1", "utterance-1");

  const foreignPlan = session.audioPlanFor("ko-1");
  assert.equal(foreignPlan.mode, "translation-focused");
  assert.deepEqual(foreignPlan.tracks.map(({ trackId, kind, role }) => ({ trackId, kind, role })), [
    { trackId: "original:ja-1", kind: "original", role: "background" },
    { trackId: "translation:ko", kind: "translation", role: "foreground" },
  ]);
  assert.ok(foreignPlan.tracks[0].gain > 0);
  assert.ok(foreignPlan.tracks[0].gain < foreignPlan.tracks[1].gain);
  assert.deepEqual(session.audioPlanFor("ja-2"), {
    mode: "same-language-original",
    tracks: [
      {
        trackId: "original:ja-1",
        kind: "original",
        role: "foreground",
        gain: 1,
      },
    ],
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

test("each listener keeps an independent persistent listening mode", () => {
  const session = new MeetingSession([
    { id: "ja-speaker", name: "Yuki", language: "ja" },
    { id: "ko-one", name: "민준", language: "ko" },
    { id: "ko-two", name: "서연", language: "ko" },
  ]);
  session.setMicrophone("ja-speaker", true);
  session.startSpeech("ja-speaker", "utterance-1");

  session.setListeningMode("ko-one", "translation-only");

  assert.equal(session.audioPlanFor("ko-one").mode, "translation-only");
  assert.deepEqual(session.audioPlanFor("ko-one").tracks, [
    { trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 },
  ]);
  assert.equal(session.audioPlanFor("ko-two").mode, "translation-focused");
  assert.equal(session.snapshot().participants.find(({ id }) => id === "ko-one").listeningMode, "translation-only");
  assert.equal(session.snapshot().participants.find(({ id }) => id === "ko-two").listeningMode, "translation-focused");
});

test("original-check restores the listener's previous mode at its automatic utterance boundary", () => {
  const session = new MeetingSession([
    { id: "ja-speaker", name: "Yuki", language: "ja" },
    { id: "ko-listener", name: "민준", language: "ko" },
  ]);
  session.setMicrophone("ja-speaker", true);
  session.startSpeech("ja-speaker", "utterance-1");
  session.setListeningMode("ko-listener", "translation-only");

  session.setListeningMode("ko-listener", "original-check");
  assert.deepEqual(session.audioPlanFor("ko-listener"), {
    mode: "original-check",
    tracks: [
      { trackId: "original:ja-speaker", kind: "original", role: "foreground", gain: 1 },
    ],
  });

  session.endSpeech("ja-speaker");
  assert.equal(session.snapshot().participants.find(({ id }) => id === "ko-listener").listeningMode, "translation-only");

  session.startSpeech("ja-speaker", "utterance-2");
  assert.equal(session.audioPlanFor("ko-listener").mode, "translation-only");
});
