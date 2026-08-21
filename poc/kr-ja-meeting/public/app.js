import { MeetingSession } from "/src/meeting-session.mjs";
import { MemoryResumptionHandleStore } from "/src/gemini-session.mjs";

const participants = [
  { id: "ko-1", name: "한국 1", language: "ko" },
  { id: "ko-2", name: "한국 2", language: "ko" },
  { id: "ja-1", name: "日本 1", language: "ja" },
  { id: "ja-2", name: "日本 2", language: "ja" },
];
const languageName = { ko: "한국어", ja: "日本語" };
const modeCopy = {
  silent: "대기",
  speaking: "말하는 중",
  translated: "번역만 청취",
  original: "원음만 확인",
  "original-until-boundary": "다음 경계까지 원음",
  "same-language-original": "같은 언어 원음",
};

const session = new MeetingSession(participants);
const handles = new MemoryResumptionHandleStore();
const meetingId = "local-four-person-tracer";
let handleSequence = 0;

const participantRoot = document.querySelector("#participants");
const eventLog = document.querySelector("#event-log");
const phraseBoundaryButton = document.querySelector("#phrase-boundary");
const stopButton = document.querySelector("#stop-speaking");

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  eventLog.prepend(item);
}

function render() {
  const snapshot = session.snapshot();
  const active = participants.find(({ id }) => id === snapshot.activeSpeakerId);
  document.querySelector("#active-speaker").textContent = active?.name ?? "없음";
  document.querySelector("#translation-direction").textContent = active
    ? `${languageName[active.language]} → ${languageName[active.language === "ko" ? "ja" : "ko"]}`
    : "대기";
  document.querySelector("#handle-status").textContent = `메모리 ${handles.size}개`;
  document.querySelector("#overlap-status").textContent = snapshot.participants.some(
    ({ audio }) => audio.original && audio.translation,
  ) ? "발견" : "없음";
  phraseBoundaryButton.disabled = !active;
  stopButton.disabled = !active;

  participantRoot.replaceChildren(
    ...snapshot.participants.map((participant) => {
      const card = document.createElement("article");
      card.className = `participant-card ${participant.id === snapshot.activeSpeakerId ? "active" : ""}`;
      card.dataset.participant = participant.id;
      card.innerHTML = `
        <div class="participant-head">
          <span class="language-badge">${participant.language.toUpperCase()}</span>
          <strong>${participant.name}</strong>
        </div>
        <div class="track-state ${participant.audio.translation ? "translated" : participant.audio.original ? "original" : "silent"}">
          <span>${modeCopy[participant.audio.mode]}</span>
          <code>${participant.audio.trackId ?? "no audio track"}</code>
        </div>
        <div class="card-controls">
          <button data-action="speak" ${active && active.id !== participant.id ? "disabled" : ""}>말하기</button>
          <button data-action="hold" ${participant.audio.mode !== "translated" ? "disabled" : ""}>원음 확인</button>
          <button data-action="release" ${participant.audio.mode !== "original" ? "disabled" : ""}>원음 놓기</button>
          <button data-action="tone" ${!participant.audio.trackId ? "disabled" : ""}>트랙 소리</button>
        </div>`;
      return card;
    }),
  );
}

participantRoot.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const card = event.target.closest("[data-participant]");
  if (!button || !card) return;
  const participantId = card.dataset.participant;
  const participant = participants.find(({ id }) => id === participantId);
  try {
    if (button.dataset.action === "speak") {
      session.startSpeaking(participantId);
      const targetLanguage = participant.language === "ko" ? "ja" : "ko";
      handles.set(meetingId, targetLanguage, `local-opaque-${++handleSequence}`);
      log(`${participant.name} 발화 시작 · ${languageName[targetLanguage]} 번역 트랙 활성화`);
    } else if (button.dataset.action === "hold") {
      session.holdOriginal(participantId);
      log(`${participant.name} · 번역 OFF, 원음 ON`);
    } else if (button.dataset.action === "release") {
      session.releaseOriginal(participantId);
      log(`${participant.name} · 다음 발화 경계에서 번역 복귀 예약`);
    } else if (button.dataset.action === "tone") {
      playTrackTone(session.audioPlanFor(participantId));
    }
  } catch (error) {
    log(`차단: ${error.message}`);
  }
  render();
});

phraseBoundaryButton.addEventListener("click", () => {
  session.phraseBoundary();
  log("발화 경계 도착 · 예약된 청취자를 번역 트랙으로 복귀");
  render();
});

stopButton.addEventListener("click", () => {
  const active = session.activeSpeakerId;
  session.stopSpeaking();
  log(`${active} 발화 종료 · 모든 청취 트랙 대기`);
  render();
});

document.querySelector("#close-meeting").addEventListener("click", () => {
  if (session.activeSpeakerId) session.stopSpeaking();
  handles.clearMeeting(meetingId);
  log("회의 종료 · resumption handle 메모리에서 폐기");
  render();
});

function playTrackTone(plan) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = plan.translation ? 660 : 330;
  gain.gain.setValueAtTime(0.08, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.35);
}

log("4명 입장 완료 · 한 명 발언 대기");
render();
