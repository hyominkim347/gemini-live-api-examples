import { performance } from "node:perf_hooks";

export class LiveTranslationBridge {
  #meetingId;
  #audioGateway;
  #geminiFactory;
  #drainQuietMilliseconds;
  #firstAudioTimeoutMilliseconds;
  #continuousInput;
  #preRollMilliseconds;
  #clock;
  #eventRecorder;
  #preparedInputs = new Map();
  #active = null;
  #startingClient = null;
  #startPromise = null;
  #abortRevision = 0;

  constructor({
    meetingId,
    audioGateway,
    geminiFactory,
    drainQuietMilliseconds = 1_500,
    firstAudioTimeoutMilliseconds = 5_000,
    continuousInput = false,
    preRollMilliseconds = 1_000,
    clock = () => performance.now(),
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
    this.#continuousInput = continuousInput;
    if (!Number.isFinite(preRollMilliseconds) || preRollMilliseconds <= 0) {
      throw new Error("preRollMilliseconds must be a positive number");
    }
    this.#preRollMilliseconds = preRollMilliseconds;
    if (typeof clock !== "function") throw new Error("translation bridge clock is required");
    this.#clock = clock;
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#eventRecorder = eventRecorder;
  }

  async prepare(speaker) {
    const existing = this.#preparedInputs.get(speaker.id);
    if (existing) {
      if (existing.language !== speaker.language) {
        throw new Error("prepared speaker language cannot change");
      }
      await existing.ready;
      return;
    }

    const prepared = createPreparedInput(speaker, this.#preRollMilliseconds);
    this.#preparedInputs.set(speaker.id, prepared);
    prepared.ready = this.#audioGateway.subscribeOriginal(
      `original:${speaker.id}`,
      (pcm, sampleRate) => prepared.receive(pcm, sampleRate),
    ).then((subscription) => {
      prepared.subscription = subscription;
    });
    try {
      await prepared.ready;
    } catch (error) {
      if (this.#preparedInputs.get(speaker.id) === prepared) {
        this.#preparedInputs.delete(speaker.id);
      }
      throw error;
    }
  }

  async release(participantId) {
    if (this.#active?.context.participantId === participantId) {
      throw new Error("cannot release the active translation input");
    }
    const prepared = this.#preparedInputs.get(participantId);
    if (!prepared) return;
    this.#preparedInputs.delete(participantId);
    await settle(prepared.ready);
    await prepared.subscription?.close();
    prepared.clear();
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
    const alreadyPrepared = this.#preparedInputs.has(speaker.id);
    let preparedInput;
    let captureChain = Promise.resolve();
    let lastTranslatedAudioAt = 0;
    let audibleOutputReceived = false;
    let audibleInputReceived = false;
    let acceptingInput = true;
    let acceptingOutput = true;
    let outputGeneration = 0;
    let inputRecorded = false;
    let outputRecorded = false;
    let outputCompleted = false;
    let setupSucceeded = false;
    let audioDrainGeneration = 0;
    const drainQuietMilliseconds = this.#drainQuietMilliseconds;
    const firstAudioTimeoutMilliseconds = this.#firstAudioTimeoutMilliseconds;
    const context = {
      participantId: speaker.id,
      utteranceId,
      language: speaker.language,
      targetLanguage,
    };
    this.#record("gemini-setup-started", context, { result: "started" });
    try {
      this.#record("livekit-subscribe-started", context, { result: "started" });
      try {
        await this.prepare(speaker);
        this.#record("livekit-subscribe-succeeded", context, { result: "succeeded" });
      } catch (error) {
        this.#record("livekit-subscribe-failed", context, {
          result: "failed",
          errorCode: "original-subscription-failed",
        });
        throw error;
      }
      preparedInput = this.#preparedInputs.get(speaker.id);
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
        onGenerationComplete() { outputCompleted = true; },
        onTurnComplete() { outputCompleted = true; },
        onClose() { setup.reject(new Error("Gemini closed during setup")); },
        onError: setup.reject,
        onTranslatedAudio: (base64Audio) => {
          if (!acceptingOutput) return Promise.resolve();
          const generation = outputGeneration;
          const pcm = Buffer.from(base64Audio, "base64");
          if (hasAudiblePcm(pcm)) {
            audibleOutputReceived = true;
            lastTranslatedAudioAt = Date.now();
            if (!outputRecorded) {
              outputRecorded = true;
              this.#record("gemini-output-received", context, { result: "received" });
            }
          }
          captureChain = captureChain.then(async () => {
            if (!acceptingOutput || generation !== outputGeneration) return;
            const capture = await sink.capture(pcm);
            if (!acceptingOutput || generation !== outputGeneration) return;
            if (Number.isFinite(capture?.queuedAfterMs)) {
              this.#record("livekit-queue-updated", context, {
                queueDurationMs: capture.queuedAfterMs,
                result: "queued",
              });
            }
          });
          return captureChain;
        },
      });
      this.#startingClient = gemini;

      gemini.connect();
      await withTimeout(setup.promise, "Gemini setup", 20_000);
      this.#record("gemini-setup-succeeded", context, { result: "succeeded" });
      setupSucceeded = true;
      this.#throwIfAborted(startRevision);
      if (!this.#continuousInput && !gemini.sendActivityStart()) {
        throw new Error("Gemini activityStart was not sent");
      }
      this.#record("gemini-input-started", context, { result: "started" });

      const sendInput = (pcm, sampleRate) => {
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
      };
      preparedInput.forwardTo(sendInput);
      this.#throwIfAborted(startRevision);
      this.#active = {
        context,
        gemini,
        preparedInput,
        capture: () => captureChain,
        waitForPlayout: typeof sink.waitForPlayout === "function"
          ? () => sink.waitForPlayout()
          : async () => {},
        pauseInput() { acceptingInput = false; },
        resumeInput() { acceptingInput = true; },
        detachInput() { preparedInput.bufferInstead(); },
        interruptOutput() {
          acceptingOutput = false;
          outputGeneration += 1;
          if (typeof sink.clearQueue !== "function") {
            throw new Error("translation sink clearQueue is required for handoff");
          }
          sink.clearQueue();
          return typeof sink.queuedDurationMs === "function" ? sink.queuedDurationMs() : 0;
        },
        resetAudioTurn() {
          audibleInputReceived = false;
          audibleOutputReceived = false;
          outputCompleted = false;
          lastTranslatedAudioAt = 0;
        },
        hasAudibleInput() { return audibleInputReceived; },
        async waitForAudioDrain() {
          const generation = ++audioDrainGeneration;
          const startedAt = Date.now();
          while (true) {
            if (generation !== audioDrainGeneration) return;
            if (audibleOutputReceived) {
              if (outputCompleted) return;
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
      if (preparedInput) preparedInput.bufferInstead();
      if (gemini) {
        if (this.#continuousInput) gemini.sendAudioStreamEnd();
        else gemini.sendActivityEnd();
      }
      gemini?.close();
      if (!alreadyPrepared) await settle(this.release(speaker.id));
      this.#record("resources-closed", context, { result: "closed" });
      throw error;
    } finally {
      this.#startingClient = null;
    }
  }

  async phraseBoundary() {
    const active = this.#requireActive();
    if (this.#continuousInput) {
      if (active.hasAudibleInput()) await active.waitForAudioDrain();
      await active.capture();
      active.resetAudioTurn();
      return;
    }
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

  resume(speaker, { utteranceId } = {}) {
    const active = this.#requireActive();
    if (
      active.context.participantId !== speaker.id
      || active.context.language !== speaker.language
    ) {
      throw new Error("translation bridge can only resume the parked speaker");
    }
    active.context.utteranceId = utteranceId;
    active.resetAudioTurn();
    this.#record("gemini-input-started", active.context, { result: "resumed" });
  }

  async stop({ releasePrepared = true } = {}) {
    const active = this.#requireActive();
    active.pauseInput();
    active.detachInput();
    const sentInputEnd = this.#continuousInput
      ? active.gemini.sendAudioStreamEnd()
      : active.gemini.sendActivityEnd();
    const results = [];
    let geminiClosed = false;
    const closeGemini = () => {
      if (geminiClosed) return;
      geminiClosed = true;
      active.gemini.close();
    };
    try {
      results.push(sentInputEnd
        ? active.hasAudibleInput()
          ? await settle(active.waitForAudioDrain())
          : { status: "fulfilled", value: undefined }
        : { status: "rejected", reason: new Error(
          this.#continuousInput
            ? "Gemini audioStreamEnd was not sent"
            : "Gemini activityEnd was not sent",
        ) });
      active.cancelAudioDrain();
      closeGemini();
      results.push(await settle(active.capture()));
      results.push(await settle(active.waitForPlayout()));
    } finally {
      closeGemini();
      this.#active = null;
      const outputSucceeded = active.hasAudibleInput()
        && results.slice(0, 3).every(({ status }) => status === "fulfilled");
      this.#record(
        outputSucceeded ? "gemini-output-completed" : "gemini-output-aborted",
        active.context,
        {
          result: outputSucceeded ? "completed" : "aborted",
          ...(outputSucceeded ? {} : { errorCode: "translation-output-incomplete" }),
        },
      );
      this.#record("resources-closed", active.context, { result: "closed" });
    }
    if (releasePrepared) results.push(await settle(this.release(active.context.participantId)));
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }

  async handoff(speaker, { utteranceId } = {}) {
    const active = this.#requireActive();
    const interruptedAt = this.#clock();
    this.#active = null;
    active.pauseInput();
    active.detachInput();
    active.cancelAudioDrain();
    const queueDurationMs = active.interruptOutput();
    active.gemini.close();
    const interruptionMilliseconds = Math.max(0, this.#clock() - interruptedAt);
    this.#record("translation-interrupted", active.context, {
      relatedParticipantId: speaker.id,
      interruptionMilliseconds,
      queueDurationMs,
      result: "interrupted",
    });
    this.#record("gemini-output-aborted", active.context, {
      result: "aborted",
      errorCode: "translation-interrupted",
    });
    this.#record("resources-closed", active.context, { result: "interrupted" });
    try {
      await this.start(speaker, { utteranceId });
    } catch (error) {
      await settle(this.abort());
      throw error;
    }
    return { interruptionMilliseconds };
  }

  async abort() {
    this.#abortRevision += 1;
    const startPromise = this.#startPromise;
    if (this.#startingClient) this.#startingClient.close();
    if (startPromise) await settle(startPromise);
    const result = await settle(this.#abortActive());
    const releases = await Promise.all(
      [...this.#preparedInputs.keys()].map((participantId) => settle(this.release(participantId))),
    );
    if (result.status === "rejected") throw result.reason;
    const failedRelease = releases.find(({ status }) => status === "rejected");
    if (failedRelease) throw failedRelease.reason;
  }

  async #abortActive() {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.pauseInput();
    active.detachInput();
    active.cancelAudioDrain();
    const results = await Promise.all([settle(active.capture())]);
    active.gemini.close();
    this.#record("gemini-output-aborted", active.context, {
      result: "aborted",
      errorCode: "translation-aborted",
    });
    this.#record("resources-closed", active.context, { result: "closed" });
    results.push(await settle(this.release(active.context.participantId)));
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

function createPreparedInput(speaker, preRollMilliseconds) {
  let frames = [];
  let bufferedMilliseconds = 0;
  let forward = null;

  return {
    language: speaker.language,
    ready: Promise.resolve(),
    subscription: null,
    receive(pcm, sampleRate) {
      if (forward) return forward(pcm, sampleRate);
      const bytes = Buffer.isBuffer(pcm) ? Buffer.from(pcm) : Buffer.from(pcm);
      const durationMilliseconds = bytes.byteLength / 2 / sampleRate * 1_000;
      frames.push({ pcm: bytes, sampleRate, durationMilliseconds });
      bufferedMilliseconds += durationMilliseconds;
      while (frames.length > 0 && bufferedMilliseconds > preRollMilliseconds) {
        bufferedMilliseconds -= frames.shift().durationMilliseconds;
      }
    },
    forwardTo(onFrame) {
      const buffered = frames;
      frames = [];
      bufferedMilliseconds = 0;
      forward = onFrame;
      for (const frame of buffered) onFrame(frame.pcm, frame.sampleRate);
    },
    bufferInstead() {
      forward = null;
    },
    clear() {
      frames = [];
      bufferedMilliseconds = 0;
      forward = null;
    },
  };
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
