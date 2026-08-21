import { Room, RoomEvent, Track } from "/vendor/livekit-client.mjs";
import { syncAudioSubscriptions } from "/src/livekit-subscriptions.mjs";

const participants = [
  { id: "ko-1", name: "민준", team: "한국팀", language: "ko", initials: "민" },
  { id: "ko-2", name: "서연", team: "한국팀", language: "ko", initials: "서" },
  { id: "ja-1", name: "Yuki", team: "日本チーム", language: "ja", initials: "Y" },
  { id: "ja-2", name: "Sora", team: "日本チーム", language: "ja", initials: "S" },
];
const languageName = { ko: "한국어", ja: "日本語" };
const modeCopy = {
  silent: "연결 대기",
  speaking: "말하는 중",
  translated: "번역 음성 청취",
  original: "원음 확인 중",
  "original-until-boundary": "다음 문장부터 번역",
  "same-language-original": "같은 언어 원음",
};

const app = document.querySelector("#app");
const audioOutput = document.querySelector("#audio-output");
let selectedParticipantId = readParticipantId();
let localParticipant = null;
let room = null;
let microphonePublication = null;
let snapshot = { activeSpeakerId: null, participants: [] };
let pollTimer = null;
let busy = false;
let statusMessage = "마이크를 켜고 회의에 입장하세요.";

function readParticipantId() {
  const candidate = new URLSearchParams(window.location.search).get("participant");
  return participants.some(({ id }) => id === candidate) ? candidate : "ko-1";
}

function participantById(id) {
  return participants.find((participant) => participant.id === id);
}

function activeParticipant() {
  return participantById(snapshot.activeSpeakerId);
}

function localAudioState() {
  return snapshot.participants.find(({ id }) => id === localParticipant?.id)?.audio ?? {
    mode: "silent",
    trackId: null,
  };
}

function render() {
  app.innerHTML = localParticipant ? renderMeeting() : renderJoin();
}

function renderJoin() {
  return `<main class="join-shell">
    <section class="join-card">
      <div class="join-brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><strong>Bridge</strong></div>
      <span class="concept-label">KR × JP LIVE INTERPRETATION</span>
      <h1>언어는 달라도,<br>회의는 같은 속도로</h1>
      <p>내 이름을 선택하고 입장하면 번역 음성을 우선해서 듣습니다. 원음은 필요할 때만 확인할 수 있습니다.</p>
      <fieldset class="participant-picker">
        <legend>내 이름 선택</legend>
        ${participants.map((participant) => `<label class="pick-person ${selectedParticipantId === participant.id ? "is-selected" : ""}">
          <input type="radio" name="participant" value="${participant.id}" ${selectedParticipantId === participant.id ? "checked" : ""}>
          ${avatar(participant)}<span><strong>${participant.name}</strong><small>${participant.team} · ${participant.language.toUpperCase()}</small></span>
        </label>`).join("")}
      </fieldset>
      <button class="join-button" type="button" data-global="join" ${busy ? "disabled" : ""}>${busy ? "연결 중…" : "마이크 켜고 입장"}</button>
      <div class="join-policy"><span><i></i> 음성·전사 기록 OFF</span><span>Session resumption은 서버 메모리에만 보관 · 재시작 시 삭제</span></div>
      <p class="status-message" aria-live="polite">${escapeHtml(statusMessage)}</p>
    </section>
    <aside class="join-visual" aria-hidden="true">
      <div class="language-orbit"><span>KO</span><i>⇄</i><span>JA</span></div>
      <strong>번역과 원음은<br>동시에 재생되지 않습니다</strong>
    </aside>
  </main>`;
}

function renderMeeting() {
  const active = activeParticipant();
  const featured = active ?? participants[2];
  const featuredState = snapshot.participants.find(({ id }) => id === featured.id)?.audio ?? { mode: "silent" };
  const target = active ? (active.language === "ko" ? "ja" : "ko") : null;
  return `${renderTopbar(active)}<main class="stage-layout">
    <section class="stage-card" aria-label="현재 발화자">
      <div class="stage-ambient"></div>
      <div class="stage-copy">
        <span class="concept-label">LIVE STAGE</span>${avatar(featured, "hero")}
        <h1>${featured.name}</h1>
        <p>${active ? `${featured.team}에서 말하고 있습니다` : "다음 발화를 기다리고 있습니다"}</p>
        <div class="translation-callout ${active ? "is-active" : ""}">
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <div><strong>${active ? `${languageName[target]}로 실시간 통역 중` : "말하면 자동으로 통역합니다"}</strong>
          <span>${active ? "번역 음성만 선명하게 들려드려요" : "원음은 필요할 때만 눌러 확인할 수 있어요"}</span></div>
        </div>
      </div>
      <div class="stage-corner-state">${trackPill(featuredState)}</div>
    </section>
    <aside class="stage-side">
      <div class="side-heading"><div><span class="concept-label">IN THE ROOM</span><h2>참가자 4명</h2></div><span class="secure-copy">기록하지 않음</span></div>
      <div class="people-list">${snapshot.participants.map((state) => participantRow(state, active)).join("")}</div>
      ${meetingControls(active)}
      <p class="status-message meeting-status" aria-live="polite">${escapeHtml(statusMessage)}</p>
    </aside>
  </main><footer class="meeting-footer"><strong>${localParticipant.name}</strong><span>${modeCopy[localAudioState().mode]} · 실제 LiveKit room</span></footer>`;
}

function renderTopbar(active) {
  return `<header class="topbar">
    <a class="brand" href="/" aria-label="Bridge 회의 홈"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><span>Bridge</span></a>
    <div class="meeting-title"><strong>한국팀 × 日本チーム</strong><span>금요일 제품 싱크 · 4명</span></div>
    <div class="meeting-health ${active ? "is-live" : ""}"><span class="live-dot"></span>${active ? "통역 중" : "준비됨"}</div>
    <button class="leave-button" type="button" data-global="leave">나가기</button>
  </header>`;
}

function participantRow(state, active) {
  const participant = participantById(state.id);
  const isMe = state.id === localParticipant.id;
  return `<article class="person-row ${active?.id === state.id ? "is-speaking" : ""} ${isMe ? "is-me" : ""}" data-participant="${state.id}">
    ${avatar(participant)}<div class="person-copy"><strong>${participant.name}${isMe ? " · 나" : ""}</strong><span>${participant.team}</span></div>
    ${trackPill(state.audio)}${isMe ? localActions(state.audio, active) : ""}
  </article>`;
}

function localActions(audio, active) {
  const canSpeak = !active || active.id === localParticipant.id;
  const talkButton = canSpeak
    ? `<button type="button" data-action="${active ? "stop-speaking" : "start-speaking"}" ${busy ? "disabled" : ""}>${active ? "발화 종료" : "말하기"}</button>`
    : "";
  const listenButton = audio.mode === "translated"
    ? `<button type="button" data-action="hold-original" ${busy ? "disabled" : ""}>원음 확인</button>`
    : audio.mode === "original"
      ? `<button type="button" data-action="release-original" ${busy ? "disabled" : ""}>번역으로 복귀</button>`
      : "";
  return `<div class="participant-actions">${talkButton}${listenButton}</div>`;
}

function meetingControls(active) {
  return `<div class="meeting-controls">
    ${active?.id === localParticipant.id ? `<button type="button" data-action="phrase-boundary" ${busy ? "disabled" : ""}>문장 경계</button>` : ""}
    <span><i></i> 번역 음성 우선</span>
  </div>`;
}

function avatar(participant, size = "normal") {
  return `<span class="avatar avatar-${participant.language} avatar-${size}" aria-hidden="true">${participant.initials}</span>`;
}

function trackPill(audio) {
  const tone = audio.translation ? "translated" : audio.original ? "original" : "silent";
  return `<span class="track-pill ${tone}"><i></i>${modeCopy[audio.mode]}</span>`;
}

async function joinMeeting() {
  busy = true;
  statusMessage = "마이크 권한과 LiveKit room을 연결하고 있습니다.";
  render();
  try {
    const join = await postJson("/api/meeting/join", { participantId: selectedParticipantId });
    room = new Room({ autoSubscribe: false, dynacast: false });
    room.on(RoomEvent.TrackPublished, syncSubscriptions);
    room.on(RoomEvent.TrackUnpublished, syncSubscriptions);
    room.on(RoomEvent.TrackSubscribed, attachSubscribedTrack);
    room.on(RoomEvent.TrackUnsubscribed, detachTrack);
    room.on(RoomEvent.Disconnected, () => {
      statusMessage = "LiveKit 연결이 종료되었습니다.";
      render();
    });
    await room.connect(join.livekitUrl, join.token, { autoSubscribe: false });
    localParticipant = join.participant;
    microphonePublication = await room.localParticipant.setMicrophoneEnabled(
      true,
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      { name: `original:${localParticipant.id}`, source: Track.Source.Microphone, dtx: false },
    );
    await microphonePublication.mute();
    await refreshState();
    pollTimer = window.setInterval(() => void refreshState(), 500);
    statusMessage = "회의에 연결되었습니다. 말하기를 누르면 통역이 시작됩니다.";
  } catch (error) {
    await disconnectRoom();
    localParticipant = null;
    statusMessage = readableError(error);
  } finally {
    busy = false;
    render();
  }
}

async function performAction(action) {
  if (!localParticipant || busy) return;
  busy = true;
  render();
  try {
    if (action === "stop-speaking") await microphonePublication.mute();
    snapshot = await postJson("/api/meeting/action", {
      participantId: localParticipant.id,
      action,
    });
    if (action === "start-speaking") {
      try {
        await microphonePublication.unmute();
      } catch (error) {
        snapshot = await postJson("/api/meeting/action", {
          participantId: localParticipant.id,
          action: "stop-speaking",
        });
        throw error;
      }
    }
    statusMessage = actionCopy(action);
    syncSubscriptions();
  } catch (error) {
    if (action === "start-speaking" || action === "phrase-boundary") {
      await microphonePublication?.mute();
    }
    statusMessage = readableError(error);
  } finally {
    busy = false;
    render();
  }
}

async function refreshState() {
  if (!room) return;
  const response = await fetch("/api/meeting", { cache: "no-store" });
  if (!response.ok) throw new Error("회의 상태를 가져오지 못했습니다.");
  snapshot = await response.json();
  syncSubscriptions();
  render();
}

function syncSubscriptions() {
  if (!room || !localParticipant) return;
  const desiredTrackId = localAudioState().trackId;
  syncAudioSubscriptions(room, desiredTrackId);
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track && publication.trackName !== desiredTrackId) {
        detachTrack(publication.track);
      }
    }
  }
}

function attachSubscribedTrack(track, publication) {
  if (track.kind !== Track.Kind.Audio || publication.trackName !== localAudioState().trackId) return;
  audioOutput.replaceChildren(track.attach());
}

function detachTrack(track) {
  for (const element of track.detach()) element.remove();
}

async function leaveMeeting() {
  if (snapshot.activeSpeakerId === localParticipant?.id) {
    await performAction("stop-speaking");
  }
  await disconnectRoom();
  localParticipant = null;
  snapshot = { activeSpeakerId: null, participants: [] };
  statusMessage = "회의에서 나왔습니다.";
  render();
}

async function disconnectRoom() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  audioOutput.replaceChildren();
  if (room) await room.disconnect();
  room = null;
  microphonePublication = null;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "요청에 실패했습니다.");
  return body;
}

function actionCopy(action) {
  return {
    "start-speaking": "마이크가 열렸습니다. 번역 음성을 만들고 있습니다.",
    "stop-speaking": "발화를 마쳤습니다.",
    "hold-original": "번역을 끄고 원음만 확인합니다.",
    "release-original": "다음 문장 경계에서 번역으로 돌아갑니다.",
    "phrase-boundary": "문장 경계를 전달했습니다.",
  }[action];
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|NotAllowed/i.test(message)) {
    return "마이크 권한이 필요합니다. 브라우저 주소창의 마이크 권한을 허용해 주세요.";
  }
  return message;
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

document.addEventListener("change", (event) => {
  const input = event.target.closest("input[name=participant]");
  if (!input) return;
  selectedParticipantId = input.value;
  const url = new URL(window.location.href);
  url.searchParams.set("participant", selectedParticipantId);
  window.history.replaceState({}, "", url);
  render();
});

document.addEventListener("click", (event) => {
  const global = event.target.closest("[data-global]");
  if (global?.dataset.global === "join") return void joinMeeting();
  if (global?.dataset.global === "leave") return void leaveMeeting();
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action) void performAction(action);
});

window.addEventListener("beforeunload", () => void disconnectRoom());
render();
