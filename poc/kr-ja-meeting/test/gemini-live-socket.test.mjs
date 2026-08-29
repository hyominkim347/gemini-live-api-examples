import assert from "node:assert/strict";
import test from "node:test";

import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { MemoryResumptionHandleStore } from "../src/gemini-session.mjs";

class FakeSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, ...data) {
    this.handlers.get(event)?.(...data);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }
}

class FakeEventTargetSocket extends FakeSocket {
  constructor(url) {
    super(url);
    this.on = undefined;
  }

  addEventListener(event, handler) {
    this.handlers.set(event, handler);
  }
}

test("Gemini socket traces setup, PCM audio, translated output, and resumption", () => {
  const sockets = [];
  const audio = [];
  const lifecycle = [];
  const serverEvents = [];
  const handles = new MemoryResumptionHandleStore();
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onTranslatedAudio(base64Audio) {
      audio.push(base64Audio);
    },
    onSetupComplete() {
      lifecycle.push("setup");
    },
    onTurnComplete() {
      lifecycle.push("turn");
    },
    onGenerationComplete() {
      lifecycle.push("generation");
    },
    onResumptionHandle() {
      lifecycle.push("handle");
    },
    onServerEvent(event) {
      serverEvents.push(event);
    },
  });

  client.connect();
  const socket = sockets[0];
  assert.match(socket.url, /BidiGenerateContent\?key=test-only-key$/);

  socket.emit("open");
  assert.equal(socket.sent[0].setup.generationConfig.translationConfig.targetLanguageCode, "ko");
  socket.emit("message", JSON.stringify({ setupComplete: {} }));
  assert.deepEqual(lifecycle, ["setup"]);

  assert.equal(client.sendActivityStart(), true);
  assert.deepEqual(socket.sent[1], {
    realtimeInput: { activityStart: {} },
  });

  assert.equal(client.sendPcm16(Buffer.from([1, 2, 3, 4]), 48000), true);
  assert.deepEqual(socket.sent[2], {
    realtimeInput: {
      audio: {
        mimeType: "audio/pcm;rate=48000",
        data: "AQIDBA==",
      },
    },
  });
  assert.equal(client.sendActivityEnd(), true);
  assert.deepEqual(socket.sent[3], {
    realtimeInput: { activityEnd: {} },
  });
  assert.equal(client.sendAudioStreamEnd(), true);
  assert.deepEqual(socket.sent[4], {
    realtimeInput: { audioStreamEnd: true },
  });

  socket.emit(
    "message",
    JSON.stringify({
      sessionResumptionUpdate: { resumable: true, newHandle: "next-handle" },
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "translated-pcm" } }] },
        generationComplete: true,
        turnComplete: true,
      },
    }),
  );
  assert.equal(handles.get("meeting-1", "ko"), "next-handle");
  assert.deepEqual(audio, ["translated-pcm"]);
  assert.deepEqual(lifecycle, ["setup", "handle", "generation", "turn"]);
  assert.deepEqual(serverEvents, [
    { setupComplete: true },
    {
      resumptionUpdate: true,
      modelAudio: true,
      generationComplete: true,
      turnComplete: true,
    },
  ]);
});

test("Gemini socket rejects a second live connection", () => {
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ja",
    handleStore: new MemoryResumptionHandleStore(),
    socketFactory: (url) => new FakeSocket(url),
    openState: FakeSocket.OPEN,
  });

  client.connect();
  assert.throws(() => client.connect(), /already connected/);
});

test("setup uses the latest resumption handle available when the socket opens", () => {
  const sockets = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("meeting-1", "ko", "earlier-handle");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
  });

  client.connect();
  handles.set("meeting-1", "ko", "latest-handle");
  sockets[0].emit("open");

  assert.deepEqual(sockets[0].sent[0].setup.sessionResumption, {
    handle: "latest-handle",
  });
});

test("an expired resumption handle is cleared and retried exactly once", () => {
  const sockets = [];
  const closed = [];
  const serverEvents = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("meeting-1", "ko", "expired-handle");
  handles.set("meeting-1", "ja", "other-language-handle");
  handles.set("meeting-2", "ko", "other-meeting-handle");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onClose() {
      closed.push("closed");
    },
    onServerEvent(event) {
      serverEvents.push(event);
    },
  });

  client.connect();
  sockets[0].emit("open");
  assert.deepEqual(sockets[0].sent[0].setup.sessionResumption, {
    handle: "expired-handle",
  });

  sockets[0].emit(
    "close",
    1008,
    Buffer.from("BidiGenerateContent session not found"),
  );
  assert.equal(sockets.length, 2);
  assert.equal(handles.get("meeting-1", "ko"), null);
  assert.equal(handles.get("meeting-1", "ja"), "other-language-handle");
  assert.equal(handles.get("meeting-2", "ko"), "other-meeting-handle");
  assert.deepEqual(closed, []);
  assert.deepEqual(serverEvents, [{
    type: "resumption-retry",
    outcome: "started",
    meetingId: "meeting-1",
    targetLanguage: "ko",
  }]);

  sockets[1].emit("open");
  assert.deepEqual(sockets[1].sent[0].setup.sessionResumption, {});
  sockets[1].emit(
    "close",
    1008,
    Buffer.from("BidiGenerateContent session not found"),
  );
  assert.equal(sockets.length, 2);
  assert.deepEqual(closed, ["closed"]);
  assert.deepEqual(serverEvents.at(-1), {
    type: "resumption-retry",
    outcome: "failed",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    errorCode: "session-not-found",
  });
  assert.equal(JSON.stringify(serverEvents).includes("expired-handle"), false);
});

test("a successful retry records only privacy-safe lifecycle data", () => {
  const sockets = [];
  const serverEvents = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("meeting-1", "ko", "secret-expired-handle");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "secret-test-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onServerEvent(event) { serverEvents.push(event); },
  });

  client.connect();
  sockets[0].emit("open");
  sockets[0].emit("close", 1008, "BidiGenerateContent session not found");
  sockets[1].emit("open");
  sockets[1].emit("message", JSON.stringify({ setupComplete: {} }));

  assert.deepEqual(serverEvents.filter(({ type }) => type === "resumption-retry"), [
    {
      type: "resumption-retry",
      outcome: "started",
      meetingId: "meeting-1",
      targetLanguage: "ko",
    },
    {
      type: "resumption-retry",
      outcome: "succeeded",
      meetingId: "meeting-1",
      targetLanguage: "ko",
    },
  ]);
  const recorded = JSON.stringify(serverEvents);
  assert.equal(recorded.includes("secret-expired-handle"), false);
  assert.equal(recorded.includes("secret-test-key"), false);
});

test("retry telemetry failures do not prevent session recovery", () => {
  const sockets = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("meeting-1", "ko", "expired-handle");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onServerEvent(event) {
      if (event.type === "resumption-retry") throw new Error("telemetry unavailable");
    },
  });

  client.connect();
  sockets[0].emit("open");
  assert.doesNotThrow(() => {
    sockets[0].emit("close", 1008, "BidiGenerateContent session not found");
  });
  assert.equal(sockets.length, 2);
  sockets[1].emit("open");
  assert.doesNotThrow(() => {
    sockets[1].emit("message", JSON.stringify({ setupComplete: {} }));
  });
});

test("an expired handle also retries through a CloseEvent socket", () => {
  const sockets = [];
  const handles = new MemoryResumptionHandleStore();
  handles.set("meeting-1", "ko", "expired-handle");
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeEventTargetSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
  });

  client.connect();
  sockets[0].emit("open", {});
  sockets[0].emit("close", {
    code: 1008,
    reason: "BidiGenerateContent session not found",
  });

  assert.equal(sockets.length, 2);
  assert.equal(handles.get("meeting-1", "ko"), null);
});

test("events from a closed socket cannot contaminate an immediate reconnect", () => {
  const sockets = [];
  const audio = [];
  const closed = [];
  const handles = new MemoryResumptionHandleStore();
  const client = new GeminiLiveTranslateSocket({
    apiKey: "test-only-key",
    meetingId: "meeting-1",
    targetLanguage: "ko",
    handleStore: handles,
    socketFactory(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    openState: FakeSocket.OPEN,
    onTranslatedAudio(value) {
      audio.push(value);
    },
    onClose() {
      closed.push("closed");
    },
  });

  client.connect();
  const stale = sockets[0];
  client.close();
  client.connect();
  const current = sockets[1];

  stale.emit("open");
  stale.emit(
    "message",
    JSON.stringify({
      sessionResumptionUpdate: { resumable: true, newHandle: "stale-handle" },
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "stale-audio" } }] },
      },
    }),
  );
  stale.emit("close");

  assert.equal(stale.sent.length, 0);
  assert.equal(handles.get("meeting-1", "ko"), null);
  assert.deepEqual(audio, []);
  assert.deepEqual(closed, ["closed"]);

  current.emit("open");
  assert.equal(current.sent.length, 1);
});
