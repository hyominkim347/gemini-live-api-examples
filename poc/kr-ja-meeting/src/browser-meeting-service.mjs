import { randomUUID } from "node:crypto";

import { MeetingSession } from "./meeting-session.mjs";
import { TranslationFocusPolicy } from "./translation-focus-policy.mjs";

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
  #translationFocusPolicy;
  #onListeningEvent;
  #actionChain = Promise.resolve();

  constructor({
    roomName,
    livekitUrl,
    tokenIssuer,
    translationBridge,
    participantIdFactory = () => `participant-${randomUUID()}`,
    utteranceIdFactory = () => `utterance-${randomUUID()}`,
    clock = () => Date.now(),
    minimumFocusHoldMilliseconds,
    overlapWarningMilliseconds,
    onListeningEvent = () => {},
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
    this.#translationFocusPolicy = new TranslationFocusPolicy({
      clock,
      minimumFocusHoldMilliseconds,
      overlapWarningMilliseconds,
    });
    if (typeof onListeningEvent !== "function") throw new Error("onListeningEvent must be a function");
    this.#onListeningEvent = onListeningEvent;
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
        if (this.#session.isSpeaking(participantId)) {
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
        if (!enabled && this.#session.isSpeaking(participantId)) {
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
        if (this.#session.isSpeaking(participantId)) return this.snapshot();
        const utteranceId = this.#utteranceIdFactory();
        const previousFocusId = this.#session.translationFocusId;
        this.#session.startSpeech(participantId, utteranceId);
        const focus = this.#translationFocusPolicy.speechStarted(participantId);
        this.#session.setTranslationFocus(focus.translationFocusId);
        try {
          if (!previousFocusId) {
            await this.#translationBridge.start(participant, { utteranceId, observedAt });
          }
        } catch (error) {
          this.#session.endSpeech(participantId);
          this.#translationFocusPolicy.speechEnded(participantId);
          throw error;
        }
      } else {
        if (!this.#session.isSpeaking(participantId)) return this.snapshot();
        await this.#endSpeech(participantId, observedAt);
      }
      return this.snapshot();
    });
  }

  snapshot() {
    const focus = this.#translationFocusPolicy.snapshot();
    return {
      ...this.#session.snapshot(),
      speakingParticipantIds: focus.speakingParticipantIds,
      translationFocusId: focus.translationFocusId,
      focus: {
        selectedAt: focus.focusSelectedAt,
        protectedUntil: focus.focusProtectedUntil,
      },
      overlap: focus.overlap,
    };
  }

  listeningMode(participantId, mode) {
    return this.#enqueue(async () => {
      const change = this.#session.setListeningMode(participantId, mode);
      if (change.changed) {
        this.#emitListeningEvent({
          type: "listening-mode-changed",
          participantId,
          previousMode: change.previousMode,
          mode: change.mode,
        });
      }
      return this.snapshot();
    });
  }

  action(participantId, action) {
    return this.#enqueue(async () => {
      this.#session.participant(participantId);
      throw new Error(`unsupported meeting action: ${action}`);
    });
  }

  async #endSpeech(participantId, observedAt) {
    const wasFocused = this.#session.translationFocusId === participantId;
    const previousUtteranceId = wasFocused ? this.#session.activeUtteranceId : null;
    const restoredListeningModes = this.#session.endSpeech(participantId);
    for (const restored of restoredListeningModes) {
      this.#emitListeningEvent({ type: "listening-mode-restored", ...restored });
    }
    const focus = this.#translationFocusPolicy.speechEnded(participantId);
    if (!wasFocused) return;
    try {
      if (focus.translationFocusId) {
        const nextParticipant = this.#session.participant(focus.translationFocusId);
        const nextState = this.#session.participants.find(({ id }) => id === focus.translationFocusId);
        await this.#translationBridge.handoff(nextParticipant, {
          previousUtteranceId,
          utteranceId: nextState.utteranceId,
          observedAt,
        });
        this.#session.setTranslationFocus(focus.translationFocusId);
      } else {
        await this.#translationBridge.stop({ utteranceId: previousUtteranceId, observedAt });
      }
    } catch (error) {
      this.#translationFocusPolicy.clearFocus();
      this.#session.setTranslationFocus(null);
      throw error;
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

  #emitListeningEvent(event) {
    try {
      this.#onListeningEvent(event);
    } catch {
      // Observability hooks cannot change the meeting contract.
    }
  }
}
