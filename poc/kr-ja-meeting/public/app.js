import { MeetingSession } from "/src/meeting-session.mjs";
import { MemoryResumptionHandleStore } from "/src/gemini-session.mjs";

const participants = [
  { id: "ko-1", name: "민준", team: "한국팀", language: "ko", initials: "민" },
  { id: "ko-2", name: "서연", team: "한국팀", language: "ko", initials: "서" },
  { id: "ja-1", name: "Yuki", team: "日本チーム", language: "ja", initials: "Y" },
  { id: "ja-2", name: "Sora", team: "日本チーム", language: "ja", initials: "S" },
];
const variants = {
  A: { name: "Stage", note: "발화자와 번역 청취에 집중" },
  B: { name: "Bridge", note: "두 팀과 통역 흐름을 한눈에" },
  C: { name: "Control", note: "운영·품질 상태를 정밀하게" },
};
const languageName = { ko: "한국어", ja: "日本語" };
const modeCopy = {
  silent: "연결 대기",
  speaking: "말하는 중",
  translated: "번역 음성 청취",
  original: "원음 확인 중",
  "original-until-boundary": "다음 문장부터 번역",
  "same-language-original": "같은 언어 원음",
};

const session = new MeetingSession(participants);
const handles = new MemoryResumptionHandleStore();
const meetingId = "local-four-person-tracer";
const app = document.querySelector("#app");
const variantButtons = [...document.querySelectorAll("[data-variant]")];
let variant = readVariant();
let handleSequence = 0;
let events = ["4명 입장 완료 · 한 명이 말하면 통역이 자동으로 시작됩니다."];

function readVariant() {
  const candidate = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return candidate in variants ? candidate : "A";
}

function participantById(id) {
  return participants.find((participant) => participant.id === id);
}

function oppositeLanguage(language) {
  return language === "ko" ? "ja" : "ko";
}

function log(message) {
  events = [message, ...events].slice(0, 8);
}

function meetingState() {
  const snapshot = session.snapshot();
  const active = participantById(snapshot.activeSpeakerId);
  const overlap = snapshot.participants.some(({ audio }) => audio.original && audio.translation);
  return { snapshot, active, overlap };
}

function renderTopbar(state) {
  return `
    <header class="topbar">
      <a class="brand" href="?variant=${variant}" aria-label="Bridge 회의 홈">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i></span><span>Bridge</span>
      </a>
      <div class="meeting-title"><strong>한국팀 × 日本チーム</strong><span>금요일 제품 싱크 · 4명</span></div>
      <div class="meeting-health ${state.active ? "is-live" : ""}"><span class="live-dot"></span>${state.active ? "통역 중" : "준비됨"}</div>
      <button class="icon-button" type="button" aria-label="회의 정보">•••</button>
      <button class="leave-button" type="button" data-global="close">나가기</button>
    </header>`;
}

function avatar(participant, size = "normal") {
  return `<span class="avatar avatar-${participant.language} avatar-${size}" aria-hidden="true">${participant.initials}</span>`;
}

function trackPill(state) {
  const tone = state.audio.translation ? "translated" : state.audio.original ? "original" : "silent";
  return `<span class="track-pill ${tone}"><i></i>${modeCopy[state.audio.mode]}</span>`;
}

function participantActions(participant, state, active) {
  const canSpeak = !active || active.id === participant.id;
  const audioAction = state.audio.mode === "translated"
    ? `<button type="button" data-action="hold">원음 확인</button>`
    : state.audio.mode === "original"
      ? `<button type="button" data-action="release">번역으로 복귀</button>`
      : "";
  return `<div class="participant-actions">
    <button type="button" data-action="speak" ${canSpeak ? "" : "disabled"}>${active?.id === participant.id ? "발화 중" : "말하기"}</button>
    ${audioAction}
    <button type="button" class="icon-button compact" data-action="tone" ${state.audio.trackId ? "" : "disabled"} aria-label="현재 트랙 소리 확인">♪</button>
  </div>`;
}

function meetingControls(state) {
  return `<div class="meeting-controls">
    <button type="button" data-global="boundary" ${state.active ? "" : "disabled"}>문장 경계</button>
    <button type="button" data-global="stop" ${state.active ? "" : "disabled"}>발화 종료</button>
    <span><i></i> 번역 음성 우선</span>
  </div>`;
}

function renderStage(state) {
  const featured = state.active ?? participants[2];
  const featuredState = state.snapshot.participants.find(({ id }) => id === featured.id);
  const target = state.active ? oppositeLanguage(state.active.language) : null;
  return `<main class="stage-layout">
    <section class="stage-card" aria-label="현재 발화자">
      <div class="stage-ambient"></div>
      <div class="stage-copy">
        <span class="concept-label">A · STAGE</span>${avatar(featured, "hero")}
        <h1>${featured.name}</h1>
        <p>${state.active ? `${featured.team}에서 말하고 있습니다` : "회의가 시작되기를 기다리고 있습니다"}</p>
        <div class="translation-callout ${state.active ? "is-active" : ""}">
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <div><strong>${state.active ? `${languageName[target]}로 실시간 통역 중` : "말하면 자동으로 통역합니다"}</strong>
          <span>${state.active ? "번역 음성만 선명하게 들려드려요" : "원음은 필요할 때만 눌러 확인할 수 있어요"}</span></div>
        </div>
      </div>
      <div class="stage-corner-state">${trackPill(featuredState)}</div>
    </section>
    <aside class="stage-side">
      <div class="side-heading"><div><span class="concept-label">IN THE ROOM</span><h2>참가자 4명</h2></div><span class="secure-copy">기록하지 않음</span></div>
      <div class="people-list">
        ${state.snapshot.participants.map((item) => {
          const participant = participantById(item.id);
          return `<article class="person-row ${state.active?.id === item.id ? "is-speaking" : ""}" data-participant="${item.id}">
            ${avatar(participant)}<div class="person-copy"><strong>${participant.name}</strong><span>${participant.team}</span></div>
            ${trackPill(item)}${participantActions(participant, item, state.active)}
          </article>`;
        }).join("")}
      </div>${meetingControls(state)}
    </aside>
  </main>`;
}

function renderTeam(language, state) {
  const team = participants.filter((participant) => participant.language === language);
  return `<section class="team-column team-${language}">
    <div class="team-heading"><span class="flag-chip">${language === "ko" ? "KR" : "JP"}</span><div><span>${languageName[language]}</span><h2>${team[0].team}</h2></div></div>
    <div class="team-people">${team.map((participant) => {
      const item = state.snapshot.participants.find(({ id }) => id === participant.id);
      return `<article class="team-person ${state.active?.id === participant.id ? "is-speaking" : ""}" data-participant="${participant.id}">
        <div class="team-person-main">${avatar(participant, "large")}<div><strong>${participant.name}</strong>${trackPill(item)}</div></div>
        ${participantActions(participant, item, state.active)}
      </article>`;
    }).join("")}</div>
  </section>`;
}

function renderBridge(state) {
  const direction = state.active ? `${languageName[state.active.language]} → ${languageName[oppositeLanguage(state.active.language)]}` : "양방향 준비";
  return `<main class="bridge-layout">
    <div class="bridge-intro"><div><span class="concept-label">B · BRIDGE</span><h1>두 팀 사이의 통역 흐름</h1></div><p>누가 말하고 어느 팀이 번역을 듣는지 한 화면에서 확인합니다.</p></div>
    <div class="bridge-room">
      ${renderTeam("ko", state)}
      <section class="interpreter-core" aria-label="통역 상태">
        <span class="core-label">LIVE INTERPRETER</span><div class="language-route"><b>KO</b><span>⇄</span><b>JA</b></div>
        <strong>${direction}</strong><span>${state.active ? `${state.active.name} 발화 처리 중` : "다음 발화를 기다리는 중"}</span>
        <div class="signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><small>번역과 원음은 동시에 재생되지 않습니다</small>
      </section>
      ${renderTeam("ja", state)}
    </div>
    <section class="bridge-footer">${meetingControls(state)}<div class="event-ticker"><span>최근 상태</span><strong>${events[0]}</strong></div></section>
  </main>`;
}

function metric(label, value, tone = "") {
  return `<div class="metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderControl(state) {
  return `<main class="control-layout">
    <section class="control-main">
      <div class="control-heading"><div><span class="concept-label">C · CONTROL</span><h1>통역 운영 콘솔</h1></div><div class="quality-score"><span>통역 경로</span><strong>${state.overlap ? "점검 필요" : "정상"}</strong></div></div>
      <div class="metrics-grid">
        ${metric("활성 화자", state.active?.name ?? "없음", state.active ? "live" : "")}
        ${metric("번역 방향", state.active ? `${state.active.language.toUpperCase()} → ${oppositeLanguage(state.active.language).toUpperCase()}` : "대기")}
        ${metric("Resumption", `메모리 ${handles.size}개`)}${metric("오디오 겹침", state.overlap ? "발견" : "없음", state.overlap ? "warn" : "safe")}
      </div>
      <div class="control-people">${state.snapshot.participants.map((item) => {
        const participant = participantById(item.id);
        return `<article class="control-person ${state.active?.id === item.id ? "is-speaking" : ""}" data-participant="${item.id}">
          <div class="control-identity">${avatar(participant)}<div><strong>${participant.name}</strong><span>${participant.language.toUpperCase()} · ${participant.team}</span></div></div>
          <div class="track-detail"><span>수신 트랙</span><code>${item.audio.trackId ?? "none"}</code>${trackPill(item)}</div>
          ${participantActions(participant, item, state.active)}
        </article>`;
      }).join("")}</div>${meetingControls(state)}
    </section>
    <aside class="control-side">
      <div class="policy-card"><span class="concept-label">DATA BOUNDARY</span><h2>회의 데이터</h2><ul>
        <li><span>Session resumption</span><strong>ON</strong></li><li><span>Handle 보관</span><strong>탭 메모리</strong></li>
        <li><span>전사·File API·cache</span><strong>OFF</strong></li><li><span>음성 기록</span><strong>OFF</strong></li>
      </ul></div>
      <div class="event-panel"><div class="event-heading"><span class="concept-label">EVENTS</span><strong>실시간 상태</strong></div>
        <ol>${events.map((event, index) => `<li><time>${index === 0 ? "NOW" : `-${index}`}</time><span>${event}</span></li>`).join("")}</ol>
      </div>
    </aside>
  </main>`;
}

function render() {
  const state = meetingState();
  const view = variant === "A" ? renderStage(state) : variant === "B" ? renderBridge(state) : renderControl(state);
  document.body.dataset.variant = variant;
  document.title = `Bridge · ${variants[variant].name}`;
  app.innerHTML = `${renderTopbar(state)}${view}<footer class="prototype-note"><strong>${variant}안 · ${variants[variant].name}</strong><span>${variants[variant].note}</span><em>비교용 prototype · 실제 회의 연결 없음</em></footer>`;
  for (const button of variantButtons) {
    const selected = button.dataset.variant === variant;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-current", selected ? "true" : "false");
  }
}

function setVariant(nextVariant) {
  if (!(nextVariant in variants)) return;
  variant = nextVariant;
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  window.history.replaceState({}, "", url);
  render();
}

function performParticipantAction(button, container) {
  const participantId = container.dataset.participant;
  const participant = participantById(participantId);
  try {
    if (button.dataset.action === "speak") {
      session.startSpeaking(participantId);
      const targetLanguage = oppositeLanguage(participant.language);
      handles.set(meetingId, targetLanguage, `local-opaque-${++handleSequence}`);
      log(`${participant.name} 발화 시작 · ${languageName[targetLanguage]} 번역 활성화`);
    } else if (button.dataset.action === "hold") {
      session.holdOriginal(participantId);
      log(`${participant.name} · 번역을 끄고 원음 확인`);
    } else if (button.dataset.action === "release") {
      session.releaseOriginal(participantId);
      log(`${participant.name} · 다음 문장부터 번역 복귀 예약`);
    } else if (button.dataset.action === "tone") {
      playTrackTone(session.audioPlanFor(participantId));
    }
  } catch (error) {
    log(`차단: ${error.message}`);
  }
}

function performGlobalAction(action) {
  if (action === "boundary") {
    session.phraseBoundary();
    log("문장 경계 도착 · 예약된 참가자가 번역으로 복귀");
  } else if (action === "stop") {
    const active = participantById(session.activeSpeakerId);
    session.stopSpeaking();
    log(`${active?.name ?? "화자"} 발화 종료 · 다음 발화 대기`);
  } else if (action === "close") {
    if (session.activeSpeakerId) session.stopSpeaking();
    handles.clearMeeting(meetingId);
    log("회의 종료 · resumption handle을 메모리에서 폐기");
  }
}

document.addEventListener("click", (event) => {
  const variantButton = event.target.closest("button[data-variant]");
  if (variantButton) return setVariant(variantButton.dataset.variant);
  const participantAction = event.target.closest("[data-action]");
  const participantContainer = event.target.closest("[data-participant]");
  if (participantAction && participantContainer) {
    performParticipantAction(participantAction, participantContainer);
    return render();
  }
  const globalAction = event.target.closest("[data-global]");
  if (globalAction) {
    performGlobalAction(globalAction.dataset.global);
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const order = Object.keys(variants);
  const step = event.key === "ArrowRight" ? 1 : -1;
  setVariant(order[(order.indexOf(variant) + step + order.length) % order.length]);
});

window.addEventListener("popstate", () => {
  variant = readVariant();
  render();
});

function playTrackTone(plan) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = plan.translation ? 660 : 330;
  gain.gain.setValueAtTime(0.06, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.25);
}

render();
