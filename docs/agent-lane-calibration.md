# Agent Lane 비채점 calibration

AIN-7641은 12문항 Paired Comparison 전에 비채점 Agent Lane calibration 1개를
추가한다. AIN-7639가 생성한 고정 로컬 graph를 재사용하며 Impact Benchmark 실행을
생성하거나 읽거나 채점하지 않는다.

## 실행

AIN-7639 Pilot Artifact를 read-only input으로 사용하고 이번 실행의 출력은 ignored 로컬
디렉터리 아래에 둔다.

```bash
node poc/kr-ja-meeting/scripts/agent-lane-calibration.mjs run \
  --pilot-artifact-root .ua-pilot/pilot-run \
  --output-dir .ua-pilot/agent-lane-calibration
```

명령은 pilot plan과 graph가 고정 Analysis Snapshot 및
`current-codex-provider-only`를 가리키는지 확인한다. 그 뒤 다음 옵션으로 `codex exec`를
시작한다.

- fresh context를 위한 `--ephemeral`
- alternate provider profile 선택을 막는 `--ignore-user-config`
- Analysis Snapshot에 대한 `--sandbox read-only`
- 비채점 calibration 질문만 포함한 output schema

timer는 provider invocation 직전에 시작하고 schema를 준수한 final answer가 기록되면
멈춘다. `calibration-execution.json`에는 경과 millisecond와 fresh-context mechanism을
기록한다.

## Evidence Answer 정책

답변한 calibration은 다음을 명시해야 한다.

- 영향받는 behavior
- 실제 Analysis Corpus code path와 symbol
- 실제 관련 test path와 test name
- 답변 근거로 사용한 graph node ID
- `knowledge-graph.json`에 정확히 존재하는 graph relation만

존재하지 않는 file, graph node, relation을 인용하면 verifier가 실패한다. 기존 근거로
symbol, test, behavior를 확인하기 부족하면 추측을 받지 않고 `unknown`을 반환한다.
명시적인 `unknown` 답변은 behavior 또는 evidence를 주장하지 않는다.

## 로컬 출력

output directory에는 다음 파일이 있다.

- `calibration-protocol.json`
- `calibration-prompt.md`
- `evidence-answer.schema.json`
- `raw-answer.json`
- `calibration-answer.json`
- `calibration-verification.json`
- `calibration-execution.json`

이 파일들은 Pilot Artifact다. 로컬 untracked 상태로 유지한다. 채점 대상인 12문항 Agent
Lane과 expected answer는 이 흐름 밖의 AIN-7643에 속한다.
