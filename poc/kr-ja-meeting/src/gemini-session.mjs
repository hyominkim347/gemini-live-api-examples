const TARGET_LANGUAGES = new Set(["ko", "ja"]);

export function buildGeminiSetup({
  targetLanguage,
  resumptionHandle = null,
  automaticActivityDetection = true,
}) {
  if (!TARGET_LANGUAGES.has(targetLanguage)) {
    throw new Error(`unsupported target language: ${targetLanguage}`);
  }

  return {
    setup: {
      model: "models/gemini-3.5-live-translate-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLanguage,
          echoTargetLanguage: true,
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: !automaticActivityDetection },
      },
      sessionResumption: resumptionHandle
        ? { handle: resumptionHandle }
        : {},
    },
  };
}

export class MemoryResumptionHandleStore {
  #handles = new Map();

  get size() {
    return this.#handles.size;
  }

  get(meetingId, targetLanguage) {
    return this.#handles.get(this.#key(meetingId, targetLanguage)) ?? null;
  }

  set(meetingId, targetLanguage, handle) {
    if (!meetingId || !handle) {
      throw new Error("meetingId and handle are required");
    }
    if (!TARGET_LANGUAGES.has(targetLanguage)) {
      throw new Error(`unsupported target language: ${targetLanguage}`);
    }
    this.#handles.set(this.#key(meetingId, targetLanguage), handle);
  }

  clearMeeting(meetingId) {
    for (const key of this.#handles.keys()) {
      if (key.startsWith(`${meetingId}:`)) {
        this.#handles.delete(key);
      }
    }
  }

  #key(meetingId, targetLanguage) {
    return `${meetingId}:${targetLanguage}`;
  }
}
