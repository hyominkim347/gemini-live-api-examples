import assert from "node:assert/strict";
import test from "node:test";

import { syncAudioSubscriptions } from "../src/livekit-subscriptions.mjs";

function publication(trackName, kind = "audio") {
  return {
    kind,
    trackName,
    subscribed: null,
    setSubscribed(value) {
      this.subscribed = value;
    },
  };
}

test("LiveKit subscribes to exactly the planned audio track", () => {
  const original = publication("original:ja-1");
  const koreanTranslation = publication("translation:ko");
  const japaneseTranslation = publication("translation:ja");
  const camera = publication("camera", "video");
  const room = {
    remoteParticipants: new Map([
      ["speaker", { trackPublications: new Map([["a", original]]) }],
      [
        "translators",
        {
          trackPublications: new Map([
            ["b", koreanTranslation],
            ["c", japaneseTranslation],
            ["d", camera],
          ]),
        },
      ],
    ]),
  };

  assert.deepEqual(syncAudioSubscriptions(room, "translation:ko"), {
    subscribed: ["translation:ko"],
    unsubscribed: ["original:ja-1", "translation:ja"],
  });
  assert.equal(koreanTranslation.subscribed, true);
  assert.equal(original.subscribed, false);
  assert.equal(japaneseTranslation.subscribed, false);
  assert.equal(camera.subscribed, null);
});

test("a silent plan unsubscribes from every audio track", () => {
  const original = publication("original:ko-1");
  const translation = publication("translation:ja");
  const room = {
    remoteParticipants: new Map([
      [
        "all",
        { trackPublications: new Map([["a", original], ["b", translation]]) },
      ],
    ]),
  };

  const result = syncAudioSubscriptions(room, null);
  assert.deepEqual(result.subscribed, []);
  assert.deepEqual(result.unsubscribed, ["original:ko-1", "translation:ja"]);
});

test("duplicate planned tracks fail before changing any subscription", () => {
  const first = publication("translation:ko");
  const second = publication("translation:ko");
  const original = publication("original:ja-1");
  const room = {
    remoteParticipants: new Map([
      ["first", { trackPublications: new Map([["a", first]]) }],
      ["second", { trackPublications: new Map([["b", second], ["c", original]]) }],
    ]),
  };

  assert.throws(
    () => syncAudioSubscriptions(room, "translation:ko"),
    /matched multiple tracks/,
  );
  assert.equal(first.subscribed, null);
  assert.equal(second.subscribed, null);
  assert.equal(original.subscribed, null);
});
