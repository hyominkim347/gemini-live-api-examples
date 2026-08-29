# 한국어 ↔ 일본어 자연 대화 회의 tracer

Google의 [Live Translate LiveKit 예제](https://github.com/google-gemini/gemini-live-translate-livekit)가 사용하는 두 핵심 seam을 한국어·일본어 동적 회의에 맞춰 최소화한 로컬 PoC입니다.

- Gemini Live: `translationConfig`로 언어별 음성 번역, `sessionResumption` ON
- LiveKit: `autoSubscribe: false`에서 계산된 오디오 트랙 하나만 `setSubscribed()`
- 참가 경험: 이름과 언어로 입장하고 일반 회의처럼 마이크만 켜고 끔
- 발화 경험: 마이크가 켜진 무음 상태를 유지할 수 있고, VAD가 발화 시작과 끝을 자동 전달
- 현재 통역 규칙: 한 번에 한 사람의 자동 감지 발화를 통역하며 겹침 정책은 후속 범위
- 데이터 경계: resumption handle은 메모리에만 두고 회의 종료 시 폐기
- 미사용: File API, explicit cache, Grounding, 입력·출력 전사, 애플리케이션 음성 로그

## 로컬 tracer 실행

```bash
cd poc/kr-ja-meeting
npm test
npm run dev
```

브라우저에서 `http://127.0.0.1:4173`을 열고 다음 순서로 확인합니다.

1. 표시 이름과 `ko` 또는 `ja`를 선택해 입장합니다.
2. roster에 서버가 생성한 참가자 ID의 사용자가 추가되는지 확인합니다.
3. `마이크 켜기` 후 말하지 않아도 `마이크 켜짐` 상태가 유지되는지 확인합니다.
4. 말하면 자동으로 통역 상태가 시작되고 침묵 뒤 자동 종료되는지 확인합니다.
5. 화면에 `말하기`, `발화 종료`, `문장 경계` 버튼이 없는지 확인합니다.
6. `나가기` 후 roster와 마이크 자원이 정리되는지 확인합니다.

실제 Chrome의 동적 입장·마이크 계약은 서버 실행 중 다음 명령으로 확인할 수 있습니다.

```bash
npm run canary:natural-conversation
```

`트랙 소리`는 선택된 트랙이 하나임을 청각적으로 구분하는 로컬 tone입니다. 실제 Gemini 번역 음질이나 지연을 흉내 내지 않습니다.

## 실제 provider canary

로컬 LiveKit 개발 서버가 `ws://127.0.0.1:7880`에서 실행 중이고, Git에서 제외된 `.env.local`에 `GEMINI_API_KEY`가 있을 때 실행합니다.

```bash
npm install
npm run canary:provider
```

이 canary는 네 명의 회의 참가자와 번역 bot을 실제 LiveKit room에 연결합니다. 합성 일본어 음성을 `original:ja-1`로 게시하고, bot이 Gemini Live Translate의 한국어 PCM을 `translation:ko`로 다시 게시합니다. 한국어 청취자는 번역 트랙 하나만 구독하며, 원음 확인 중에는 번역을 끄고 입력 측의 명시적 Gemini `activityEnd` 발화 경계에서 번역으로 돌아갑니다. 첫 세션의 resumption handle은 메모리에만 보관하고 두 번째 Gemini 연결 setup에 재사용합니다. 성공 출력에는 key, handle, 음성, 전사 내용이 포함되지 않습니다.

## 실제 어댑터 연결

- `src/gemini-live-socket.mjs`는 공식 `BidiGenerateContent` WebSocket 메시지 형태로 setup, PCM 입력, 번역 PCM 출력, resumption handle 갱신을 구현합니다. API key는 생성자 주입만 허용하며 파일에 쓰지 않습니다.
- `src/livekit-subscriptions.mjs`는 LiveKit `Room`의 remote audio publications에 대해 계산된 트랙 하나만 구독합니다.
- `src/meeting-session.mjs`가 동적 roster, 마이크와 발화 상태, 현재 한 명의 통역 발화를 관리하는 단일 상태 원본입니다.
- `src/speech-activity-detector.mjs`는 음량 관측을 자동 `speech-start`·`speech-end` event로 바꾸는 교체 가능한 경계입니다.

Egress, Cloud Run 배포, Gemini 프로젝트 설정 변경은 이 PoC 범위에 포함하지 않습니다.
