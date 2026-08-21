import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

import { publicationName } from "./provider-canary.mjs";

export class LiveKitAudioGateway {
  #room;
  #translationSinks = new Map();
  #localTracks = [];

  constructor(room) {
    if (!room) throw new Error("connected translator room is required");
    this.#room = room;
  }

  async initialize() {
    await Promise.all([this.translationSink("ko"), this.translationSink("ja")]);
  }

  async translationSink(targetLanguage) {
    if (!new Set(["ko", "ja"]).has(targetLanguage)) {
      throw new Error(`unsupported target language: ${targetLanguage}`);
    }
    const existing = this.#translationSinks.get(targetLanguage);
    if (existing) return existing;

    const source = new AudioSource(24_000, 1);
    const track = LocalAudioTrack.createAudioTrack(`translation:${targetLanguage}`, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.#room.localParticipant.publishTrack(track, options);
    this.#localTracks.push(track);
    const sink = {
      async capture(pcm) {
        const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
        const copy = Uint8Array.from(bytes);
        const samples = new Int16Array(copy.buffer);
        await source.captureFrame(new AudioFrame(samples, 24_000, 1, samples.length));
      },
    };
    this.#translationSinks.set(targetLanguage, sink);
    return sink;
  }

  async subscribeOriginal(trackName, onFrame) {
    const publication = await waitForPublication(this.#room, trackName);
    const track = await subscribe(this.#room, publication);
    const reader = new AudioStream(track, {
      sampleRate: 16_000,
      numChannels: 1,
      frameSizeMs: 100,
    }).getReader();
    let closed = false;
    const pump = (async () => {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) return;
        const pcm = Buffer.from(
          value.data.buffer,
          value.data.byteOffset,
          value.data.byteLength,
        );
        await onFrame(pcm, value.sampleRate);
      }
    })();

    return {
      async close() {
        closed = true;
        publication.setSubscribed(false);
        await reader.cancel();
        await pump.catch((error) => {
          if (!closed) throw error;
        });
      },
    };
  }

  async close() {
    await Promise.allSettled(this.#localTracks.map((track) => track.close(true)));
    this.#localTracks = [];
    this.#translationSinks.clear();
  }
}

function waitForPublication(room, trackName, timeoutMs = 20_000) {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publicationName(publication) === trackName) return Promise.resolve(publication);
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      room.off(RoomEvent.TrackPublished, published);
      reject(new Error(`LiveKit publication timed out: ${trackName}`));
    }, timeoutMs);
    const published = (publication) => {
      if (publicationName(publication) !== trackName) return;
      clearTimeout(timeout);
      room.off(RoomEvent.TrackPublished, published);
      resolve(publication);
    };
    room.on(RoomEvent.TrackPublished, published);
  });
}

function subscribe(room, publication) {
  if (publication.subscribed && publication.track) return Promise.resolve(publication.track);
  return new Promise((resolve, reject) => {
    const subscribed = (track, candidate) => {
      if (candidate !== publication) return;
      cleanup();
      resolve(track);
    };
    const failed = (trackSid, _participant, reason) => {
      if (trackSid !== publication.sid) return;
      cleanup();
      reject(new Error(`LiveKit subscription failed: ${reason ?? trackSid}`));
    };
    const cleanup = () => {
      room.off(RoomEvent.TrackSubscribed, subscribed);
      room.off(RoomEvent.TrackSubscriptionFailed, failed);
    };
    room.on(RoomEvent.TrackSubscribed, subscribed);
    room.on(RoomEvent.TrackSubscriptionFailed, failed);
    publication.setSubscribed(true);
  });
}
