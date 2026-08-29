const DEFAULT_OVERLAP_WARNING_MILLISECONDS = 1_500;

export class TranslationFocusPolicy {
  #clock;
  #overlapWarningMilliseconds;
  #speaking = new Map();
  #translationFocusId = null;
  #focusSelectedAt = null;
  #overlapStartedAt = null;
  #overlapDetectedAt = null;
  #pendingTransitions = [];

  constructor({
    clock = () => Date.now(),
    overlapWarningMilliseconds = DEFAULT_OVERLAP_WARNING_MILLISECONDS,
  } = {}) {
    if (typeof clock !== "function") throw new Error("translation focus clock is required");
    validateDuration(overlapWarningMilliseconds, "overlap warning");
    this.#clock = clock;
    this.#overlapWarningMilliseconds = overlapWarningMilliseconds;
  }

  speechStarted(participantId, observedAt = this.#clock()) {
    validateParticipantId(participantId);
    validateTimestamp(observedAt);
    if (this.#speaking.has(participantId)) return this.snapshot(observedAt);
    this.#speaking.set(participantId, observedAt);
    if (this.#speaking.size === 2) {
      this.#overlapStartedAt = observedAt;
      this.#overlapDetectedAt = null;
    }
    if (!this.#translationFocusId) this.#selectFocus(participantId, observedAt);
    return this.snapshot(observedAt);
  }

  speechEnded(participantId, observedAt = this.#clock()) {
    validateParticipantId(participantId);
    validateTimestamp(observedAt);
    if (!this.#speaking.delete(participantId)) return this.snapshot(observedAt);
    if (this.#speaking.size < 2) {
      this.#overlapStartedAt = null;
      this.#overlapDetectedAt = null;
    }
    if (this.#translationFocusId === participantId) {
      const nextParticipantId = this.#speaking.keys().next().value ?? null;
      this.#translationFocusId = null;
      this.#focusSelectedAt = null;
      if (nextParticipantId) this.#selectFocus(nextParticipantId, observedAt);
    }
    return this.snapshot(observedAt);
  }

  clearFocus() {
    this.#translationFocusId = null;
    this.#focusSelectedAt = null;
  }

  takeTransitions() {
    const transitions = this.#pendingTransitions;
    this.#pendingTransitions = [];
    return transitions;
  }

  snapshot(observedAt = this.#clock()) {
    validateTimestamp(observedAt);
    const speakingParticipantIds = [...this.#speaking.keys()];
    const overlapActive = speakingParticipantIds.length > 1;
    if (
      overlapActive
      && this.#overlapDetectedAt === null
      && observedAt - this.#overlapStartedAt >= this.#overlapWarningMilliseconds
    ) {
      this.#overlapDetectedAt = this.#overlapStartedAt + this.#overlapWarningMilliseconds;
      this.#pendingTransitions.push({
        type: "overlap-detected",
        observedAt: this.#overlapDetectedAt,
        participantIds: speakingParticipantIds,
      });
    }
    const overlapDetected = overlapActive && this.#overlapDetectedAt !== null;
    return {
      speakingParticipantIds,
      translationFocusId: this.#translationFocusId,
      focusSelectedAt: this.#focusSelectedAt,
      overlap: {
        active: overlapActive,
        detected: overlapDetected,
        participantIds: overlapActive ? speakingParticipantIds : [],
        startedAt: overlapActive ? this.#overlapStartedAt : null,
        detectedAt: overlapDetected ? this.#overlapDetectedAt : null,
        message: overlapDetected
          ? "동시에 말하고 있어 일부 통역이 불완전할 수 있습니다."
          : null,
      },
    };
  }

  #selectFocus(participantId, observedAt) {
    this.#translationFocusId = participantId;
    this.#focusSelectedAt = observedAt;
  }
}

function validateDuration(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} milliseconds must be non-negative`);
}

function validateTimestamp(value) {
  if (!Number.isFinite(value)) throw new Error("translation focus timestamp is required");
}

function validateParticipantId(value) {
  if (typeof value !== "string" || !value) throw new Error("translation focus participant id is required");
}
