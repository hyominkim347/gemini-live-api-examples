import { LiveTranslationBridge } from "./live-translation-bridge.mjs";

export async function runAutomatedContractScenarios() {
  let now = 0;
  const clients = [];
  const captured = [];
  const availability = [];
  const events = [];
  let clearedQueues = 0;

  const bridge = new LiveTranslationBridge({
    meetingId: "automated-contract-canary",
    continuousInput: true,
    clock: () => now,
    onTranslationAvailability(value) {
      availability.push({ value, observedAt: now });
    },
    eventRecorder: { record(event) { events.push(event); } },
    audioGateway: {
      async translationSink() {
        return {
          async capture(pcm) { captured.push(Buffer.from(pcm)); },
          clearQueue() { clearedQueues += 1; },
          queuedDurationMs() { return 0; },
        };
      },
      async subscribeOriginal() {
        return { async close() {} };
      },
    },
    geminiFactory(options) {
      const index = clients.length;
      const client = {
        closed: false,
        connect() {
          if (index <= 1) options.onSetupComplete();
        },
        sendAudioStreamEnd() { return true; },
        sendPcm16() { return true; },
        close() { this.closed = true; },
      };
      clients.push({ client, options });
      return client;
    },
  });

  await bridge.start({ id: "ja-speaker", language: "ja" }, { utteranceId: "utterance-1" });
  now = 100;
  const interruption = await bridge.handoff(
    { id: "ko-speaker", language: "ko" },
    { utteranceId: "utterance-2" },
  );
  const capturedAfterHandoff = captured.length;
  await clients[0].options.onTranslatedAudio(audiblePcmBase64(1));
  const handoffStaleOutputBlocked = captured.length === capturedAfterHandoff && clearedQueues > 0;

  now = 200;
  const providerClosedAt = now;
  clients[1].options.onClose();
  await waitUntil(() => clients.length === 3);
  const reconnecting = availability.find(({ value }) => value === "reconnecting");
  const capturedBeforeRecoveryStaleOutput = captured.length;
  await clients[1].options.onTranslatedAudio(audiblePcmBase64(2));
  const recoveryStaleOutputBlocked = captured.length === capturedBeforeRecoveryStaleOutput;
  now = 600;
  clients[2].options.onSetupComplete();
  await waitUntil(() => availability.at(-1)?.value === "available");

  now = 3_599_600;
  clients[2].options.onServerEvent({ goAway: true, timeLeftMilliseconds: 400 });
  await waitUntil(() => clients.length === 4);
  const capturedBeforeProactiveStaleOutput = captured.length;
  await clients[2].options.onTranslatedAudio(audiblePcmBase64(3));
  const proactiveStaleOutputBlocked = captured.length === capturedBeforeProactiveStaleOutput;
  now = 3_600_000;
  clients[3].options.onSetupComplete();
  await waitUntil(() => availability.at(-1)?.value === "available");
  await clients[3].options.onTranslatedAudio(audiblePcmBase64(4));

  const proactiveReplacementEvent = events.find(({ type, reconnectReason }) =>
    type === "gemini-retry-succeeded" && reconnectReason === "go-away-time-left");
  const measurements = {
    interruptionMilliseconds: interruption.interruptionMilliseconds,
    reconnectStatusMilliseconds: reconnecting?.observedAt - providerClosedAt,
    staleOutputBlocked: handoffStaleOutputBlocked
      && recoveryStaleOutputBlocked
      && proactiveStaleOutputBlocked,
    replacementGapMilliseconds: proactiveReplacementEvent?.interruptionMilliseconds,
    acceleratedMeetingMinutes: now / 60_000,
    proactiveReplacement: Boolean(proactiveReplacementEvent) && clients[2].client.closed,
    outputContinued: captured.some((pcm) => pcm.equals(Buffer.from([4, 0]))),
  };
  await bridge.abort();
  return measurements;
}

function audiblePcmBase64(marker) {
  return Buffer.from([marker, 0]).toString("base64");
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("automated contract scenario did not reach the expected state");
}
