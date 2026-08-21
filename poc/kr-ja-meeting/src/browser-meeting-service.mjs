import { MeetingSession } from "./meeting-session.mjs";

export class BrowserMeetingService {
  #participants;
  #participantById;
  #roomName;
  #livekitUrl;
  #tokenIssuer;
  #translationBridge;
  #session;
  #actionChain = Promise.resolve();

  constructor({ participants, roomName, livekitUrl, tokenIssuer, translationBridge }) {
    if (!roomName || !livekitUrl || !tokenIssuer || !translationBridge) {
      throw new Error("roomName, livekitUrl, tokenIssuer, and translationBridge are required");
    }
    this.#participants = participants.map((participant) => ({ ...participant }));
    this.#participantById = new Map(
      this.#participants.map((participant) => [participant.id, participant]),
    );
    this.#roomName = roomName;
    this.#livekitUrl = livekitUrl;
    this.#tokenIssuer = tokenIssuer;
    this.#translationBridge = translationBridge;
    this.#session = new MeetingSession(this.#participants);
  }

  async join(participantId) {
    const participant = this.#requireParticipant(participantId);
    return {
      livekitUrl: this.#livekitUrl,
      roomName: this.#roomName,
      token: await this.#tokenIssuer(participant),
      participant: { ...participant },
    };
  }

  snapshot() {
    return this.#session.snapshot();
  }

  action(participantId, action) {
    const execution = this.#actionChain.then(() => this.#performAction(participantId, action));
    this.#actionChain = execution.catch(() => {});
    return execution;
  }

  async #performAction(participantId, action) {
    const participant = this.#requireParticipant(participantId);
    if (action === "start-speaking") {
      if (this.#session.activeSpeakerId === participantId) return this.snapshot();
      this.#session.startSpeaking(participantId);
      try {
        await this.#translationBridge.start(participant);
      } catch (error) {
        this.#session.stopSpeaking(participantId);
        throw error;
      }
    } else if (action === "stop-speaking") {
      this.#requireActiveSpeaker(participantId);
      try {
        await this.#translationBridge.stop();
      } finally {
        this.#session.stopSpeaking(participantId);
      }
    } else if (action === "hold-original") {
      this.#session.holdOriginal(participantId);
    } else if (action === "release-original") {
      this.#session.releaseOriginal(participantId);
    } else if (action === "phrase-boundary") {
      this.#requireActiveSpeaker(participantId);
      try {
        await this.#translationBridge.phraseBoundary();
        this.#session.phraseBoundary();
      } catch (error) {
        this.#session.stopSpeaking(participantId);
        throw error;
      }
    } else {
      throw new Error(`unsupported meeting action: ${action}`);
    }
    return this.snapshot();
  }

  #requireParticipant(participantId) {
    const participant = this.#participantById.get(participantId);
    if (!participant) throw new Error(`unknown participant: ${participantId}`);
    return participant;
  }

  #requireActiveSpeaker(participantId) {
    if (this.#session.activeSpeakerId !== participantId) {
      throw new Error(`${participantId} is not the active speaker`);
    }
  }
}
