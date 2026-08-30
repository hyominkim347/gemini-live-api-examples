# Agent Lane Paired Comparison raw result

AIN-7643은 동결된 12문항 Impact Benchmark를 두 번 실행한다. 한 번은 고정된
Understand-Anything graph를 사용하고, 한 번은 `rg`를 통한 repository search를
사용한다. 이 Agent Lane Paired Comparison은 24개 raw answer만 기록한다. 정답 여부를
평가하거나 Agent Context Pass Gate를 적용하거나 threshold를 변경하지 않는다.

## 격리 contract

`prepare`는 ignored output directory 아래에 정제된 local-only material root 두 개를
만든다.

- `materials/graph`에는 고정된 `knowledge-graph.json`만 있다.
- `materials/rg`에는 Analysis Corpus manifest에 나열된 파일만 있다.

output path는 `.ua-pilot` 디렉터리를 포함하고 모든 Git checkout 밖에 있어야 한다.
benchmark answer key, scorer, 이전 answer, Analysis Corpus 밖의 파일은 두 root 어디에도
없다. 각 invocation은 질문 하나와 해당 arm의 material만 받는다. 모든 invocation은 현재
OpenAI Codex provider와 `codex exec --ephemeral --ignore-user-config
--skip-git-repo-check`를 사용한다. 실제 read boundary는
`default_permissions="ua_pilot_material_only"` profile로 material root의 `read`만 허용하고
network, approval, inherited shell environment를 차단한다. resume, fork, local provider,
alternate provider profile은 사용하지 않는다. Provider 실행 전제는 `macOS arm64`와
정확히 Codex `0.151.0`이며, 다른 runtime은 fail-closed다.

실행 전에 순서를 고정한다. 홀수 질문은 graph를 먼저, 짝수 질문은 `rg`를 먼저 실행한다.
두 arm은 같은 timeout을 사용한다.

## 동결된 과거 결과 검증

현재 Stop Rule의 근거인 AIN-7643 결과는 modern seal을 도입하기 전에 생성된 historical
retained evidence다. 기존 AIN-7639 artifact나 per-run 파일을 고쳐 modern 형식으로
가장하지 않는다. 대신 다음 명령은 `raw-comparison-seal.json`이 없는 경우에도 정확한
frozen raw SHA
`6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0`, benchmark SHA
`753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6`, 그리고 동결된
snapshot/provider/order/timeout/24-run metadata를 모두 검증한다. 이
`frozen-digest-provenance-v1` 경로는 read-only이며 raw나 retained artifact를 다시 쓰지
않는다. digest가 다른 임의 legacy artifact는 seal 부재를 이유로 허용하지 않고 거부한다.

```bash
node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs verify \
  --output-dir /private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison
```

## 새 실행

기존 AIN-7639 historical retained evidence는 새 calibration이나 comparison의 input으로
재사용하지 않는다. 먼저 graph adapter runbook의 `prepare`부터 새로운 artifact root를
만들고 full analysis, Incremental Refresh, inventory와 artifact verification을 끝낸다.
그 검증된 새 경로를 `<NEW_PILOT_ARTIFACT_ROOT>`로 사용하고 comparison output도 새 경로를
선택한다.

```bash
node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs prepare \
  --pilot-artifact-root <NEW_PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison-new/.ua-pilot/agent-lane-comparison \
  --timeout-ms 600000

node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs run \
  --pilot-artifact-root <NEW_PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison-new/.ua-pilot/agent-lane-comparison

node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs verify \
  --pilot-artifact-root <NEW_PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison-new/.ua-pilot/agent-lane-comparison
```

`run`은 scheduled invocation마다 디렉터리 하나를 기록한다. 완료된
`raw-result.json`은 중단 후 재사용할 수 있지만 이전 result를 다음 provider context에
포함하지 않는다. Modern sealed output의 `verify`는 provider answer, execution timing,
pinned snapshot, corpus manifest, graph로 모든 raw record를 다시 만든다. 위 historical
output의 `verify`는 frozen digest와 known metadata만 검증하며 modern 재생성을 주장하지
않는다.

## Raw evidence 기록

각 `raw-result.json`은 다음을 기록한다.

- final answer와 `unknown`
- 인용한 code path와 symbol
- 인용한 test path와 test name
- graph arm이 사용한 graph relation
- pinned artifact를 기준으로 탐지한 invented file과 relation
- 확인하지 못한 source/test evidence
- millisecond 단위 provider invocation timing

`raw-results.json`은 동결된 order와 timeout을 포함해 24개 record를 모은다. 의도적으로
`correct`, `pass`, failure threshold, median, comparison metric을 포함하지 않는다. raw
Pilot Artifact는 ignored 상태로 유지하며 commit하지 않는다. raw result 생성과 판정은
서로 분리한다. 현재 Agent-only 판정은 이 동결 raw artifact에 Agent Context Pass Gate를
적용했고 Stop Rule을 기록했으므로 rollout하지 않는다.
