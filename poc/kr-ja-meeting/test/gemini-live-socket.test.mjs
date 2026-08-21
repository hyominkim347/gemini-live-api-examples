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

  emit(event, data) {
    this.handlers.get(event)?.(data);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
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
