const SUPPORTED_LANGUAGES = new Set(["ko", "ja"]);

export class MeetingSession {
  #participants;
  #participantById;
  #activeSpeakerId = null;
  #listenerModes = new Map();

  constructor(participants) {
    if (!Array.isArray(participants) || participants.length !== 4) {
      throw new Error("the tracer requires exactly four participants");
    }

    const ids = new Set();
    const languageCounts = { ko: 0, ja: 0 };
    for (const participant of participants) {
      if (!participant?.id || !participant?.name) {
        throw new Error("each participant requires id and name");
      }
      if (!SUPPORTED_LANGUAGES.has(participant.language)) {
        throw new Error(`unsupported language: ${participant.language}`);
      }
      if (ids.has(participant.id)) {
        throw new Error(`duplicate participant: ${participant.id}`);
      }
      ids.add(participant.id);
      languageCounts[participant.language] += 1;
    }
    if (languageCounts.ko !== 2 || languageCounts.ja !== 2) {
      throw new Error("the tracer requires two Korean and two Japanese participants");
    }

    this.#participants = participants.map((participant) => ({ ...participant }));
    this.#participantById = new Map(
      this.#participants.map((participant) => [participant.id, participant]),
    );
  }

  get participants() {
    return this.#participants.map((participant) => ({ ...participant }));
  }

  get activeSpeakerId() {
    return this.#activeSpeakerId;
  }

  startSpeaking(participantId) {
    this.#requireParticipant(participantId);
    if (this.#activeSpeakerId === participantId) {
      return;
    }
    if (this.#activeSpeakerId && this.#activeSpeakerId !== participantId) {
      throw new Error(`${this.#activeSpeakerId} is already speaking`);
    }
    this.#activeSpeakerId = participantId;
    this.#listenerModes.clear();
  }

  stopSpeaking(participantId = this.#activeSpeakerId) {
    if (participantId !== this.#activeSpeakerId) {
      throw new Error(`${participantId} is not the active speaker`);
    }
    this.#activeSpeakerId = null;
    this.#listenerModes.clear();
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

  phraseBoundary() {
    this.#activeSpeaker();
    for (const [listenerId, mode] of this.#listenerModes) {
      if (mode === "original-until-boundary") {
        this.#listenerModes.delete(listenerId);
      }
    }
  }

  audioPlanFor(listenerId) {
    const listener = this.#requireParticipant(listenerId);
    if (!this.#activeSpeakerId) {
      return {
        original: false,
        translation: false,
        trackId: null,
        mode: "silent",
      };
    }

    const speaker = this.#activeSpeaker();
    if (listener.id === speaker.id) {
      return {
        original: false,
        translation: false,
        trackId: null,
        mode: "speaking",
      };
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
      activeSpeakerId: this.#activeSpeakerId,
      participants: this.participants.map((participant) => ({
        ...participant,
        audio: this.audioPlanFor(participant.id),
      })),
    };
  }

  #requireParticipant(participantId) {
    const participant = this.#participantById.get(participantId);
    if (!participant) {
      throw new Error(`unknown participant: ${participantId}`);
    }
    return participant;
  }

  #activeSpeaker() {
    if (!this.#activeSpeakerId) {
      throw new Error("no participant is speaking");
    }
    return this.#participantById.get(this.#activeSpeakerId);
  }
}
