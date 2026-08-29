export class SpeechActivityDetector {
  #onEvent;
  #speechThreshold;
  #silenceMilliseconds;
  #speaking = false;
  #lastVoiceAt = null;

  constructor({ onEvent, speechThreshold = 0.05, silenceMilliseconds = 600 }) {
    if (typeof onEvent !== "function") throw new Error("onEvent is required");
    if (!(speechThreshold > 0)) throw new Error("speechThreshold must be positive");
    if (!(silenceMilliseconds >= 0)) throw new Error("silenceMilliseconds must be non-negative");
    this.#onEvent = onEvent;
    this.#speechThreshold = speechThreshold;
    this.#silenceMilliseconds = silenceMilliseconds;
  }

  observe(level, observedAt) {
    if (!Number.isFinite(level) || !Number.isFinite(observedAt)) {
      throw new Error("finite level and observedAt are required");
    }
    if (level >= this.#speechThreshold) {
      this.#lastVoiceAt = observedAt;
      if (!this.#speaking) {
        this.#speaking = true;
        this.#onEvent({ type: "speech-start", observedAt });
      }
      return;
    }
    if (
      this.#speaking &&
      observedAt - this.#lastVoiceAt >= this.#silenceMilliseconds
    ) {
      this.#speaking = false;
      this.#lastVoiceAt = null;
      this.#onEvent({ type: "speech-end", observedAt });
    }
  }

  stop(observedAt) {
    if (!this.#speaking) return;
    if (!Number.isFinite(observedAt)) throw new Error("finite observedAt is required");
    this.#speaking = false;
    this.#lastVoiceAt = null;
    this.#onEvent({ type: "speech-end", observedAt });
  }
}
