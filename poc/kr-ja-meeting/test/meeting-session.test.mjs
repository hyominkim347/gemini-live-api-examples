import assert from "node:assert/strict";
import test from "node:test";

import { MeetingSession } from "../src/meeting-session.mjs";

const PARTICIPANTS = [
  { id: "ko-1", name: "한국 1", language: "ko" },
  { id: "ko-2", name: "한국 2", language: "ko" },
  { id: "ja-1", name: "日本 1", language: "ja" },
  { id: "ja-2", name: "日本 2", language: "ja" },
];

test("foreign listeners hear translation only and return from original at a phrase boundary", () => {
  const session = new MeetingSession(PARTICIPANTS);

  session.startSpeaking("ja-1");
  assert.deepEqual(session.audioPlanFor("ko-1"), {
    original: false,
    translation: true,
    trackId: "translation:ko",
    mode: "translated",
  });

  session.holdOriginal("ko-1");
  assert.deepEqual(session.audioPlanFor("ko-1"), {
    original: true,
    translation: false,
    trackId: "original:ja-1",
    mode: "original",
  });

  session.releaseOriginal("ko-1");
  assert.equal(session.audioPlanFor("ko-1").mode, "original-until-boundary");

  session.phraseBoundary();
  assert.deepEqual(session.audioPlanFor("ko-1"), {
    original: false,
    translation: true,
    trackId: "translation:ko",
    mode: "translated",
  });
});

test("the session admits the fixed four-person cohort and rejects overlapping speakers", () => {
  const session = new MeetingSession(PARTICIPANTS);

  assert.equal(session.participants.length, 4);
  session.startSpeaking("ko-2");
  assert.throws(
    () => session.startSpeaking("ja-2"),
    /ko-2 is already speaking/,
  );

  assert.deepEqual(session.audioPlanFor("ja-2"), {
    original: false,
    translation: true,
    trackId: "translation:ja",
    mode: "translated",
  });
  assert.deepEqual(session.audioPlanFor("ko-1"), {
    original: true,
    translation: false,
    trackId: "original:ko-2",
    mode: "same-language-original",
  });
});

test("starting the active speaker again is idempotent and preserves listener mode", () => {
  const session = new MeetingSession(PARTICIPANTS);
  session.startSpeaking("ja-1");
  session.holdOriginal("ko-1");

  session.startSpeaking("ja-1");

  assert.equal(session.audioPlanFor("ko-1").mode, "original");
});
