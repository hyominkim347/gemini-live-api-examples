# Understand-Anything 코드 이해 Pilot

## 목표

Understand-Anything이 Codex agent의 코드 변경 영향 질문 답변을 repository search만 사용할 때보다 더 정확하고 빠르게 만드는지 평가한다.

현재 Pilot은 Agent-only 범위다. 사람 개발자의 효용과 dashboard 사용성은 검증하지 않으며, 도구 rollout이나 표준 채택도 결정하지 않는다.

## 분석 경계

- Analysis Snapshot: `5bf36dd61b6355368d736479c5ffb528b656d544`
- tracked 코드, 문서, 테스트를 포함한다.
- ignored, untracked, secret, generated, dependency 파일은 제외한다.
- credential이나 provider를 추가하지 않고 현재 Codex model provider를 사용한다.

## Impact Benchmark 구성

Pilot 실행 전에 12개 질문과 코드·테스트 근거를 동결한다.

- direct-dependency 변경 3개
- cross-layer 변경 4개
- recovery 또는 privacy 변경 3개
- 영향이 없어야 하는 negative control 2개

모든 Evidence Answer는 영향받는 동작, 정확한 file 또는 symbol, 관련 test를 명시해야 한다. 추측 대신 `unknown`을 사용한다.

## 비교 방법

동일한 Analysis Snapshot, Codex model, time limit, 질문 집합으로 Agent Lane을 비교한다. fresh context를 사용하고 실행 순서를 교차한다.

- Agent Lane: Understand-Anything graph와 `rg` 비교

Developer Lane은 실제 프로젝트 개발자가 참여할 수 있을 때 별도로 결정할 선택적 후속 검증이다. AIN-7642는 현재 Agent-only 범위에서 취소한다. Codex는 Developer Lane을 대리하지 않으며, 이번 결과로 개발자 효용이나 dashboard 사용성을 주장하지 않는다.

## Agent Context Pass Gate 기준

Agent Lane은 다음 네 조건을 모두 충족해야 한다.

- correct answer가 12개 중 10개 이상임
- 12개 답변 모두에 evidence link가 있음
- invented file 또는 relationship이 0개임
- 답변 시간 중앙값이 25% 이상 감소함

하나라도 충족하지 못하면 Stop Rule을 적용한다. 결과를 확인한 뒤 threshold, expected answer, evidence criteria, raw result를 완화하거나 변경하지 않는다.

현재 동결 결과에서는 Stop Rule이 적용되었다. AIN-7644의 `agent-only-gate-v2` 0/12와
`agent-only-gate-v3` 5/12는 각각 exact-string 비교와 자동 의미 규칙을 사용한 historical
evidence다. 현재 `agent-only-gate-v4-frozen-manual`은 그 자동 의미 판정기를 실제 판정
경로에서 폐기했다. 동결 benchmark, raw result, threshold bytes는 바꾸지 않고 두 독립
review의 strict consensus와 `direct-02` 불일치에 대한 별도 tiebreak를 버전 관리되는
수동 판정표로 고정했다. 현재 결과는 다음과 같으며, 이 도구는 Agent Context Candidate가
아니고 rollout하지 않는다.

- correct answer: 4/12 (`direct-01`, `cross-02`, `negative-01`, `negative-02`)
- verified code/test evidence: 0/12
- invented file: 0
- invented relation: 0
- graph answer time median: 36,840.065ms
- `rg` answer time median: 33,217.775ms
- median time reduction: -10.9% (graph arm이 더 느림)
- manual adjudication table SHA-256: `135fe995bd491f8e5ff5cf9184c2153037bb59f8a7a05d5699f6cd7c7cdda786`
- manual rule SHA-256: `e205046c9a78211f03bce1ff298916ff131c5e492d1e6ed1298c1bd3bfabf9ab`
- adjudication SHA-256: `e28b0c63e52ec06bfd17ce94b0b59423eeabfd3cb3df0849464e2af7255b1e4e`

## 운영 정책

- full analysis 1회는 최대 30분이다.
- Incremental Refresh 1회는 최대 5분이다.
- Codex가 분석을 준비하고 Agent Lane을 실행한 뒤 동결된 gate를 적용한다.
- Pilot Artifact는 로컬에만 두며 commit, CI, schedule, background automation을 사용하지 않는다.
- 결과가 수용될 때까지 artifact와 timing record를 보존한다. Cleanup에는 별도의 명시적 결정이 필요하다.

Agent Lane의 calibration과 Paired Comparison provider 실행은 `macOS arm64`와 정확히
Codex `0.151.0`인 로컬 runtime을 전제로 한다. 다른 OS, architecture, Codex version에서는
호환 실행을 시도하지 않고 fail-closed로 중단한다. Unit test는 이 runtime gate를 별도로
검증하며, 지원하지 않는 플랫폼에서 실제 Codex identity 검사는 명시적으로 skip한다.

## 로컬 graph adapter

AIN-7639는 검토한 upstream source를 감싸는 fail-closed adapter로
`poc/kr-ja-meeting/scripts/understand-anything-pilot.mjs`를 사용한다. 다음 항목을 고정한다.

- Analysis Snapshot: `5bf36dd61b6355368d736479c5ffb528b656d544`
- Understand-Anything: `ba450c43425f3de6d43daf76526950ad8ca93536`
- full analysis budget: 30분
- Incremental Refresh budget: 5분

adapter는 upstream global installer를 실행하거나 skill symlink 또는 hook을 만들지 않는다.
ignored `.ua-pilot/` 디렉터리 아래에만 기록한다. `prepare`에는 검토한 로컬 upstream
checkout 또는 공식 repository URL을 전달한다. `prepare`는 새 artifact root만 허용하며,
기존 root가 비어 있더라도 다시 사용하거나 덮어쓰지 않는다. 재실행은 새 경로를 선택한다.
기존 artifact cleanup은 별도 명시적 승인이 필요하다.

AIN-7639의 기존 artifact는 과거 보존 증거(historical retained evidence)다. 그 artifact의
upstream checkout에는 tracked lock mutation이 있으므로 이를 숨기거나 수정하거나 새
calibration 또는 comparison의 input으로 재사용하지 않는다. 새 실행은 아래처럼 새로운
artifact root를 선택하고 `prepare`부터 시작한다. 기존 artifact는 결과가 수용될 때까지
그대로 보존하며 cleanup은 여전히 별도 승인 대상이다.

```bash
cd /absolute/path/to/repository/poc/kr-ja-meeting

node scripts/understand-anything-pilot.mjs prepare \
  --repo /absolute/path/to/repository \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run-NEW \
  --upstream-source /absolute/path/to/reviewed/Understand-Anything
```

생성된 sealed plan과 prompt는 반드시 budget runner로 실행한다. plan과 seal은 Codex
`0.151.0`의 native executable, wrapper, package digest로 구성된 staged runtime provenance를
고정한다. runner는 caller `PATH`의 `codex`를 실행하지 않고, 검증한 runtime을 private
`.ua-pilot` 경계에 복사해 실행 직전에 다시 검증한다. 현재 Codex provider와
`UNDERSTAND_NO_WORKTREE_REDIRECT=1`만 사용하고, dependency 설치와 core build를 고정된
artifact-local checkout으로 제한한다. full analysis는 `--full`, `--language ko`,
`--no-auto-update`를 고정한다. Incremental Refresh는 같은 sealed plan의 수동 두 번째
phase이며 automatic refresh나 background 실행을 허용하지 않는다.

budget runner는 Analysis Snapshot checkout과 Understand-Anything install root를 각각
canonical non-symlink root로 검증해 함께 감독한다. provider leader 또는 detached child가
두 root 중 어느 쪽을 working directory로 사용해도 정상 종료와 timeout 뒤 bounded cleanup을
수행한다. 이 경계는 임의의 same-user tampering에 대한 OS sandbox 주장이 아니다.

```bash
npm run pilot:run-budgeted -- \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run-NEW \
  --phase fullAnalysis

npm run pilot:run-budgeted -- \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run-NEW \
  --phase incrementalRefresh
```

upstream scanning 뒤에는 inventory가 정확히 일치해야 한다.

```bash
node scripts/understand-anything-pilot.mjs verify-scan \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run-NEW
```

`prepare`는 `run-metrics.json`과 `calibration-answer.json`을 `not-run` 상태로
초기화한다. `run-metrics.json`은 위 두 runner만 변경한다. 수동으로 status나 timing을
작성하면 verifier가 거부한다. `calibration-answer.json`에는 실제 calibration에서 관찰한
behavior, code/test evidence, graph node만 기록하며 self-report를 실행 증거로 대신하지
않는다. graph revision 누락 또는 불일치, fingerprint 누락, corpus drift, graph node로
확인되지 않는 calibration 근거, 측정되지 않은 실행, time budget 초과가 있으면 거부한다.
corpus 준비나 deterministic scan만으로는 Pilot 통과가 아니다.

```bash
node scripts/understand-anything-pilot.mjs verify-artifact \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run-NEW
```

## Agent-only 판정

판정기는 동결된 `impact-benchmark-v1` bytes의 SHA-256을
`753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6`
로, AIN-7643 raw result bytes의 SHA-256을
`6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0`로 고정한다.
정답은 tracked `benchmark/agent-only-frozen-adjudication.v1.json`의 수동 verdict만 사용한다.
이 표는 benchmark SHA, raw SHA, 12개 question ID와 순서, 각 graph-arm raw sequence,
판정·ambiguity·간결한 rationale, 두 독립 review 역할의 verdict를 함께 고정한다. 두 review가
일치해야 최종 verdict가 되며, 유일한 불일치인 `direct-02`는 기록된 tiebreak가 incorrect로
결정했고 `ambiguity: true`로 남긴다. 판정표는 frozen adjudication contract이며 raw answer,
evidence, timing을 복제하는 Pilot Artifact가 아니다.

scorer revision은 `agent-only-gate-v4-frozen-manual`, manual rule revision은
`frozen-manual-adjudication-v1`, output contract는 v3다. 코드가 판정표 SHA와 question
set/order를 직접 고정하므로 호출자가 다른 digest나 판정표를 선택할 수 없다. 임의 prose를
keyword나 자동 의미 parser로 채점하는 경로도 없다. 향후 raw 또는 benchmark는 기존 판정기로
재사용하지 않으며, 명시적인 새 benchmark/adjudication revision과 별도 review 없이
fail-closed로 거부한다.

correctness와 별도로, evidence는 grounded raw evidence가 동결된 expected code와 test 항목을
모두 포함할 때만 충족된다. `unsupported`, `unknown`, unverified, invented evidence는 evidence
gate에 유리하게 계산하지 않는다. timing과 invented file/relationship 수도 raw result에서
독립적으로 계산하며 동결 threshold를 그대로 적용한다.

```bash
# 위 graph adapter와 같은 package cwd에서 실행한다.
npm run pilot:adjudicate-agent -- \
  --raw /absolute/path/to/exact-frozen-raw-results.json \
  --output /absolute/path/to/repository/.ua-pilot/agent-only-gate/adjudication.json
```

ignored 로컬 결과는 네 조건을 모두 충족하면 `Agent Context Candidate`, 아니면
`Stop Rule`이라는 routing value 하나만 기록한다. 결정 재현에 필요한 동결 input digest,
질문별 evidence comparison, timing metric도 보존한다. 어느 값도 개발자 효용, dashboard
사용성, permanent adoption, rollout, production readiness를 뜻하지 않는다.
