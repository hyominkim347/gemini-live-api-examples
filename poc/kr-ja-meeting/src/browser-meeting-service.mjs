import { randomUUID } from "node:crypto";

import { MeetingSession } from "./meeting-session.mjs";

const SUPPORTED_LANGUAGES = new Set(["ko", "ja"]);
const SPEECH_ACTIVITY_TYPES = new Set(["speech-start", "speech-end"]);

export class BrowserMeetingService {
  #roomName;
  #livekitUrl;
  #tokenIssuer;
  #translationBridge;
  #participantIdFactory;
  #utteranceIdFactory;
  #session = new MeetingSession();
  #actionChain = Promise.resolve();

  constructor({
    roomName,
    livekitUrl,
    tokenIssuer,
    translationBridge,
    participantIdFactory = () => `participant-${randomUUID()}`,
    utteranceIdFactory = () => `utterance-${randomUUID()}`,
  }) {
    if (!roomName || !livekitUrl || !tokenIssuer || !translationBridge) {
      throw new Error("roomName, livekitUrl, tokenIssuer, and translationBridge are required");
    }
    this.#roomName = roomName;
    this.#livekitUrl = livekitUrl;
    this.#tokenIssuer = tokenIssuer;
    this.#translationBridge = translationBridge;
    this.#participantIdFactory = participantIdFactory;
    this.#utteranceIdFactory = utteranceIdFactory;
  }

  join({ name, language } = {}) {
    return this.#enqueue(async () => {
      const participant = this.#newParticipant(name, language);
      this.#session.join(participant);
      try {
        return {
          livekitUrl: this.#livekitUrl,
          roomName: this.#roomName,
          token: await this.#tokenIssuer(participant),
          participant: { ...participant },
        };
      } catch (error) {
        this.#session.leave(participant.id);
        throw error;
      }
    });
  }

  leave(participantId) {
    return this.#enqueue(async () => {
      this.#session.participant(participantId);
      try {
        if (this.#session.activeSpeakerId === participantId) {
          await this.#endSpeech(participantId, undefined);
        }
      } finally {
        this.#session.leave(participantId);
      }
      return this.snapshot();
    });
  }

  mic(participantId, enabled) {
    return this.#enqueue(async () => {
      if (typeof enabled !== "boolean") throw new Error("microphone enabled must be a boolean");
      this.#session.participant(participantId);
      try {
        if (!enabled && this.#session.activeSpeakerId === participantId) {
          await this.#endSpeech(participantId, undefined);
        }
      } finally {
        this.#session.setMicrophone(participantId, enabled);
      }
      return this.snapshot();
    });
  }

  speechActivity({ participantId, type, observedAt } = {}) {
    return this.#enqueue(async () => {
      if (!SPEECH_ACTIVITY_TYPES.has(type)) {
        throw new Error(`unsupported speech activity: ${type}`);
      }
      if (!Number.isFinite(observedAt)) throw new Error("speech activity observedAt is required");
      const participant = this.#session.participant(participantId);
      if (type === "speech-start") {
        if (this.#session.activeSpeakerId === participantId) return this.snapshot();
        const utteranceId = this.#utteranceIdFactory();
        this.#session.startSpeech(participantId, utteranceId);
        try {
          await this.#translationBridge.start(participant, { utteranceId, observedAt });
        } catch (error) {
          this.#session.endSpeech(participantId);
          throw error;
        }
      } else {
        if (this.#session.activeSpeakerId !== participantId) return this.snapshot();
        await this.#endSpeech(participantId, observedAt);
      }
      return this.snapshot();
    });
  }

  snapshot() {
    return this.#session.snapshot();
  }

  action(participantId, action) {
    return this.#enqueue(async () => {
      this.#session.participant(participantId);
      if (action === "hold-original") {
        this.#session.holdOriginal(participantId);
      } else if (action === "release-original") {
        this.#session.releaseOriginal(participantId);
      } else {
        throw new Error(`unsupported meeting action: ${action}`);
      }
      return this.snapshot();
    });
  }

  async #endSpeech(participantId, observedAt) {
    const utteranceId = this.#session.activeUtteranceId;
    try {
      await this.#translationBridge.stop({ utteranceId, observedAt });
    } finally {
      this.#session.endSpeech(participantId);
    }
  }

  #newParticipant(name, language) {
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName) throw new Error("display name is required");
    if (!SUPPORTED_LANGUAGES.has(language)) throw new Error(`unsupported language: ${language}`);
    const id = this.#participantIdFactory();
    if (!id || typeof id !== "string") throw new Error("participant id factory returned an invalid id");
    return { id, name: normalizedName, language };
  }

  #enqueue(operation) {
    const execution = this.#actionChain.then(operation);
    this.#actionChain = execution.catch(() => {});
    return execution;
  }
}
