# Understand-Anything Developer Lane 비채점 calibration

## 현재 상태

현재 Adoption Pilot은 Agent-only다. 이 문서는 실제 프로젝트 개발자가 참여할 수 있을
때 수행할 선택적 후속 calibration 절차를 보존한다. 현재 Agent Context Pass Gate나 Stop
Rule 판정에는 사용하지 않으며, 기존 smoke 실행도 개발자 효용 또는 dashboard 사용성
근거가 아니다.

AIN-7640은 AIN-7639가 만든 고정 `Pilot Artifact`를 실제 프로젝트 개발자가 로컬에서
탐색하고, scored Developer Lane 전에 비채점 calibration 질문 하나에 `Evidence Answer`를
남기는 흐름이다. 이 도구는 제품 runtime, production 권한, provider credential을
사용하지 않는다.

## 전제 조건

- `Pilot Artifact`의 Analysis Snapshot은
  `5bf36dd61b6355368d736479c5ffb528b656d544`여야 한다.
- Understand-Anything upstream은 검토한
  `ba450c43425f3de6d43daf76526950ad8ca93536` checkout이어야 한다.
- `artifact-verification.json`은 `passed: true`여야 한다.
- 현재 snapshot checkout HEAD가 Analysis Snapshot과 같고 tracked change가 없어야 한다.
- 현재 upstream checkout HEAD가 reviewed commit과 같고 dashboard/core source가
  변경되지 않아야 한다.
- AIN-7639에서 artifact-local dashboard 의존성을 설치한 checkout을 재사용한다.
  이 lane은 `npx`, global installer, symlink 생성, auto-update를 실행하지 않는다.

아래 명령은 저장소 루트에서 실행한다. `<PILOT_ARTIFACT_ROOT>`는 AIN-7639의
`pilot-plan.json`이 있는 로컬 디렉터리다. session 디렉터리는 반드시 그 하위에 새로
만든다. `begin`은 기존 session을 덮어쓰지 않는다.

## 1. 질문과 타이머 시작

```bash
node poc/kr-ja-meeting/scripts/ua-developer-lane.mjs begin \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <PILOT_ARTIFACT_ROOT>/developer-lane-calibration
```

`begin`은 다음 항목을 함께 보여준다.

- 비채점 calibration 질문 한 개
- `ui`, `application-api`, `realtime-integration`, `meeting-domain` 주요 layer
- `server.mjs`에서 번역 bridge, Gemini socket, LiveKit gateway로 이어지는 `imports`
- 번역 bridge에서 회귀 테스트로 이어지는 `tested_by`

질문을 출력할 때 `startedAtMilliseconds`를 로컬 session에 기록한다. 기존 Pilot
Artifact의 `calibration-answer.json`이나 scored benchmark는 읽거나 복사하지 않는다.

## 2. 로컬 dashboard 탐색

별도 터미널에서 다음 명령을 실행한다.

```bash
node poc/kr-ja-meeting/scripts/ua-developer-lane.mjs dashboard \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --port 5173
```

도구는 pinned upstream checkout 안의 Vite binary만 실행한다. dashboard는
`127.0.0.1`에만 bind되고, upstream이 출력한 일회성 `?token=...` URL로 연다. 터미널은
foreground로 유지한다. 탐색이 끝나면 `Ctrl-C`로 종료한다.

먼저 네 주요 layer를 오가며 `server.mjs`가 실시간 번역 구성 요소를 어떻게 조립하는지
본다. 이어서 `live-translation-bridge.mjs`의 class/symbol node와 `tested_by` edge를 따라
관련 테스트를 연다. dashboard 파일 endpoint는 고정 snapshot checkout 밖의 파일을
열지 않는다.

launcher는 `PATH`, 임시 디렉터리, locale/terminal 값만 child process에 전달한다.
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` 등 provider credential은 전달하지
않는다.

## 3. Evidence Answer 작성

`begin`이 생성한 `answer-template.json`을 같은 session 디렉터리 안의 새 파일로 복사해
작성한다. `answerTimeMs`, `correct`, score, benchmark revision은 입력하지 않는다.

```json
{
  "answer": "관찰한 동작을 설명한다.",
  "unknown": false,
  "evidence": {
    "behavior": "영향받는 runtime 동작을 한 문장으로 적는다.",
    "code": [
      {
        "path": "poc/kr-ja-meeting/src/example.mjs",
        "symbol": "actualSymbol"
      }
    ],
    "tests": [
      {
        "path": "poc/kr-ja-meeting/test/example.test.mjs",
        "test": "actual test name fragment"
      }
    ]
  }
}
```

`submit`은 code/test path가 고정 corpus와 graph에 실제로 있는지 검사한다. `symbol`은
immutable Git blob에 선언된 identifier여야 하고, test name은 실제 `test()`/`it()`
선언이어야 한다. 선택한 code file에서 test file로 `tested_by` graph edge도 있어야 한다.
하나라도 확인되지 않으면 결과를 쓰지 않고 실패한다.

근거가 부족하면 추측하지 않고 다음 canonical unknown만 사용한다.

```json
{
  "answer": "unknown",
  "unknown": true,
  "evidence": {
    "behavior": "unknown",
    "code": [],
    "tests": []
  }
}
```

unknown에 추측성 답변이나 evidence를 섞으면 제출이 거부된다. unknown은 정직한 운영
결과이지, Evidence Answer가 확인됐다는 뜻은 아니다.

## 4. 제출과 검증

```bash
node poc/kr-ja-meeting/scripts/ua-developer-lane.mjs submit \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <PILOT_ARTIFACT_ROOT>/developer-lane-calibration \
  --answer-file <PILOT_ARTIFACT_ROOT>/developer-lane-calibration/developer-answer.json

node poc/kr-ja-meeting/scripts/ua-developer-lane.mjs verify \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <PILOT_ARTIFACT_ROOT>/developer-lane-calibration
```

`submit`이 질문 표시 시점부터 최종 제출까지의 양의 millisecond를 도구 내부에서 계산해
`calibration-result.json`의 `answerTimeMs`에 기록한다. 결과는 `lane: "developer"`,
`runKind: "unscored-calibration"`, `scored: false`를 포함하고 `correct`나 expected answer를
포함하지 않는다. 한 session에는 한 번만 제출할 수 있다.

`verify`는 pin, graph, 결과 identity, answer time, evidence를 다시 검사하고
`developer-lane-verification.json`을 남긴다. 모든 결과 파일은 Pilot Artifact 안의 로컬
session에만 남으며 Git commit 대상이 아니다.

## 채점 benchmark 경계

이 lane에서 scored 12문항이나 frozen expected answers를 열거나 출력하거나 실행하지
않는다. 12문항 Developer Lane은 실제 프로젝트 개발자가 독립적으로 수행하도록 별도
승인해야 하는 후속 작업이다. AIN-7642는 현재 Agent-only Pilot에서 canceled다.
AIN-7640 구현·smoke 결과를 개발자 실행이나 점수로 대리해서는 안 된다.
