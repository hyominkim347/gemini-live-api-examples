export class LiveTranslationBridge {
  #meetingId;
  #audioGateway;
  #geminiFactory;
  #drainQuietMilliseconds;
  #firstAudioTimeoutMilliseconds;
  #eventRecorder;
  #active = null;
  #startingClient = null;
  #startPromise = null;
  #abortRevision = 0;

  constructor({
    meetingId,
    audioGateway,
    geminiFactory,
    drainQuietMilliseconds = 750,
    firstAudioTimeoutMilliseconds = 5_000,
    eventRecorder = { record() {} },
  }) {
    if (!meetingId || !audioGateway || !geminiFactory) {
      throw new Error("meetingId, audioGateway, and geminiFactory are required");
    }
    this.#meetingId = meetingId;
    this.#audioGateway = audioGateway;
    this.#geminiFactory = geminiFactory;
    this.#drainQuietMilliseconds = drainQuietMilliseconds;
    this.#firstAudioTimeoutMilliseconds = firstAudioTimeoutMilliseconds;
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#eventRecorder = eventRecorder;
  }

  start(speaker, { utteranceId } = {}) {
    if (this.#active || this.#startPromise) {
      return Promise.reject(new Error("translation bridge is already active"));
    }
    const startRevision = this.#abortRevision;
    const startPromise = this.#startSpeaker(speaker, utteranceId, startRevision);
    this.#startPromise = startPromise;
    return startPromise.finally(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
  }

  async #startSpeaker(speaker, utteranceId, startRevision) {
    const targetLanguage = speaker.language === "ko" ? "ja" : "ko";
    let gemini;
    let originalSubscription;
    let captureChain = Promise.resolve();
    let lastTranslatedAudioAt = 0;
    let audibleOutputReceived = false;
    let audibleInputReceived = false;
    let acceptingInput = true;
    let inputRecorded = false;
    let outputRecorded = false;
    let setupSucceeded = false;
    let audioDrainGeneration = 0;
    const drainQuietMilliseconds = this.#drainQuietMilliseconds;
    const firstAudioTimeoutMilliseconds = this.#firstAudioTimeoutMilliseconds;
    const context = {
      participantId: speaker.id,
      utteranceId,
      language: speaker.language,
    };
    this.#record("gemini-setup-started", context, { result: "started" });
    try {
      const sink = await this.#audioGateway.translationSink(targetLanguage);
      this.#throwIfAborted(startRevision);
      const setup = deferred();
      gemini = this.#geminiFactory({
        meetingId: this.#meetingId,
        targetLanguage,
        participantId: speaker.id,
        utteranceId,
        eventRecorder: this.#eventRecorder,
        onSetupComplete: setup.resolve,
        onClose() { setup.reject(new Error("Gemini closed during setup")); },
        onError: setup.reject,
        onTranslatedAudio: (base64Audio) => {
          const pcm = Buffer.from(base64Audio, "base64");
          if (hasAudiblePcm(pcm)) {
            audibleOutputReceived = true;
            lastTranslatedAudioAt = Date.now();
            if (!outputRecorded) {
              outputRecorded = true;
              this.#record("gemini-output-received", context, { result: "received" });
              this.#record("playout-started", context, { result: "started" });
            }
          }
          captureChain = captureChain.then(() => sink.capture(pcm));
          return captureChain;
        },
      });
      this.#startingClient = gemini;

      gemini.connect();
      await withTimeout(setup.promise, "Gemini setup", 20_000);
      this.#record("gemini-setup-succeeded", context, { result: "succeeded" });
      setupSucceeded = true;
      this.#throwIfAborted(startRevision);
      if (!gemini.sendActivityStart()) {
        throw new Error("Gemini activityStart was not sent");
      }
      this.#record("gemini-input-started", context, { result: "started" });

      this.#record("livekit-subscribe-started", context, { result: "started" });
      try {
        originalSubscription = await this.#audioGateway.subscribeOriginal(
          `original:${speaker.id}`,
          (pcm, sampleRate) => {
          if (!acceptingInput) return;
          if (hasAudiblePcm(pcm)) {
            audibleInputReceived = true;
            if (!inputRecorded) {
              inputRecorded = true;
              this.#record("gemini-input-received", context, { result: "received" });
            }
          }
          if (!gemini.sendPcm16(pcm, sampleRate)) {
            throw new Error("Gemini PCM frame was not sent");
          }
          },
        );
        this.#record("livekit-subscribe-succeeded", context, { result: "succeeded" });
      } catch (error) {
        this.#record("livekit-subscribe-failed", context, {
          result: "failed",
          errorCode: "original-subscription-failed",
        });
        throw error;
      }
      this.#throwIfAborted(startRevision);
      this.#active = {
        context,
        gemini,
        originalSubscription,
        capture: () => captureChain,
        pauseInput() { acceptingInput = false; },
        resumeInput() { acceptingInput = true; },
        resetAudioTurn() {
          audibleInputReceived = false;
          audibleOutputReceived = false;
          lastTranslatedAudioAt = 0;
        },
        hasAudibleInput() { return audibleInputReceived; },
        async waitForAudioDrain() {
          const generation = ++audioDrainGeneration;
          const startedAt = Date.now();
          while (true) {
            if (generation !== audioDrainGeneration) return;
            if (audibleOutputReceived) {
              const quietFrom = Math.max(startedAt, lastTranslatedAudioAt);
              const remaining = drainQuietMilliseconds - (Date.now() - quietFrom);
              if (remaining <= 0) return;
              await delay(Math.min(remaining, 25));
              continue;
            }
            const remaining = firstAudioTimeoutMilliseconds - (Date.now() - startedAt);
            if (remaining <= 0) {
              throw new Error("Gemini produced no audible translation before the drain timeout");
            }
            await delay(Math.min(remaining, 25));
          }
        },
        cancelAudioDrain() { audioDrainGeneration += 1; },
      };
    } catch (error) {
      if (!setupSucceeded) {
        this.#record("gemini-setup-failed", context, {
          result: "failed",
          errorCode: "setup-failed",
        });
      }
      if (originalSubscription) {
        await settle(originalSubscription.close());
      }
      gemini?.sendActivityEnd();
      gemini?.close();
      this.#record("resources-closed", context, { result: "closed" });
      throw error;
    } finally {
      this.#startingClient = null;
    }
  }

  async phraseBoundary() {
    const active = this.#requireActive();
    active.pauseInput();
    try {
      if (!active.gemini.sendActivityEnd()) {
        throw new Error("Gemini activityEnd was not sent");
      }
      await active.waitForAudioDrain();
      await active.capture();
      if (!active.gemini.sendActivityStart()) {
        throw new Error("Gemini activityStart was not sent after the phrase boundary");
      }
      active.resetAudioTurn();
      active.resumeInput();
    } catch (error) {
      active.cancelAudioDrain();
      await settle(this.#abortActive());
      throw error;
    }
  }

  async stop() {
    const active = this.#requireActive();
    active.pauseInput();
    const sentActivityEnd = active.gemini.sendActivityEnd();
    const unsubscribe = settle(active.originalSubscription.close());
    const results = [];
    try {
      results.push(sentActivityEnd
        ? active.hasAudibleInput()
          ? await settle(active.waitForAudioDrain())
          : { status: "fulfilled", value: undefined }
        : { status: "rejected", reason: new Error("Gemini activityEnd was not sent") });
      active.cancelAudioDrain();
      results.push(await settle(active.capture()));
      results.push(await unsubscribe);
    } finally {
      active.gemini.close();
      this.#active = null;
      const playoutSucceeded = active.hasAudibleInput()
        && results.slice(0, 2).every(({ status }) => status === "fulfilled");
      this.#record(
        playoutSucceeded ? "playout-completed" : "playout-aborted",
        active.context,
        {
          result: playoutSucceeded ? "completed" : "aborted",
          ...(playoutSucceeded ? {} : { errorCode: "playout-incomplete" }),
        },
      );
      this.#record("resources-closed", active.context, { result: "closed" });
    }
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  async handoff(speaker) {
    await this.stop();
    try {
      await this.start(speaker);
    } catch (error) {
      await settle(this.abort());
      throw error;
    }
  }

  async abort() {
    this.#abortRevision += 1;
    const startPromise = this.#startPromise;
    if (this.#startingClient) this.#startingClient.close();
    if (startPromise) await settle(startPromise);
    const result = await settle(this.#abortActive());
    if (result.status === "rejected") throw result.reason;
  }

  async #abortActive() {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.pauseInput();
    active.cancelAudioDrain();
    const results = await Promise.all([
      settle(active.originalSubscription.close()),
      settle(active.capture()),
    ]);
    active.gemini.close();
    this.#record("playout-aborted", active.context, {
      result: "aborted",
      errorCode: "translation-aborted",
    });
    this.#record("resources-closed", active.context, { result: "closed" });
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  #requireActive() {
    if (!this.#active) throw new Error("translation bridge is not active");
    return this.#active;
  }

  #throwIfAborted(startRevision) {
    if (startRevision !== this.#abortRevision) {
      throw new Error("translation bridge start was aborted");
    }
  }

  #record(type, context, fields) {
    try {
      this.#eventRecorder.record({ type, ...context, ...fields });
    } catch {
      // Observability hooks cannot change translation.
    }
  }
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasAudiblePcm(pcm) {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > 100) return true;
  }
  return false;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
