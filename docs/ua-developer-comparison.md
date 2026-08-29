# Understand-Anything Developer Lane Paired Comparison handoff

AIN-7642의 `Developer Lane`은 실제 프로젝트 개발자 한 명이 동결된 12개
`Impact Question`을 Understand-Anything dashboard와 `rg`로 각각 답하는
`Paired Comparison`이다. 이 문서는 `Pilot Operator`가 로컬 실행 surface를 준비한 뒤
답을 쓰지 않고 개발자에게 넘기는 절차를 고정한다.

이 runner의 구현과 테스트는 실제 개발자 실행을 대체하지 않는다. 프로젝트 개발자의
신원·독립 작성 attestation과 24개 raw answer가 없으면 AIN-7642는 완료가 아니다.

## 고정 조건

- Analysis Snapshot:
  `5bf36dd61b6355368d736479c5ffb528b656d544`
- Understand-Anything reviewed commit:
  `ba450c43425f3de6d43daf76526950ad8ca93536`
- benchmark: `impact-benchmark-v1`의 동결된 12문항
- 순서: 홀수 문항은 `understandAnything` 다음 `repositorySearch`, 짝수 문항은
  `repositorySearch` 다음 `understandAnything`
- 각 arm은 새 terminal/browser/notes context에서 시작한다.
- `show`부터 `record`까지 시간을 같은 방식으로 runner가 계산한다.
- 결과를 본 뒤 benchmark 질문, expected answer, scorer, threshold를 바꾸지 않는다.
- 이 단계는 24개 raw result만 고정한다. `correct`, `inventedFiles`,
  `inventedRelations`, score, pass/fail은 기록하거나 판정하지 않는다.

runner가 읽는 frozen benchmark와 scorer는 전체 digest로 봉인되지만 개발자 출력에는
prompt-only projection만 나온다. 실행 중 developer는 benchmark 원본, scorer,
`records/`, 이전 answer file을 열지 않는다. `Pilot Operator`도 answer를 작성하거나
수정하지 않는다.

## 1. Pilot Operator가 handoff 준비

아래 명령은 저장소 루트에서 실행한다. `<PILOT_ARTIFACT_ROOT>`는 AIN-7639의
`pilot-plan.json`이 있는 ignored 로컬 디렉터리다. `<SESSION_ROOT>`는 그 하위의 아직
존재하지 않는 디렉터리여야 한다.

12개 prompt를 보기 전에 두 arm에 공통 적용할 분 단위 제한을 사전 승인한다. Source
Spec에는 숫자가 정해져 있지 않으므로 runner가 임의 default를 만들지 않는다.
`<ARM_TIME_LIMIT_MINUTES>`에는 승인된 동일 값을 넣는다.

```bash
node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs prepare \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT> \
  --time-limit-minutes <ARM_TIME_LIMIT_MINUTES>
```

`prepare`는 다음 파일만 session에 만든다.

- `prompt-projection.json`: 12개 질문의 `ordinal`, `id`, `prompt`만 포함
- `operator-attestation-template.json`: 실제 개발자가 직접 완성할 선언
- `answer-template.json`: score나 client-provided timing이 없는 raw answer 형식
- `session.json`: 24-arm crossed order와 frozen control digest
- `session.json`의 `timeLimitMilliseconds`: 두 tool arm에 동일한 사전 승인 제한
- `records/`: 실행 뒤 raw records가 들어갈 로컬 디렉터리

session은 Pilot Artifact 아래에만 만들 수 있고, Pilot Artifact 자체가 source
repository에서 ignored인지 runner가 확인한다. commit, CI, network provider, production
권한, 새 credential은 사용하지 않는다.

여기까지 수행한 `Pilot Operator`는 `status: awaiting-operator-attestation`에서 멈추고
실제 프로젝트 개발자에게 다음 절차를 넘긴다.

## 2. 실제 프로젝트 개발자가 attestation 작성

개발자는 template을 새 input 파일로 복사한다. `operator.id`, `displayName`을 본인 정보로
채우고, 다섯 선언을 직접 확인한 뒤 모두 `true`로 바꾼다. `projectRole`은
`project-developer`를 유지한다.

```bash
cp <SESSION_ROOT>/operator-attestation-template.json \
  <SESSION_ROOT>/operator-attestation.input.json

node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs attest \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT> \
  --attestation-file <SESSION_ROOT>/operator-attestation.input.json
```

runner는 다음 사전 commitment를 모두 명시적으로 확인하지 않으면 시작을 거부한다.

- 실제 프로젝트 개발자임
- 24개 답을 operator 본인이 작성할 것임
- expected answer를 보지 않을 것임
- 각 arm을 fresh context에서 시작할 것임
- 이전 arm 답을 다음 arm에서 재사용하지 않을 것임

이것은 operator의 self-attestation을 보존하는 운영 기록이다. runner가 사람의 신원을
자동으로 증명한다는 뜻은 아니다.

## 3. 24개 arm 독립 실행

각 arm마다 아래 여섯 단계를 반복한다.

1. 이전 terminal, dashboard tab, answer editor, notes를 닫는다.
2. 새 context를 열고 아래 `show`를 실행한다.
3. 출력의 `tool.kind`가 `understand-anything-dashboard-only`이면 출력된 dashboard
   `command`만 사용한다. `repository-search-only`이면 출력된 Analysis Snapshot
   `workingDirectory`에서 `rg`만 사용한다.
4. `answer-template.json`을 `answer.input.json`으로 복사해 developer가 직접 작성한다.
   완료 시 `armAttestation.toolUsed`가 `show`의 arm과 같은지 확인하고
   `answerAuthoredByOperator`, `freshContextUsed`를 직접 `true`로 바꾼다.
5. `record`로 제출한다. runner는 raw record를 보존한 뒤 input을 빈 template으로
   즉시 되돌려 다음 context에 이전 답이 남지 않게 한다.
6. `status`로 다음 arm identity만 확인한 뒤 현재 context를 닫는다.

dashboard `command`는 clean secondary terminal에서 foreground로 유지하고 출력된 local
token URL만 연다. 해당 arm의 `record`가 끝나면 `Ctrl-C`로 종료하고 browser tab과 두
terminal을 모두 닫는다. `rg` arm에서는 dashboard를 열지 않는다.

```bash
node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs show \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT> \
  --fresh-context true

cp <SESSION_ROOT>/answer-template.json <SESSION_ROOT>/answer.input.json

node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs record \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT> \
  --answer-file <SESSION_ROOT>/answer.input.json

node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs status \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT>
```

known answer의 `evidence.code`와 `evidence.tests`는 scorer가 나중에 판정할 raw string이다.
실제 snapshot의 상대 경로와 symbol/test fragment를 `path#fragment`로 기록한다.

```json
{
  "answer": "영향받는 실제 동작과 관계를 설명한다.",
  "unknown": false,
  "evidence": {
    "code": ["poc/kr-ja-meeting/src/example.mjs#actualSymbol"],
    "tests": ["poc/kr-ja-meeting/test/example.test.mjs#actual test name"]
  },
  "armAttestation": {
    "answerAuthoredByOperator": true,
    "freshContextUsed": true,
    "toolUsed": "understandAnything"
  }
}
```

근거가 부족하면 추측하지 않고 canonical unknown을 기록한다.

```json
{
  "answer": "unknown",
  "unknown": true,
  "evidence": {
    "code": [],
    "tests": []
  },
  "armAttestation": {
    "answerAuthoredByOperator": true,
    "freshContextUsed": true,
    "toolUsed": "repositorySearch"
  }
}
```

`answerTimeMs`, `correct`, `expectedAnswer`, `inventedFiles`,
`inventedRelations`, score, threshold를 input에 넣으면 runner가 거부한다. 존재 여부나
관계 정확성을 실행 중에 runner가 교정하지 않는 이유는 hallucination 결과를 숨기지 않고
raw 그대로 다음 판정 단계로 넘기기 위해서다.

`record`는 현재 schedule과 다른 `toolUsed`를 거부하고, post-arm authorship 및
fresh-context 선언을 completion timestamp와 함께 raw record에 고정한다. 이는 실제
developer의 per-arm self-attestation을 보존한다. runner가 terminal/browser 사용을
기술적으로 감시하거나 사람의 행동을 자동 증명한다는 뜻은 아니다.

`show`는 모든 arm에 같은 `timeLimitMilliseconds`와 `deadlineAt`을 출력한다. 제한을
넘겨 `record`하면 늦게 작성한 내용은 결과 이점으로 인정하지 않고 canonical unknown과
`timeLimitExceeded: true`를 raw record에 남긴다. 실제 elapsed time은 그대로 보존한다.

## 4. 24개 raw result 고정

24번째 `record` 뒤 실제 개발자가 아래 명령을 실행한다.

```bash
node poc/kr-ja-meeting/scripts/ua-developer-comparison.mjs verify \
  --artifact-root <PILOT_ARTIFACT_ROOT> \
  --session-root <SESSION_ROOT>
```

`verify`는 다음만 검사한다.

- 24개 file의 identity와 crossed order가 정확함
- 각 질문에 두 arm이 한 번씩 있음
- 모든 record가 operator id와 fresh-context attestation을 가짐
- 모든 record가 scheduled arm과 같은 tool-use 및 answer-authorship post-attestation을 가짐
- `answerTimeMs`가 `show`와 `record` timestamp에서 계산된 값임
- 모든 arm이 동일한 사전 승인 time limit을 사용하고 timeout이 fail-closed 처리됨
- prepare 이후 benchmark, expected answer, threshold, scorer control이 바뀌지 않음
- raw record schema가 score나 pass/fail을 포함하지 않음

성공하면 `paired-comparison-raw.json`과
`developer-comparison-verification.json`을 같은 ignored session에 남긴다. 이 raw
artifact는 다음 독립 판정 단계가 사용하며, 여기서는 pass/fail을 선언하지 않는다.
결과가 수용될 때까지 보존하고 cleanup은 별도 승인을 받는다.
