import assert from "node:assert/strict";
import test from "node:test";

import { LiveTranslationBridge } from "../src/live-translation-bridge.mjs";

test("active original track flows through Gemini into the opposite-language track", async () => {
  const calls = [];
  let originalFrame;
  let geminiOptions;
  const gateway = {
    async translationSink(targetLanguage) {
      calls.push(`sink:${targetLanguage}`);
      return {
        async capture(buffer) { calls.push(`translated:${buffer.toString("hex")}`); },
      };
    },
    async subscribeOriginal(trackName, onFrame) {
      calls.push(`subscribe:${trackName}`);
      originalFrame = onFrame;
      return { async close() { calls.push("unsubscribe"); } };
    },
  };
  const gemini = {
    connect() { calls.push("connect"); geminiOptions.onSetupComplete(); },
    sendActivityStart() { calls.push("activity-start"); return true; },
    sendActivityEnd() { calls.push("activity-end"); return true; },
    sendPcm16(buffer, sampleRate) { calls.push(`pcm:${sampleRate}:${buffer.toString("hex")}`); return true; },
    close() { calls.push("gemini-close"); },
  };
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: gateway,
    geminiFactory(options) {
      geminiOptions = options;
      assert.equal(options.targetLanguage, "ko");
      return gemini;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await originalFrame(Buffer.from([1, 2]), 16_000);
  await geminiOptions.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
  const boundary = bridge.phraseBoundary();
  await originalFrame(Buffer.from([9, 9]), 16_000);
  await boundary;
  await geminiOptions.onTranslatedAudio(Buffer.from([5, 6]).toString("base64"));
  const stop = bridge.stop();
  await stop;

  assert.deepEqual(calls, [
    "sink:ko",
    "connect",
    "activity-start",
    "subscribe:original:ja-1",
    "pcm:16000:0102",
    "translated:0304",
    "activity-end",
    "activity-start",
    "translated:0506",
    "activity-end",
    "unsubscribe",
    "gemini-close",
  ]);
});

test("a second speaker cannot overlap the active translation bridge", async () => {
  let geminiOptions;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { geminiOptions.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await assert.rejects(
    bridge.start({ id: "ko-1", language: "ko" }),
    /translation bridge is already active/,
  );
  await geminiOptions.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("a second start is rejected while Gemini setup is still pending", async () => {
  const setupCallbacks = [];
  const clients = [];
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      setupCallbacks.push(options.onSetupComplete);
      const client = {
        options,
        connect() {},
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() {},
      };
      clients.push(client);
      return client;
    },
  });

  const firstStart = bridge.start({ id: "ja-1", language: "ja" });
  const secondStart = bridge.start({ id: "ko-1", language: "ko" });
  await Promise.resolve();
  for (const completeSetup of setupCallbacks) completeSetup();
  await assert.rejects(
    secondStart,
    /translation bridge is already active/,
  );
  await firstStart;
  await clients[0].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("Gemini is closed when setup fails", async () => {
  let failSetup;
  let closed = false;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      failSetup = options.onError;
      return {
        connect() { failSetup(new Error("setup failed")); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { closed = true; },
      };
    },
  });

  await assert.rejects(bridge.start({ id: "ja-1", language: "ja" }), /setup failed/);
  assert.equal(closed, true);
});

test("stop closes Gemini and permits restart even when subscription cleanup fails", async () => {
  const clients = [];
  let subscriptionCount = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        subscriptionCount += 1;
        return {
          async close() {
            if (subscriptionCount === 1) throw new Error("unsubscribe failed");
          },
        };
      },
    },
    geminiFactory(options) {
      const client = {
        closed: false,
        options,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
  });

  await bridge.start({ id: "ja-1", language: "ja" });
  await clients[0].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const failedStop = bridge.stop();
  await assert.rejects(failedStop, /unsubscribe failed/);
  assert.equal(clients[0].closed, true);

  await bridge.start({ id: "ko-1", language: "ko" });
  await clients[1].options.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  const successfulStop = bridge.stop();
  await successfulStop;
});

test("a phrase boundary drains translated audio when Live Translate omits completion events", async () => {
  const calls = [];
  let geminiOptions;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    drainQuietMilliseconds: 5,
    audioGateway: {
      async translationSink() {
        return { async capture() { calls.push("capture"); } };
      },
      async subscribeOriginal() { return { async close() {} }; },
    },
    geminiFactory(options) {
      geminiOptions = options;
      return {
        connect() { options.onSetupComplete(); },
        sendActivityStart() { calls.push("activity-start"); return true; },
        sendActivityEnd() { calls.push("activity-end"); return true; },
        sendPcm16() { return true; },
        close() {},
      };
    },
  });

  await bridge.start({ id: "ko-1", language: "ko" });
  const boundary = bridge.phraseBoundary();
  await delayForTest(1);
  await geminiOptions.onTranslatedAudio(Buffer.from([0, 0]).toString("base64"));
  await geminiOptions.onTranslatedAudio(Buffer.from([1, 2]).toString("base64"));
  await boundary;
  assert.deepEqual(calls, [
    "activity-start",
    "activity-end",
    "capture",
    "capture",
    "activity-start",
  ]);

  await geminiOptions.onTranslatedAudio(Buffer.from([3, 4]).toString("base64"));
  const stop = bridge.stop();
  await stop;
});

test("a missing first translation aborts instead of reporting a successful boundary", async () => {
  const clients = [];
  let closes = 0;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    drainQuietMilliseconds: 1,
    firstAudioTimeoutMilliseconds: 5,
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        return { async close() { closes += 1; } };
      },
    },
    geminiFactory(options) {
      const client = {
        closed: false,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
  });

  await bridge.start({ id: "ko-1", language: "ko" });
  await assert.rejects(
    bridge.phraseBoundary(),
    /no audible translation before the drain timeout/,
  );
  assert.equal(clients[0].closed, true);
  assert.equal(closes, 1);

  await bridge.start({ id: "ja-1", language: "ja" });
  await bridge.abort();
  assert.equal(clients[1].closed, true);
  assert.equal(closes, 2);
});

test("abort waits for an in-progress start and prevents an orphan bridge", async () => {
  const subscriptionEntered = deferredForBridgeTest();
  const subscription = deferredForBridgeTest();
  let client;
  const bridge = new LiveTranslationBridge({
    meetingId: "browser-poc",
    audioGateway: {
      async translationSink() { return { async capture() {} }; },
      async subscribeOriginal() {
        subscriptionEntered.resolve();
        return subscription.promise;
      },
    },
    geminiFactory(options) {
      client = {
        closed: false,
        connect() { options.onSetupComplete(); },
        sendActivityStart() { return true; },
        sendActivityEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      return client;
    },
  });

  const start = bridge.start({ id: "ko-1", language: "ko" });
  await subscriptionEntered.promise;
  const abort = bridge.abort();
  subscription.resolve({ async close() {} });
  await abort;
  await assert.rejects(start, /start was aborted/);
  assert.equal(client.closed, true);
});

function delayForTest(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferredForBridgeTest() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
