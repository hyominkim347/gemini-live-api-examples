import assert from "node:assert/strict";
import test from "node:test";

import { BrowserAudioPlayout } from "../public/browser-audio-playout.mjs";

function fixture({ play, attachError } = {}) {
  const children = [];
  const container = {
    append(element) {
      if (!children.includes(element)) children.push(element);
    },
  };
  const makeTrack = (trackId) => {
    const element = {
      dataset: {},
      volume: 1,
      play,
      remove() {
        const index = children.indexOf(this);
        if (index >= 0) children.splice(index, 1);
      },
    };
    return {
      kind: "audio",
      attach() {
        if (attachError) throw attachError;
        return element;
      },
      detach() { return [element]; },
      trackId,
      element,
    };
  };
  return { children, container, makeTrack };
}

test("two planned tracks attach as independent audio elements with independent gains", () => {
  const { children, container, makeTrack } = fixture();
  const playout = new BrowserAudioPlayout(container);
  const original = makeTrack("original:ja-1");
  const translation = makeTrack("translation:ko");

  playout.setPlan({
    mode: "translation-focused",
    tracks: [
      { trackId: original.trackId, gain: 0.2 },
      { trackId: translation.trackId, gain: 1 },
    ],
  });
  playout.attach(original, { trackName: original.trackId });
  playout.attach(translation, { trackName: translation.trackId });

  assert.deepEqual(children, [original.element, translation.element]);
  assert.ok(original.element.volume > 0);
  assert.ok(original.element.volume < translation.element.volume);
  assert.equal(original.element.dataset.trackId, "original:ja-1");
  assert.equal(translation.element.dataset.trackId, "translation:ko");
});

test("removing one track from the plan preserves the other audio element", () => {
  const { children, container, makeTrack } = fixture();
  const playout = new BrowserAudioPlayout(container);
  const original = makeTrack("original:ja-1");
  const translation = makeTrack("translation:ko");
  playout.setPlan({ tracks: [
    { trackId: original.trackId, gain: 0.2 },
    { trackId: translation.trackId, gain: 1 },
  ] });
  playout.attach(original, { trackName: original.trackId });
  playout.attach(translation, { trackName: translation.trackId });

  playout.setPlan({ tracks: [{ trackId: original.trackId, gain: 1 }] });

  assert.deepEqual(children, [original.element]);
  assert.equal(original.element.volume, 1);
});

test("a changed gain plan emits one application event and repeated polling does not duplicate it", () => {
  const { container } = fixture();
  const events = [];
  const playout = new BrowserAudioPlayout(container, {
    onPlanApplied(event) { events.push(event); },
  });
  const plan = {
    mode: "translation-only",
    tracks: [
      { trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 },
    ],
  };

  playout.setPlan(plan);
  playout.setPlan(plan);

  assert.deepEqual(events, [{
    type: "listening-plan-applied",
    mode: "translation-only",
    tracks: [
      { trackId: "translation:ko", kind: "translation", role: "foreground", gain: 1 },
    ],
  }]);
});

test("a listening plan event hook cannot interrupt audio plan application", () => {
  const { container, makeTrack } = fixture();
  const playout = new BrowserAudioPlayout(container, {
    onPlanApplied() { throw new Error("event sink unavailable"); },
  });
  const translation = makeTrack("translation:ko");

  assert.doesNotThrow(() => playout.setPlan({
    mode: "translation-only",
    tracks: [{ trackId: translation.trackId, gain: 1 }],
  }));
  assert.equal(playout.attach(translation, { trackName: translation.trackId }), true);
  assert.equal(translation.element.volume, 1);
});

test("track attachment and detachment expose a browser playout lifecycle hook", async () => {
  const { container, makeTrack } = fixture({ play: async () => {} });
  const events = [];
  const playout = new BrowserAudioPlayout(container, {
    onPlayoutEvent(event) { events.push(event); },
  });
  const translation = makeTrack("translation:ko");
  playout.setPlan({
    mode: "translation-only",
    tracks: [{ trackId: translation.trackId, gain: 1 }],
  });

  playout.attach(translation, { trackName: translation.trackId });
  await new Promise((resolve) => setImmediate(resolve));
  playout.detach(translation);

  assert.deepEqual(events, [
    {
      type: "playout-attached",
      trackId: "translation:ko",
      listeningMode: "translation-only",
      gain: 1,
      result: "attached",
    },
    {
      type: "playout-started",
      trackId: "translation:ko",
      listeningMode: "translation-only",
      gain: 1,
      result: "started",
    },
    {
      type: "playout-completed",
      trackId: "translation:ko",
      listeningMode: "translation-only",
      gain: 1,
      result: "detached",
    },
  ]);
});

test("browser play rejection reports a privacy-safe playout failure instead of a start", async () => {
  const { container, makeTrack } = fixture({
    play: async () => { throw new Error("private device details"); },
  });
  const events = [];
  const playout = new BrowserAudioPlayout(container, {
    onPlayoutEvent(event) { events.push(event); },
  });
  const translation = makeTrack("translation:ko");
  playout.setPlan({
    mode: "translation-only",
    tracks: [{ trackId: translation.trackId, gain: 1 }],
  });

  playout.attach(translation, { trackName: translation.trackId });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    {
      type: "playout-attached",
      trackId: "translation:ko",
      listeningMode: "translation-only",
      gain: 1,
      result: "attached",
    },
    {
      type: "playout-aborted",
      trackId: "translation:ko",
      listeningMode: "translation-only",
      gain: 1,
      result: "failed",
      errorCode: "browser-play-failed",
    },
  ]);
  assert.equal(JSON.stringify(events).includes("private device details"), false);
});

test("synchronous browser attachment and play failures are reported without error details", async () => {
  for (const [failure, fixtureOptions, errorCode, expectedTypes] of [
    ["attach", { attachError: new Error("private attach details") }, "browser-attach-failed", ["playout-aborted"]],
    ["play", { play() { throw new Error("private play details"); } }, "browser-play-failed", ["playout-attached", "playout-aborted"]],
  ]) {
    const { container, makeTrack } = fixture(fixtureOptions);
    const events = [];
    const playout = new BrowserAudioPlayout(container, {
      onPlayoutEvent(event) { events.push(event); },
    });
    const translation = makeTrack("translation:ko");
    playout.setPlan({
      mode: "translation-only",
      tracks: [{ trackId: translation.trackId, gain: 1 }],
    });

    assert.equal(playout.attach(translation, { trackName: translation.trackId }), failure !== "attach");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events.map(({ type }) => type), expectedTypes);
    assert.equal(events.at(-1).errorCode, errorCode);
    assert.equal(JSON.stringify(events).includes("private"), false);
  }
});
