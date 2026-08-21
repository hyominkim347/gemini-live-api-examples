import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createMeetingHttpServer } from "../src/meeting-http.mjs";

async function withServer(service, run) {
  const server = createMeetingHttpServer({ service, staticRoot: null });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("fixed participant can join and drive the shared meeting state over HTTP", async () => {
  const actions = [];
  const service = {
    async join(participantId) {
      if (participantId !== "ko-1") throw new Error("unknown participant: bad-id");
      return {
        livekitUrl: "ws://127.0.0.1:7880",
        roomName: "browser-poc",
        token: "opaque-token",
        participant: { id: "ko-1", language: "ko" },
      };
    },
    action(participantId, action) {
      actions.push({ participantId, action });
      return { activeSpeakerId: participantId };
    },
    snapshot() {
      return { activeSpeakerId: null, participants: [] };
    },
  };

  await withServer(service, async (baseUrl) => {
    const joined = await fetch(`${baseUrl}/api/meeting/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "ko-1" }),
    });
    assert.equal(joined.status, 200);
    assert.deepEqual(await joined.json(), {
      livekitUrl: "ws://127.0.0.1:7880",
      roomName: "browser-poc",
      token: "opaque-token",
      participant: { id: "ko-1", language: "ko" },
    });

    const acted = await fetch(`${baseUrl}/api/meeting/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "ko-1", action: "start-speaking" }),
    });
    assert.equal(acted.status, 200);
    assert.deepEqual(await acted.json(), { activeSpeakerId: "ko-1" });
    assert.deepEqual(actions, [{ participantId: "ko-1", action: "start-speaking" }]);

    const state = await fetch(`${baseUrl}/api/meeting`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { activeSpeakerId: null, participants: [] });
  });
});

test("unknown participant and malformed JSON fail closed", async () => {
  const service = {
    async join() {
      throw new Error("unknown participant: bad-id");
    },
    action() {
      throw new Error("unreachable");
    },
    snapshot() {
      return {};
    },
  };

  await withServer(service, async (baseUrl) => {
    const unknown = await fetch(`${baseUrl}/api/meeting/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "bad-id" }),
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "unknown participant: bad-id" });

    const malformed = await fetch(`${baseUrl}/api/meeting/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid JSON body" });
  });
});
