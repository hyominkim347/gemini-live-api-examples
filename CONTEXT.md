# 코드 이해 Pilot 용어집

이 문서는 한일 실시간 통역 서비스에서 Understand-Anything을 AI 에이전트용 개발 도구로 평가할 때 사용하는 용어를 정의한다.

## 용어

**Analysis Snapshot**:
Pilot이 평가하는 서비스 모듈, 문서, 테스트를 포함한 고정 통합 revision이다.
_피해야 할 표현_: Entire codebase, current branch, latest code

**Adoption Pilot**:
Understand-Anything을 표준 개발 도구로 도입하기 전에 AI 에이전트 문맥 제공 가치와 운영 비용을 측정하는 제한된 평가다. 현재 범위는 Agent-only이며 사람 개발자 효용을 평가하지 않는다.
_피해야 할 표현_: Rollout, permanent adoption, production integration

**Impact Question**:
제안된 코드 변경이 어떤 서비스 동작, 모듈, 테스트에 영향을 줄 수 있는지 묻는 질문이다. Pilot의 핵심 사용자 결과다.
_피해야 할 표현_: Architecture question, code search query

**Analysis Corpus**:
Analysis Snapshot에서 가져온 tracked 코드, 문서, 테스트다. ignored, untracked, secret, generated, dependency 파일은 제외한다.
_피해야 할 표현_: Repository, all files, workspace

**Analysis Provider**:
Adoption Pilot에서 Analysis Corpus를 처리하도록 승인된 현재 Codex model provider다. Pilot은 새 model provider나 credential을 추가하지 않는다.
_피해야 할 표현_: Local viewer, default model

**Impact Benchmark**:
실제 서비스 변경에서 도출한 12개 Impact Question의 동결된 집합이다. 각 질문은 expected answer를 확정하는 코드 및 테스트 근거와 연결된다.
_피해야 할 표현_: Demo questions, exploratory prompts, cherry-picked examples

**Agent Context Pass Gate**:
Understand-Anything을 AI 에이전트 문맥 후보로 유지하기 위한 Agent Lane 최소 기준이다. Impact Benchmark 정답이 12개 중 10개 이상이고, 12개 모두 검증된 코드 및 테스트 근거가 있으며, invented file 또는 relation이 없고, repository search를 사용한 Codex 대비 답변 시간 중앙값이 25% 이상 감소해야 한다.
_피해야 할 표현_: Looks useful, graph generated successfully, subjective improvement

**Pilot Artifact**:
로컬 평가만을 위해 Analysis Corpus에서 생성한 Understand-Anything 데이터다. Pilot Artifact는 commit하거나 CI에 올리거나 공유 프로젝트 문서로 취급하지 않는다.
_피해야 할 표현_: Project documentation, source artifact, shared cache

**Incremental Refresh**:
고정 Analysis Snapshot을 의도적으로 갱신할 때 최초 full analysis 이후 변경 파일만 다시 분석하는 절차다.
_피해야 할 표현_: Continuous indexing, background sync, automatic rollout

**Benchmark Mix**:
Impact Benchmark의 구성이다. direct-dependency 3개, cross-layer 4개, recovery 또는 privacy 3개, 영향이 없어야 하는 negative control 2개로 이루어진다.
_피해야 할 표현_: Representative sample, broad coverage, random questions

**Paired Comparison**:
동일한 Analysis Snapshot, Codex model, time limit 아래에서 fresh context와 교차 실행 순서를 사용해 Understand-Anything 사용 답변과 repository-search-only 답변을 비교하는 방식이다.
_피해야 할 표현_: Before-and-after demo, informal comparison

**Developer Lane**:
실제 프로젝트 개발자가 Understand-Anything dashboard 또는 `rg`를 사용해 Impact Benchmark에 답하는 선택적 후속 Paired Comparison이다. 현재 Agent-only pilot 범위 밖이며 Codex가 대신할 수 없다. AIN-7642는 현재 범위에서 취소되었고 개발자가 참여할 수 있을 때 별도 후속 검증으로 다시 결정한다.
_피해야 할 표현_: Human review, usability test, 현재 Pilot의 필수 gate

**Agent Lane**:
Codex agent가 code graph 또는 `rg`를 사용해 Impact Benchmark에 답하는 Paired Comparison이다.
_피해야 할 표현_: Automated test, agent demo

**Agent Context Candidate**:
Agent Lane이 Agent Context Pass Gate를 통과한 도구다. Candidate 상태는 개발자 효용이나 dashboard 사용성을 뜻하지 않으며 rollout을 승인하거나 도구를 프로젝트 표준으로 만들지 않는다.
_피해야 할 표현_: Adoption Candidate, adopted tool, approved integration, production-ready

**Stop Rule**:
Agent Lane이 Agent Context Pass Gate를 충족하지 못하면 Agent-only pilot을 종료한다. 결과를 확인한 뒤 threshold, expected answer, evidence criteria, raw result를 완화하거나 조정하지 않는다.
_피해야 할 표현_: Iterate until green, best-effort pass, conditional success

**Analysis Budget**:
Analysis Snapshot의 full analysis는 최대 30분, Incremental Refresh는 최대 5분까지 허용한다. 어느 제한이든 넘으면 해당 실행을 중단한다.
_피해야 할 표현_: Best effort, unlimited initialization, background processing

**Evidence Answer**:
영향받는 동작, 정확한 file 또는 symbol, 관련 test 근거를 명시한 Impact Benchmark 답변이다. 확인되지 않은 영향은 추측하지 않고 `unknown`으로 기록한다.
_피해야 할 표현_: Graph summary, likely impact, unsupported answer

**Pilot Operator**:
분석을 준비하고 Agent Lane을 실행한 뒤 동결된 Agent Context Pass Gate를 적용하는 Codex coordinator다. 이 역할은 프로젝트 개발자를 대신하지 않으며 CI, schedule, background automation을 활성화하지 않는다.
_피해야 할 표현_: CI job, team rollout, autonomous monitor

**Artifact Retention**:
Pilot 결과가 수용될 때까지 Pilot Artifact와 timing record를 로컬에 보존한다. Cleanup에는 별도의 명시적 결정이 필요하다.
_피해야 할 표현_: Automatic cleanup, permanent archive, committed history
