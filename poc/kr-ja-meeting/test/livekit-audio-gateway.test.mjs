import assert from "node:assert/strict";
import test from "node:test";

import { dispose } from "@livekit/rtc-node";

import { LiveKitAudioGateway } from "../src/livekit-audio-gateway.mjs";
import { sineFrame } from "../src/playout-continuity.mjs";

test("translation sink exposes queue state and explicit playout lifecycle", async () => {
  const published = [];
  const gateway = new LiveKitAudioGateway({
    localParticipant: {
      async publishTrack(track, options) {
        published.push({ track, options });
      },
    },
  });

  try {
    const sink = await gateway.translationSink("ja");

    assert.equal(typeof sink.queuedDurationMs, "function");
    assert.equal(typeof sink.waitForPlayout, "function");
    assert.equal(typeof sink.clearQueue, "function");
    assert.equal(sink.queuedDurationMs(), 0);

    const capture = await sink.capture(sineFrame());
    assert.equal(capture.queuedBeforeMs, 0);
    assert.ok(capture.queuedAfterMs > 0);
    assert.ok(capture.captureWaitMs >= 0);

    await sink.waitForPlayout();
    assert.equal(sink.queuedDurationMs(), 0);
    sink.clearQueue();
    assert.equal(published.length, 1);
  } finally {
    await gateway.close();
    dispose();
  }
});
