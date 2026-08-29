import { buildGeminiSetup } from "./gemini-session.mjs";

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiLiveTranslateSocket {
  #apiKey;
  #meetingId;
  #targetLanguage;
  #handleStore;
  #socketFactory;
  #openState;
  #onTranslatedAudio;
  #onSetupComplete;
  #onGenerationComplete;
  #onTurnComplete;
  #onResumptionHandle;
  #onError;
  #onClose;
  #onServerEvent;
  #automaticActivityDetection;
  #eventRecorder;
  #participantId;
  #utteranceId;
  #socket = null;
  #setupComplete = false;
  #resumptionRetryUsed = false;
  #resumptionRetryPending = false;

  constructor({
    apiKey,
    meetingId,
    targetLanguage,
    handleStore,
    socketFactory,
    openState = 1,
    onTranslatedAudio,
    onSetupComplete,
    onGenerationComplete,
    onTurnComplete,
    onResumptionHandle,
    onError,
    onClose,
    onServerEvent,
    automaticActivityDetection = true,
    eventRecorder = { record() {} },
    participantId,
    utteranceId,
  }) {
    if (!apiKey || !meetingId || !handleStore || !socketFactory) {
      throw new Error("apiKey, meetingId, handleStore, and socketFactory are required");
    }
    this.#apiKey = apiKey;
    this.#meetingId = meetingId;
    this.#targetLanguage = targetLanguage;
    this.#handleStore = handleStore;
    this.#socketFactory = socketFactory;
    this.#openState = openState;
    this.#onTranslatedAudio = onTranslatedAudio ?? (() => {});
    this.#onSetupComplete = onSetupComplete ?? (() => {});
    this.#onGenerationComplete = onGenerationComplete ?? (() => {});
    this.#onTurnComplete = onTurnComplete ?? (() => {});
    this.#onResumptionHandle = onResumptionHandle ?? (() => {});
    this.#onError = onError ?? (() => {});
    this.#onClose = onClose ?? (() => {});
    this.#onServerEvent = onServerEvent ?? (() => {});
    this.#automaticActivityDetection = automaticActivityDetection;
    if (!eventRecorder || typeof eventRecorder.record !== "function") {
      throw new Error("eventRecorder.record must be a function");
    }
    this.#eventRecorder = eventRecorder;
    this.#participantId = participantId;
    this.#utteranceId = utteranceId;
  }

  connect() {
    if (this.#socket) {
      throw new Error("Gemini socket is already connected");
    }
    this.#resumptionRetryUsed = false;
    this.#resumptionRetryPending = false;
    return this.#connectSocket();
  }

  #connectSocket() {
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.#apiKey)}`;
    const socket = this.#socketFactory(url);
    this.#socket = socket;
    let resumptionHandle = null;
    this.#listen(socket, "open", () => {
      if (this.#socket !== socket) return;
      resumptionHandle = this.#handleStore.get(
        this.#meetingId,
        this.#targetLanguage,
      );
      socket.send(
        JSON.stringify(
          buildGeminiSetup({
            targetLanguage: this.#targetLanguage,
            resumptionHandle,
            automaticActivityDetection: this.#automaticActivityDetection,
          }),
        ),
      );
    });
    this.#listen(socket, "message", (data) => {
      if (this.#socket === socket) this.#handleMessage(data);
    });
    this.#listen(socket, "error", (error) => {
      if (this.#socket === socket) this.#onError(error);
    });
    this.#listen(socket, "close", (code, reason) => {
      if (this.#socket !== socket) return;
      const setupComplete = this.#setupComplete;
      this.#socket = null;
      this.#setupComplete = false;
      if (
        !setupComplete &&
        resumptionHandle &&
        !this.#resumptionRetryUsed &&
        isMissingResumptionSession(code, reason)
      ) {
        this.#resumptionRetryUsed = true;
        this.#resumptionRetryPending = true;
        this.#handleStore.delete(this.#meetingId, this.#targetLanguage);
        this.#recordResumptionRetry("started");
        this.#connectSocket();
        return;
      }
      if (!setupComplete && this.#resumptionRetryPending) {
        this.#resumptionRetryPending = false;
        this.#recordResumptionRetry(
          "failed",
          isMissingResumptionSession(code, reason)
            ? "session-not-found"
            : "setup-closed",
        );
      }
      this.#onClose();
    });
    return socket;
  }

  sendPcm16(buffer, sampleRate = 48000) {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.#socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${sampleRate}`,
            data: bytes.toString("base64"),
          },
        },
      }),
    );
    return true;
  }

  sendAudioStreamEnd() {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    this.#socket.send(
      JSON.stringify({ realtimeInput: { audioStreamEnd: true } }),
    );
    return true;
  }

  sendActivityStart() {
    return this.#sendRealtimeSignal("activityStart");
  }

  sendActivityEnd() {
    return this.#sendRealtimeSignal("activityEnd");
  }

  close() {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    this.#setupComplete = false;
    socket.close();
    this.#onClose();
  }

  #handleMessage(data) {
    const payload = typeof data === "string" ? data : data.toString();
    const message = JSON.parse(payload);
    const serverEvent = {};
    if (message.setupComplete) serverEvent.setupComplete = true;
    if (message.sessionResumptionUpdate) serverEvent.resumptionUpdate = true;
    if (message.serverContent?.modelTurn?.parts?.some((part) => part.inlineData?.data)) {
      serverEvent.modelAudio = true;
    }
    if (message.serverContent?.generationComplete) {
      serverEvent.generationComplete = true;
    }
    if (message.serverContent?.turnComplete) serverEvent.turnComplete = true;
    if (message.serverContent?.interrupted) serverEvent.interrupted = true;
    if (message.goAway) serverEvent.goAway = true;
    if (Object.keys(serverEvent).length > 0) this.#onServerEvent(serverEvent);
    if (message.setupComplete) {
      this.#setupComplete = true;
      if (this.#resumptionRetryPending) {
        this.#resumptionRetryPending = false;
        this.#recordResumptionRetry("succeeded");
      }
      this.#onSetupComplete();
    }

    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.#handleStore.set(
        this.#meetingId,
        this.#targetLanguage,
        update.newHandle,
      );
      this.#onResumptionHandle();
    }

    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.#onTranslatedAudio(part.inlineData.data);
      }
    }
    if (message.serverContent?.generationComplete) {
      this.#onGenerationComplete();
    }
    if (message.serverContent?.turnComplete) {
      this.#onTurnComplete();
    }
  }

  #listen(socket, event, handler) {
    if (typeof socket.on === "function") {
      socket.on(event, handler);
      return;
    }
    socket.addEventListener(event, (message) => {
      if (event === "message") return handler(message.data);
      if (event === "close") return handler(message.code, message.reason);
      return handler(message);
    });
  }

  #sendRealtimeSignal(name) {
    if (
      !this.#socket ||
      this.#socket.readyState !== this.#openState ||
      !this.#setupComplete
    ) {
      return false;
    }
    this.#socket.send(JSON.stringify({ realtimeInput: { [name]: {} } }));
    return true;
  }

  #recordResumptionRetry(outcome, errorCode) {
    try {
      this.#onServerEvent({
        type: "resumption-retry",
        outcome,
        meetingId: this.#meetingId,
        targetLanguage: this.#targetLanguage,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Diagnostics must not control session recovery.
    }
    try {
      this.#eventRecorder.record({
        type: `gemini-retry-${outcome}`,
        participantId: this.#participantId,
        utteranceId: this.#utteranceId,
        language: this.#targetLanguage,
        result: outcome,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Diagnostics must not control session recovery.
    }
  }
}

function isMissingResumptionSession(code, reason) {
  return (
    code === 1008 &&
    String(reason ?? "").includes("BidiGenerateContent session not found")
  );
}
