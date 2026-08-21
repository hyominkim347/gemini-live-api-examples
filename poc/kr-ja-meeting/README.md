# 한국어 ↔ 일본어 4명 회의 tracer

Google의 [Live Translate LiveKit 예제](https://github.com/google-gemini/gemini-live-translate-livekit)가 사용하는 두 핵심 seam을 2명 한국어 + 2명 일본어 회의에 맞춰 최소화한 로컬 PoC입니다.

- Gemini Live: `translationConfig`로 언어별 음성 번역, `sessionResumption` ON
- LiveKit: `autoSubscribe: false`에서 계산된 오디오 트랙 하나만 `setSubscribed()`
- 참가 경험: 외국어 발화는 번역만, 원음 확인 중에는 원음만, 놓은 뒤 다음 발화 경계에서 번역 복귀
- 회의 규칙: 한 번에 한 명만 발언
- 데이터 경계: resumption handle은 메모리에만 두고 회의 종료 시 폐기
- 미사용: File API, explicit cache, Grounding, 입력·출력 전사, 애플리케이션 음성 로그

## 로컬 tracer 실행

```bash
cd poc/kr-ja-meeting
npm test
npm run dev
```

브라우저에서 `http://127.0.0.1:4173`을 열고 다음 순서로 확인합니다.

1. 일본 참가자의 `말하기`를 누릅니다.
2. 한국 참가자가 `translation:ko`만 듣는지 확인합니다.
3. 해당 한국 참가자의 `원음 확인`을 눌러 `original:<speaker>`만 남는지 확인합니다.
4. `원음 놓기` 후에도 원음이 유지되는지 확인합니다.
5. `다음 발화 경계`에서 `translation:ko`로 복귀하는지 확인합니다.
6. 다른 참가자의 `말하기`가 활성 화자 종료 전에는 비활성인지 확인합니다.
7. `회의 종료` 후 resumption handle이 메모리 0개가 되는지 확인합니다.

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
- `src/meeting-session.mjs`가 4명과 한 명 발언, 번역/원음 전환 규칙의 단일 상태 원본입니다.

Egress, Cloud Run 배포, Gemini 프로젝트 설정 변경은 이 PoC 범위에 포함하지 않습니다.
