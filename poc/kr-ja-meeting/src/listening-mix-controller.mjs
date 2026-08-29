const FOREGROUND_GAIN = 1;
const ORIGINAL_BACKGROUND_GAIN = 0.2;

export class ListeningMixController {
  planFor({ listener, speaker } = {}) {
    if (!listener?.id || !listener?.language || !speaker?.id || !speaker?.language) {
      throw new Error("listener and speaker are required");
    }

    if (listener.language === speaker.language) {
      return {
        mode: "same-language-original",
        tracks: [originalTrack(speaker.id, "foreground", FOREGROUND_GAIN)],
      };
    }

    return {
      mode: "translation-focused",
      tracks: [
        originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN),
        {
          trackId: `translation:${listener.language}`,
          kind: "translation",
          role: "foreground",
          gain: FOREGROUND_GAIN,
        },
      ],
    };
  }
}

function originalTrack(speakerId, role, gain) {
  return {
    trackId: `original:${speakerId}`,
    kind: "original",
    role,
    gain,
  };
}
