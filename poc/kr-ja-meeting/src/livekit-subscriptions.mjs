import { publicationName } from "./provider-canary.mjs";

export function syncAudioSubscriptions(room, desiredTrackId) {
  if (!room?.remoteParticipants) {
    throw new Error("a connected LiveKit room is required");
  }

  const subscribed = [];
  const unsubscribed = [];
  const audioPublications = [];

  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind !== "audio") {
        continue;
      }
      audioPublications.push(publication);
    }
  }

  const matches = audioPublications.filter(
    (publication) => publicationName(publication) === desiredTrackId,
  );
  if (matches.length > 1) {
    throw new Error(`audio plan matched multiple tracks: ${desiredTrackId}`);
  }

  for (const publication of audioPublications) {
    const name = publicationName(publication);
    const shouldSubscribe = name === desiredTrackId;
    publication.setSubscribed(shouldSubscribe);
    (shouldSubscribe ? subscribed : unsubscribed).push(name);
  }

  return { subscribed, unsubscribed };
}
