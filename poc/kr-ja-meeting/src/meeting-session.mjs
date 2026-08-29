const SUPPORTED_LANGUAGES = new Set(["ko", "ja"]);

export class MeetingSession {
  #participantById = new Map();
  #translationFocusId = null;
  #listenerModes = new Map();

  constructor(participants = []) {
    if (!Array.isArray(participants)) throw new Error("participants must be an array");
    for (const participant of participants) this.join(participant);
  }

  get participants() {
    return [...this.#participantById.values()].map(({ microphone, speech, utteranceId, ...participant }) => ({
      ...participant,
      microphone,
      speech,
      utteranceId,
    }));
  }

  get activeSpeakerId() {
    return this.#translationFocusId;
  }

  get activeUtteranceId() {
    return this.#translationFocusId
      ? this.#participantById.get(this.#translationFocusId)?.utteranceId ?? null
      : null;
  }

  get translationFocusId() {
    return this.#translationFocusId;
  }

  get speakingParticipantIds() {
    return this.participants.filter(({ speech }) => speech === "speaking").map(({ id }) => id);
  }

  join(participant) {
    validateParticipant(participant);
    if (this.#participantById.has(participant.id)) {
      throw new Error(`duplicate participant: ${participant.id}`);
    }
    this.#participantById.set(participant.id, {
      ...participant,
      microphone: "muted",
      speech: "silent",
      utteranceId: null,
    });
  }

  leave(participantId) {
    this.#requireParticipant(participantId);
    if (this.isSpeaking(participantId)) this.endSpeech(participantId);
    this.#listenerModes.delete(participantId);
    this.#participantById.delete(participantId);
  }

  setMicrophone(participantId, enabled) {
    const participant = this.#requireParticipant(participantId);
    participant.microphone = enabled ? "unmuted" : "muted";
    if (!enabled && participant.speech === "speaking") this.endSpeech(participantId);
  }

  startSpeech(participantId, utteranceId) {
    const participant = this.#requireParticipant(participantId);
    if (participant.microphone !== "unmuted") {
      throw new Error(`${participantId} microphone is muted`);
    }
    if (!utteranceId) throw new Error("utteranceId is required");
    if (participant.speech === "speaking") return participant.utteranceId;
    participant.speech = "speaking";
    participant.utteranceId = utteranceId;
    if (!this.#translationFocusId) this.#translationFocusId = participantId;
    this.#listenerModes.clear();
    return utteranceId;
  }

  endSpeech(participantId = this.#translationFocusId) {
    const participant = this.#requireParticipant(participantId);
    if (participant.speech !== "speaking") throw new Error(`${participantId} is not speaking`);
    participant.speech = "silent";
    participant.utteranceId = null;
    if (this.#translationFocusId === participantId) this.#translationFocusId = null;
    this.#listenerModes.clear();
  }

  setTranslationFocus(participantId) {
    if (participantId === null) {
      this.#translationFocusId = null;
      return;
    }
    const participant = this.#requireParticipant(participantId);
    if (participant.speech !== "speaking") throw new Error(`${participantId} is not speaking`);
    this.#translationFocusId = participantId;
  }

  isSpeaking(participantId) {
    return this.#requireParticipant(participantId).speech === "speaking";
  }

  holdOriginal(listenerId) {
    const listener = this.#requireParticipant(listenerId);
    const speaker = this.#activeSpeaker();
    if (listener.id === speaker.id || listener.language === speaker.language) {
      throw new Error("original check is only available for foreign speech");
    }
    this.#listenerModes.set(listenerId, "original");
  }

  releaseOriginal(listenerId) {
    if (this.#listenerModes.get(listenerId) !== "original") {
      throw new Error(`${listenerId} is not checking original audio`);
    }
    this.#listenerModes.set(listenerId, "original-until-boundary");
  }

  audioPlanFor(listenerId) {
    const listener = this.#requireParticipant(listenerId);
    if (!this.#translationFocusId) {
      return { original: false, translation: false, trackId: null, mode: "silent" };
    }

    const speaker = this.#activeSpeaker();
    if (listener.id === speaker.id) {
      return { original: false, translation: false, trackId: null, mode: "speaking" };
    }
    if (listener.language === speaker.language) {
      return {
        original: true,
        translation: false,
        trackId: `original:${speaker.id}`,
        mode: "same-language-original",
      };
    }
    const requestedMode = this.#listenerModes.get(listenerId);
    if (requestedMode) {
      return {
        original: true,
        translation: false,
        trackId: `original:${speaker.id}`,
        mode: requestedMode,
      };
    }
    return {
      original: false,
      translation: true,
      trackId: `translation:${listener.language}`,
      mode: "translated",
    };
  }

  snapshot() {
    return {
      activeSpeakerId: this.#translationFocusId,
      translationFocusId: this.#translationFocusId,
      activeUtteranceId: this.activeUtteranceId,
      speakingParticipantIds: this.speakingParticipantIds,
      participants: this.participants.map((participant) => ({
        ...participant,
        audio: this.audioPlanFor(participant.id),
      })),
    };
  }

  participant(participantId) {
    const { microphone, speech, utteranceId, ...participant } = this.#requireParticipant(participantId);
    return { ...participant };
  }

  #requireParticipant(participantId) {
    const participant = this.#participantById.get(participantId);
    if (!participant) throw new Error(`unknown participant: ${participantId}`);
    return participant;
  }

  #activeSpeaker() {
    if (!this.#translationFocusId) throw new Error("no participant has translation focus");
    return this.#participantById.get(this.#translationFocusId);
  }
}

function validateParticipant(participant) {
  if (!participant?.id || !participant?.name) throw new Error("each participant requires id and name");
  if (!SUPPORTED_LANGUAGES.has(participant.language)) {
    throw new Error(`unsupported language: ${participant.language}`);
  }
}
