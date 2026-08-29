export class BrowserAudioPlayout {
  #container;
  #gainByTrackId = new Map();
  #entryByTrackId = new Map();
  #onPlanApplied;
  #onPlayoutEvent;
  #mode = "silent";
  #planKey = null;

  constructor(container, { onPlanApplied = () => {}, onPlayoutEvent = () => {} } = {}) {
    if (!container || typeof container.append !== "function") {
      throw new Error("audio output container is required");
    }
    if (typeof onPlanApplied !== "function") throw new Error("onPlanApplied must be a function");
    if (typeof onPlayoutEvent !== "function") throw new Error("onPlayoutEvent must be a function");
    this.#container = container;
    this.#onPlanApplied = onPlanApplied;
    this.#onPlayoutEvent = onPlayoutEvent;
  }

  setPlan(listeningPlan) {
    const tracks = listeningPlan?.tracks ?? [];
    if (!Array.isArray(tracks)) throw new Error("audio plan tracks must be an array");
    const nextGains = new Map();
    for (const { trackId, gain } of tracks) {
      if (!trackId || nextGains.has(trackId)) throw new Error("audio plan track ids must be unique");
      if (!Number.isFinite(gain) || gain < 0 || gain > 1) {
        throw new Error(`invalid audio gain for ${trackId}`);
      }
      nextGains.set(trackId, gain);
    }

    for (const [trackId, entry] of this.#entryByTrackId) {
      if (!nextGains.has(trackId)) this.#removeEntry(trackId, entry);
    }
    this.#gainByTrackId = nextGains;
    this.#mode = listeningPlan?.mode ?? "silent";
    for (const [trackId, entry] of this.#entryByTrackId) {
      entry.element.volume = nextGains.get(trackId);
    }
    const event = {
      type: "listening-plan-applied",
      mode: listeningPlan?.mode ?? "silent",
      tracks: tracks.map(({ trackId, kind, role, gain }) => ({ trackId, kind, role, gain })),
    };
    const planKey = JSON.stringify(event);
    if (planKey !== this.#planKey) {
      this.#planKey = planKey;
      try {
        this.#onPlanApplied(event);
      } catch {
        // Event hooks cannot interrupt browser audio playback.
      }
    }
  }

  attach(track, publication) {
    const trackId = publication?.trackName ?? publication?.name;
    if (!trackId || !this.#gainByTrackId.has(trackId)) return false;
    if (track?.kind && track.kind !== "audio") return false;

    const existing = this.#entryByTrackId.get(trackId);
    if (existing?.track === track) {
      existing.element.volume = this.#gainByTrackId.get(trackId);
      return true;
    }
    if (existing) this.#removeEntry(trackId, existing);

    let element;
    try {
      element = track.attach();
    } catch {
      this.#emitPlayout({
        type: "playout-aborted",
        trackId,
        listeningMode: this.#mode,
        gain: this.#gainByTrackId.get(trackId),
        result: "failed",
        errorCode: "browser-attach-failed",
      });
      return false;
    }
    element.volume = this.#gainByTrackId.get(trackId);
    element.dataset.trackId = trackId;
    this.#container.append(element);
    this.#entryByTrackId.set(trackId, { track, element });
    this.#emitPlayout({
      type: "playout-attached",
      trackId,
      listeningMode: this.#mode,
      gain: element.volume,
      result: "attached",
    });
    if (typeof element.play === "function") {
      let playResult;
      try {
        playResult = element.play();
      } catch {
        this.#emitPlayout({
          type: "playout-aborted",
          trackId,
          listeningMode: this.#mode,
          gain: element.volume,
          result: "failed",
          errorCode: "browser-play-failed",
        });
        return true;
      }
      Promise.resolve(playResult).then(() => {
        if (this.#entryByTrackId.get(trackId)?.element !== element) return;
        this.#emitPlayout({
          type: "playout-started",
          trackId,
          listeningMode: this.#mode,
          gain: element.volume,
          result: "started",
        });
      }, () => {
        if (this.#entryByTrackId.get(trackId)?.element !== element) return;
        this.#emitPlayout({
          type: "playout-aborted",
          trackId,
          listeningMode: this.#mode,
          gain: element.volume,
          result: "failed",
          errorCode: "browser-play-failed",
        });
      });
    }
    return true;
  }

  detach(track) {
    for (const [trackId, entry] of this.#entryByTrackId) {
      if (entry.track === track) this.#removeEntry(trackId, entry);
    }
  }

  clear() {
    for (const [trackId, entry] of this.#entryByTrackId) {
      this.#removeEntry(trackId, entry);
    }
    this.#gainByTrackId.clear();
    this.#planKey = null;
    this.#mode = "silent";
  }

  #removeEntry(trackId, entry) {
    for (const element of entry.track.detach()) element.remove();
    entry.element.remove();
    this.#entryByTrackId.delete(trackId);
    this.#emitPlayout({
      type: "playout-completed",
      trackId,
      listeningMode: this.#mode,
      gain: entry.element.volume,
      result: "detached",
    });
  }

  #emitPlayout(event) {
    try {
      this.#onPlayoutEvent(event);
    } catch {
      // Event hooks cannot interrupt browser audio playback.
    }
  }
}
