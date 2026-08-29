const REQUIRED_EVIDENCE = new Map([
  ["participantsConnected", (value) => Number.isInteger(value) && value >= 4],
  ["originalTrackSubscribed", (value) => value === true],
  ["geminiSetupComplete", (value) => value === true],
  ["translatedFrames", (value) => Number.isInteger(value) && value > 0],
  ["translationTrackPublished", (value) => value === true],
  ["translationTrackSubscribed", (value) => value === true],
  ["listenerReceivedTranslatedAudio", (value) => value === true],
  ["phraseBoundary", (value) => value === true],
  ["freshSessionSetup", (value) => value === true],
  ["originalCheckExclusive", (value) => value === true],
  ["translationRestoredAtBoundary", (value) => value === true],
]);

export const GEMINI_INPUT_SAMPLE_RATE = 16_000;

export function publicationName(publication) {
  return publication?.name ?? publication?.trackName ?? null;
}

export class ProviderCanaryEvidence {
  #values = new Map();

  record(name, value) {
    if (!REQUIRED_EVIDENCE.has(name)) {
      throw new Error(`unknown provider evidence: ${name}`);
    }
    if (
      name === "phraseBoundary" &&
      this.#values.get("originalCheckExclusive") !== true
    ) {
      throw new Error("original check must start before the phrase boundary");
    }
    if (
      name === "translationRestoredAtBoundary" &&
      this.#values.get("phraseBoundary") !== true
    ) {
      throw new Error("translation can return only after the phrase boundary");
    }
    this.#values.set(name, value);
  }

  get complete() {
    return [...REQUIRED_EVIDENCE].every(([name, validate]) =>
      validate(this.#values.get(name)),
    );
  }

  snapshot() {
    return Object.fromEntries(
      [...REQUIRED_EVIDENCE.keys()].map((name) => [
        name,
        this.#values.get(name) ?? false,
      ]),
    );
  }
}

const SEMANTIC_DIRECTIONS = new Set(["ko-to-ja", "ja-to-ko"]);

export class ProviderSemanticEvidence {
  #trialsByDirection = new Map([
    ["ko-to-ja", []],
    ["ja-to-ko", []],
  ]);
  #trialIds = new Set();

  record({ direction, trialId, firstMeaning, lastMeaning } = {}) {
    if (!SEMANTIC_DIRECTIONS.has(direction)) {
      throw new Error(`unsupported semantic direction: ${direction}`);
    }
    if (typeof trialId !== "string" || !trialId) {
      throw new Error("semantic trial id is required");
    }
    if (this.#trialIds.has(trialId)) throw new Error(`duplicate semantic trial: ${trialId}`);
    if (typeof firstMeaning !== "boolean" || typeof lastMeaning !== "boolean") {
      throw new Error("semantic meaning evidence must be boolean");
    }
    const trials = this.#trialsByDirection.get(direction);
    if (trials.length >= 3) throw new Error(`too many semantic trials: ${direction}`);
    this.#trialIds.add(trialId);
    trials.push({ firstMeaning, lastMeaning });
  }

  get complete() {
    return [...this.#trialsByDirection.values()].every((trials) =>
      trials.length === 3 && trials.every(({ firstMeaning, lastMeaning }) =>
        firstMeaning && lastMeaning));
  }

  snapshot() {
    return {
      ok: this.complete,
      "ko-to-ja": this.#trialsByDirection.get("ko-to-ja").map((trial) => ({ ...trial })),
      "ja-to-ko": this.#trialsByDirection.get("ja-to-ko").map((trial) => ({ ...trial })),
    };
  }
}
