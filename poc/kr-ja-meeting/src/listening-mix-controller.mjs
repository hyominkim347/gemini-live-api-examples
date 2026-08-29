const FOREGROUND_GAIN = 1;
const ORIGINAL_BACKGROUND_GAIN = 0.2;

export class ListeningMixController {
  planFor({ listener, speakers, focusSpeaker, mode = "translation-focused" } = {}) {
    if (!listener?.id || !listener?.language || !Array.isArray(speakers) || !focusSpeaker?.id) {
      throw new Error("listener, speakers, and focusSpeaker are required");
    }
    if (!speakers.some(({ id }) => id === focusSpeaker.id)) {
      throw new Error("focusSpeaker must be speaking");
    }

    const tracks = [];
    for (const speaker of speakers) {
      if (!speaker?.id || !speaker?.language) throw new Error("each speaker is required");
      if (speaker.id === listener.id) continue;

      if (listener.language === speaker.language) {
        tracks.push(originalTrack(speaker.id, "foreground", FOREGROUND_GAIN));
        continue;
      }

      if (speaker.id !== focusSpeaker.id) {
        if (mode !== "translation-only") {
          tracks.push(originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN));
        }
        continue;
      }

      if (mode === "translation-only") {
        tracks.push(translationTrack(listener.language));
      } else if (mode === "original-check") {
        tracks.push(originalTrack(speaker.id, "foreground", FOREGROUND_GAIN));
      } else if (mode === "translation-focused") {
        tracks.push(
          originalTrack(speaker.id, "background", ORIGINAL_BACKGROUND_GAIN),
          translationTrack(listener.language),
        );
      } else {
        throw new Error(`unsupported listening mode: ${mode}`);
      }
    }

    const focusIsForeign = listener.id !== focusSpeaker.id
      && listener.language !== focusSpeaker.language;
    if (focusIsForeign) {
      return {
        mode,
        tracks,
      };
    }
    return {
      mode: listener.id === focusSpeaker.id ? "speaking" : "same-language-original",
      tracks,
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
