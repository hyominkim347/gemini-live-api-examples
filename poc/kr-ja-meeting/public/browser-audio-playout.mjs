export class BrowserAudioPlayout {
  #container;
  #gainByTrackId = new Map();
  #entryByTrackId = new Map();
  #onPlanApplied;
  #planKey = null;

  constructor(container, { onPlanApplied = () => {} } = {}) {
    if (!container || typeof container.append !== "function") {
      throw new Error("audio output container is required");
    }
    if (typeof onPlanApplied !== "function") throw new Error("onPlanApplied must be a function");
    this.#container = container;
    this.#onPlanApplied = onPlanApplied;
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

    const element = track.attach();
    element.volume = this.#gainByTrackId.get(trackId);
    element.dataset.trackId = trackId;
    this.#container.append(element);
    this.#entryByTrackId.set(trackId, { track, element });
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
  }

  #removeEntry(trackId, entry) {
    for (const element of entry.track.detach()) element.remove();
    entry.element.remove();
    this.#entryByTrackId.delete(trackId);
  }
}
