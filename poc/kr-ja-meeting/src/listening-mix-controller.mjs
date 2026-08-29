const FOREGROUND_GAIN = 1;
const ORIGINAL_BACKGROUND_GAIN = 0.2;

export class ListeningMixController {
  planFor({ listener, speaker, mode = "translation-focused" } = {}) {
    if (!listener?.id || !listener?.language || !speaker?.id || !speaker?.language) {
      throw new Error("listener and speaker are required");
    }

    if (listener.language === speaker.language) {
      return {
        mode: "same-language-original",
        tracks: [originalTrack(speaker.id, "foreground", FOREGROUND_GAIN)],
      };
    }

    if (mode === "translation-only") {
      return {
        mode,
        tracks: [translationTrack(listener.language)],
      };
    }

    if (mode === "original-check") {
      return {
        mode,
        tracks: [originalTrack(speaker.id, "foreground", FOREGROUND_GAIN)],
      };
    }

    if (mode !== "translation-focused") throw new Error(`unsupported listening mode: ${mode}`);

    return {
      mode,
      tracks: [
        originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN),
        translationTrack(listener.language),
      ],
    };
  }
}

function translationTrack(language) {
  return {
    trackId: `translation:${language}`,
    kind: "translation",
    role: "foreground",
    gain: FOREGROUND_GAIN,
  };
}

function originalTrack(speakerId, role, gain) {
  return {
    trackId: `original:${speakerId}`,
    kind: "original",
    role,
    gain,
  };
}
