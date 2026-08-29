import { performance } from "node:perf_hooks";

const EVENT_TYPES = new Set([
  "meeting-joined",
  "meeting-left",
  "microphone-enabled",
  "microphone-disabled",
  "speech-started",
  "speech-ended",
  "translation-focus-selected",
  "translation-focus-changed",
  "translation-focus-cleared",
  "overlap-started",
  "overlap-detected",
  "overlap-ended",
  "gemini-setup-started",
  "gemini-setup-succeeded",
  "gemini-setup-failed",
  "gemini-input-started",
  "gemini-input-received",
  "gemini-output-received",
  "gemini-output-completed",
  "gemini-output-aborted",
  "gemini-retry-started",
  "gemini-retry-succeeded",
  "gemini-retry-failed",
  "livekit-publish-started",
  "livekit-publish-succeeded",
  "livekit-publish-failed",
  "livekit-subscribe-started",
  "livekit-subscribe-succeeded",
  "livekit-subscribe-failed",
  "listening-mode-changed",
  "listening-mode-restored",
  "listening-gain-applied",
  "playout-attached",
  "playout-started",
  "playout-completed",
  "playout-aborted",
  "utterance-completed",
  "utterance-aborted",
  "resources-closed",
]);

const STRING_FIELDS = [
  "participantId",
  "utteranceId",
  "language",
  "targetLanguage",
  "result",
  "errorCode",
  "relatedParticipantId",
  "listeningMode",
  "trackId",
  "trackKind",
];

export class MeetingEventRecorder {
  #meetingId;
  #clock;
  #write;

  constructor({ meetingId, clock = () => performance.now(), write } = {}) {
    requireString(meetingId, "meetingId");
    if (typeof clock !== "function") throw new Error("event clock must be a function");
    if (typeof write !== "function") throw new Error("event writer must be a function");
    this.#meetingId = meetingId;
    this.#clock = clock;
    this.#write = write;
  }

  record(event = {}) {
    if (!EVENT_TYPES.has(event.type)) throw new Error(`unsupported meeting event type: ${event.type}`);
    const timestamp = this.#clock();
    if (!Number.isFinite(timestamp)) throw new Error("event timestamp must be finite");
    const safe = {
      type: event.type,
      meetingId: this.#meetingId,
    };
    for (const field of STRING_FIELDS) {
      if (event[field] === undefined) continue;
      requireString(event[field], field);
      safe[field] = event[field];
    }
    if (event.gain !== undefined) {
      if (!Number.isFinite(event.gain) || event.gain < 0 || event.gain > 1) {
        throw new Error("gain must be between zero and one");
      }
      safe.gain = event.gain;
    }
    if (event.detectedAt !== undefined) {
      if (!Number.isFinite(event.detectedAt)) throw new Error("detectedAt must be finite");
      safe.detectedAt = event.detectedAt;
    }
    safe.timestamp = timestamp;
    try {
      this.#write(Object.freeze(safe));
    } catch {
      // Diagnostic delivery cannot change the meeting contract.
    }
    return safe;
  }
}

export function noopMeetingEventRecorder() {
  return { record() {} };
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
}
