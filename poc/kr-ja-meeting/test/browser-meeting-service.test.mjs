import assert from "node:assert/strict";
import test from "node:test";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";

const participants = [
  { id: "ko-1", name: "민준", language: "ko" },
  { id: "ko-2", name: "서연", language: "ko" },
  { id: "ja-1", name: "Yuki", language: "ja" },
  { id: "ja-2", name: "Sora", language: "ja" },
];

test("fixed roster receives scoped join credentials", async () => {
  const issued = [];
  const service = new BrowserMeetingService({
    participants,
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async (participant) => {
      issued.push(participant.id);
      return `token:${participant.id}`;
    },
    translationBridge: { start: async () => {}, stop: async () => {}, phraseBoundary: async () => {} },
  });

  assert.deepEqual(await service.join("ko-1"), {
    livekitUrl: "ws://127.0.0.1:7880",
    roomName: "browser-poc",
    token: "token:ko-1",
    participant: participants[0],
  });
  assert.deepEqual(issued, ["ko-1"]);
  await assert.rejects(service.join("someone-else"), /unknown participant/);
});

test("shared actions expose exactly one planned listener track", async () => {
  const bridgeEvents = [];
  const service = new BrowserMeetingService({
    participants,
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async () => "token",
    translationBridge: {
      async start(participant) { bridgeEvents.push(`start:${participant.id}`); },
      async stop() { bridgeEvents.push("stop"); },
      async phraseBoundary() { bridgeEvents.push("boundary"); },
    },
  });

  let state = await service.action("ja-1", "start-speaking");
  assert.equal(state.activeSpeakerId, "ja-1");
  assert.equal(state.participants.find(({ id }) => id === "ko-1").audio.trackId, "translation:ko");
  assert.equal(state.participants.find(({ id }) => id === "ja-2").audio.trackId, "original:ja-1");

  state = await service.action("ko-1", "hold-original");
  assert.equal(state.participants.find(({ id }) => id === "ko-1").audio.trackId, "original:ja-1");
  state = await service.action("ko-1", "release-original");
  assert.equal(state.participants.find(({ id }) => id === "ko-1").audio.mode, "original-until-boundary");
  state = await service.action("ja-1", "phrase-boundary");
  assert.equal(state.participants.find(({ id }) => id === "ko-1").audio.trackId, "translation:ko");
  state = await service.action("ja-1", "stop-speaking");
  assert.equal(state.activeSpeakerId, null);
  assert.deepEqual(bridgeEvents, ["start:ja-1", "boundary", "stop"]);

  await assert.rejects(service.action("ko-1", "invented-action"), /unsupported meeting action/);
});

test("only the active speaker can end or segment the active translation", async () => {
  const bridgeEvents = [];
  const service = new BrowserMeetingService({
    participants,
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async () => "token",
    translationBridge: {
      async start(participant) { bridgeEvents.push(`start:${participant.id}`); },
      async stop() { bridgeEvents.push("stop"); },
      async phraseBoundary() { bridgeEvents.push("boundary"); },
    },
  });

  await service.action("ja-1", "start-speaking");
  await assert.rejects(
    service.action("ko-1", "stop-speaking"),
    /ko-1 is not the active speaker/,
  );
  await assert.rejects(
    service.action("ko-1", "phrase-boundary"),
    /ko-1 is not the active speaker/,
  );
  assert.equal(service.snapshot().activeSpeakerId, "ja-1");
  assert.deepEqual(bridgeEvents, ["start:ja-1"]);
});

test("concurrent starts from the same speaker create one bridge", async () => {
  const started = deferredForTest();
  let bridgeStarts = 0;
  const service = new BrowserMeetingService({
    participants,
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async () => "token",
    translationBridge: {
      async start() { bridgeStarts += 1; await started.promise; },
      async stop() {},
      async phraseBoundary() {},
    },
  });

  const first = service.action("ja-1", "start-speaking");
  const second = service.action("ja-1", "start-speaking");
  const stop = service.action("ja-1", "stop-speaking");
  started.resolve();
  assert.equal((await first).activeSpeakerId, "ja-1");
  assert.equal((await second).activeSpeakerId, "ja-1");
  assert.equal((await stop).activeSpeakerId, null);
  assert.equal(bridgeStarts, 1);
  assert.equal(service.snapshot().activeSpeakerId, null);
});

test("bridge failures cannot leave the meeting session active", async () => {
  let stopFails = true;
  const service = new BrowserMeetingService({
    participants,
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    tokenIssuer: async () => "token",
    translationBridge: {
      async start() {},
      async stop() {
        if (stopFails) throw new Error("cleanup failed");
      },
      async phraseBoundary() { throw new Error("boundary failed"); },
    },
  });

  await service.action("ja-1", "start-speaking");
  await assert.rejects(service.action("ja-1", "stop-speaking"), /cleanup failed/);
  assert.equal(service.snapshot().activeSpeakerId, null);

  stopFails = false;
  await service.action("ja-1", "start-speaking");
  await assert.rejects(service.action("ja-1", "phrase-boundary"), /boundary failed/);
  assert.equal(service.snapshot().activeSpeakerId, null);
});

function deferredForTest() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
