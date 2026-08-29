import assert from "node:assert/strict";
import test from "node:test";

import { BrowserMeetingService } from "../src/browser-meeting-service.mjs";
import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { MemoryResumptionHandleStore } from "../src/gemini-session.mjs";
import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

class FakeSocket {
  static OPEN = 1;
  handlers = new Map();
  readyState = FakeSocket.OPEN;
  sent = [];

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, ...args) { this.handlers.get(event)?.(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function createService(overrides = {}) {
  const bridgeEvents = [];
  const service = new BrowserMeetingService({
    roomName: "browser-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    participantIdFactory: () => "participant-1",
    utteranceIdFactory: () => "utterance-1",
    tokenIssuer: async (participant) => `token:${participant.id}`,
    translationBridge: {
      async start(participant, utterance) {
        bridgeEvents.push({ type: "start", participantId: participant.id, ...utterance });
      },
      async stop(utterance) {
        bridgeEvents.push({ type: "stop", ...utterance });
      },
    },
    ...overrides,
  });
  return { service, bridgeEvents };
}

test("dynamic participant joins with a generated id and can leave", async () => {
  const { service } = createService();

  assert.deepEqual(await service.join({ name: "  Yuki  ", language: "ja" }), {
    livekitUrl: "ws://127.0.0.1:7880",
    roomName: "browser-poc",
    token: "token:participant-1",
    participant: { id: "participant-1", name: "Yuki", language: "ja" },
  });
  assert.deepEqual(service.snapshot().participants.map(({ id }) => id), ["participant-1"]);

  await service.leave("participant-1");
  assert.deepEqual(service.snapshot().participants, []);
  await assert.rejects(service.mic("participant-1", true), /unknown participant/);
});

test("microphone on remains unmuted and silent until speech activity starts", async () => {
  const { service, bridgeEvents } = createService();
  const { participant } = await service.join({ name: "Yuki", language: "ja" });

  const state = await service.mic(participant.id, true);

  assert.deepEqual(state.participants.find(({ id }) => id === participant.id), {
    ...participant,
    microphone: "unmuted",
    speech: "silent",
    utteranceId: null,
    audio: { original: false, translation: false, trackId: null, mode: "silent" },
  });
  assert.equal(state.activeSpeakerId, null);
  assert.equal(state.activeUtteranceId, null);
  assert.deepEqual(bridgeEvents, []);
});

test("speech start and end drive one translation lifecycle with one utterance id", async () => {
  const { service, bridgeEvents } = createService();
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speaking = await service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  assert.equal(speaking.activeSpeakerId, participant.id);
  assert.equal(speaking.activeUtteranceId, "utterance-1");
  assert.equal(speaking.participants[0].speech, "speaking");

  const silent = await service.speechActivity({
    participantId: participant.id,
    type: "speech-end",
    observedAt: 350,
  });
  assert.equal(silent.activeSpeakerId, null);
  assert.equal(silent.activeUtteranceId, null);
  assert.equal(silent.participants[0].speech, "silent");
  assert.deepEqual(bridgeEvents, [
    { type: "start", participantId: participant.id, utteranceId: "utterance-1", observedAt: 100 },
    { type: "stop", utteranceId: "utterance-1", observedAt: 350 },
  ]);
});

test("mic off and leave close an active automatic utterance", async () => {
  let nextParticipant = 0;
  let nextUtterance = 0;
  const { service, bridgeEvents } = createService({
    participantIdFactory: () => `participant-${++nextParticipant}`,
    utteranceIdFactory: () => `utterance-${++nextUtterance}`,
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  const second = (await service.join({ name: "민준", language: "ko" })).participant;

  await service.mic(first.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });
  let state = await service.mic(first.id, false);
  assert.equal(state.participants.find(({ id }) => id === first.id).microphone, "muted");
  assert.equal(state.activeSpeakerId, null);

  await service.mic(second.id, true);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });
  state = await service.leave(second.id);
  assert.equal(state.participants.some(({ id }) => id === second.id), false);
  assert.equal(state.activeSpeakerId, null);
  assert.deepEqual(bridgeEvents.map(({ type, utteranceId }) => ({ type, utteranceId })), [
    { type: "start", utteranceId: "utterance-1" },
    { type: "stop", utteranceId: "utterance-1" },
    { type: "start", utteranceId: "utterance-2" },
    { type: "stop", utteranceId: "utterance-2" },
  ]);
});

test("bridge cleanup failures cannot leave a ghost participant or open microphone", async () => {
  let nextParticipant = 0;
  const { service } = createService({
    participantIdFactory: () => `participant-${++nextParticipant}`,
    translationBridge: {
      async start() {},
      async stop() { throw new Error("bridge cleanup failed"); },
    },
  });
  const first = (await service.join({ name: "Yuki", language: "ja" })).participant;
  await service.mic(first.id, true);
  await service.speechActivity({ participantId: first.id, type: "speech-start", observedAt: 10 });

  await assert.rejects(service.mic(first.id, false), /bridge cleanup failed/);
  assert.equal(service.snapshot().participants[0].microphone, "muted");
  assert.equal(service.snapshot().activeSpeakerId, null);

  const second = (await service.join({ name: "민준", language: "ko" })).participant;
  await service.mic(second.id, true);
  await service.speechActivity({ participantId: second.id, type: "speech-start", observedAt: 20 });
  await assert.rejects(service.leave(second.id), /bridge cleanup failed/);
  assert.equal(service.snapshot().participants.some(({ id }) => id === second.id), false);
});

test("manual speech actions are not part of the service contract", async () => {
  const { service } = createService();
  const { participant } = await service.join({ name: "Yuki", language: "ja" });

  for (const action of ["start-speaking", "stop-speaking", "phrase-boundary"]) {
    await assert.rejects(service.action(participant.id, action), /unsupported meeting action/);
  }
});

test("invalid join and speech activity fail closed", async () => {
  const { service } = createService();
  await assert.rejects(service.join({ name: "", language: "ja" }), /display name/);
  await assert.rejects(service.join({ name: "Yuki", language: "en" }), /unsupported language/);

  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await assert.rejects(
    service.speechActivity({ participantId: participant.id, type: "speech-start", observedAt: 1 }),
    /microphone is muted/,
  );
  await assert.rejects(
    service.speechActivity({ participantId: participant.id, type: "invented", observedAt: 1 }),
    /unsupported speech activity/,
  );
});

test("automatic speech keeps its utterance id while an expired Gemini session retries", async () => {
  const sockets = [];
  const retryEvents = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("browser-poc", "ko", "expired-handle");
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(callbacks) {
      return new GeminiLiveTranslateSocket({
        ...callbacks,
        apiKey: "test-only-key",
        handleStore: handles,
        socketFactory(url) {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        openState: FakeSocket.OPEN,
        automaticActivityDetection: false,
        onServerEvent(event) { retryEvents.push(event); },
      });
    },
  });
  const { service } = createService({ translationBridge: bridge });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speechStart = service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close", 1008, "BidiGenerateContent session not found");

  assert.equal(sockets.length, 2);
  assert.equal(service.snapshot().activeUtteranceId, "utterance-1");
  sockets[1].emit("open");
  sockets[1].emit("message", JSON.stringify({ setupComplete: {} }));
  const state = await speechStart;

  assert.equal(state.activeUtteranceId, "utterance-1");
  assert.deepEqual(retryEvents.filter(({ type }) => type === "resumption-retry").map(({ outcome }) => outcome), [
    "started",
    "succeeded",
  ]);
  await service.speechActivity({
    participantId: participant.id,
    type: "speech-end",
    observedAt: 200,
  });
});

test("a second setup failure stops retrying and cleans the automatic speech state", async () => {
  const sockets = [];
  const retryEvents = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("browser-poc", "ko", "expired-handle");
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { throw new Error("must not subscribe before setup"); },
    },
    geminiFactory(callbacks) {
      return new GeminiLiveTranslateSocket({
        ...callbacks,
        apiKey: "test-only-key",
        handleStore: handles,
        socketFactory(url) {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        openState: FakeSocket.OPEN,
        automaticActivityDetection: false,
        onServerEvent(event) { retryEvents.push(event); },
      });
    },
  });
  const { service } = createService({ translationBridge: bridge });
  const { participant } = await service.join({ name: "Yuki", language: "ja" });
  await service.mic(participant.id, true);

  const speechStart = service.speechActivity({
    participantId: participant.id,
    type: "speech-start",
    observedAt: 100,
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close", 1008, "BidiGenerateContent session not found");
  sockets[1].emit("open");
  sockets[1].emit("close", 1008, "BidiGenerateContent session not found");

  await assert.rejects(speechStart, /Gemini closed during setup/);
  assert.equal(sockets.length, 2);
  assert.equal(service.snapshot().activeSpeakerId, null);
  assert.equal(service.snapshot().activeUtteranceId, null);
  assert.equal(service.snapshot().participants[0].speech, "silent");
  assert.deepEqual(retryEvents.filter(({ type }) => type === "resumption-retry").map(({ outcome }) => outcome), [
    "started",
    "failed",
  ]);
});
