# Code Understanding Pilot

This context defines the language used to evaluate Understand-Anything as a development tool for the Korean-Japanese live interpretation service.

## Language

**Analysis Snapshot**:
A pinned integrated service revision that contains the service modules, documentation, and tests evaluated by the pilot.
_Avoid_: Entire codebase, current branch, latest code

**Adoption Pilot**:
A bounded evaluation that measures the value and operating cost of Understand-Anything before it becomes a standard development tool.
_Avoid_: Rollout, permanent adoption, production integration

**Impact Question**:
A question asking which service behavior, modules, and tests may be affected by a proposed code change. It is the pilot's primary user outcome.
_Avoid_: Architecture question, code search query

**Analysis Corpus**:
The tracked code, documentation, and tests taken from the Analysis Snapshot. Ignored, untracked, secret, generated, and dependency files are outside the corpus.
_Avoid_: Repository, all files, workspace

**Analysis Provider**:
The current Codex model provider approved to process the Analysis Corpus during the Adoption Pilot. The pilot introduces no new model provider or credential.
_Avoid_: Local viewer, default model

**Impact Benchmark**:
A frozen set of twelve Impact Questions derived from real service changes, each paired with code and test evidence that establishes the expected answer.
_Avoid_: Demo questions, exploratory prompts, cherry-picked examples

**Pilot Pass Gate**:
The minimum result required to keep Understand-Anything as an adoption candidate: at least ten correct Impact Benchmark answers, evidence links for all twelve, no invented files or relationships, and at least a twenty-five percent reduction in median answer time versus Codex with repository search.
_Avoid_: Looks useful, graph generated successfully, subjective improvement

**Pilot Artifact**:
Understand-Anything data generated from the Analysis Corpus for local evaluation only. Pilot Artifacts are not committed, uploaded to CI, or treated as shared project documentation.
_Avoid_: Project documentation, source artifact, shared cache

**Incremental Refresh**:
Re-analysis of changed files after the initial full analysis when the pinned Analysis Snapshot is deliberately advanced.
_Avoid_: Continuous indexing, background sync, automatic rollout

**Benchmark Mix**:
The Impact Benchmark composition: three direct-dependency questions, four cross-layer questions, three recovery or privacy questions, and two negative controls where no impact is expected.
_Avoid_: Representative sample, broad coverage, random questions

**Paired Comparison**:
A comparison of Understand-Anything enabled and repository-search-only answers under the same Analysis Snapshot, Codex model, and time limit, using fresh context and crossed execution order.
_Avoid_: Before-and-after demo, informal comparison

**Developer Lane**:
The Paired Comparison in which a developer uses the Understand-Anything dashboard or `rg` to answer the Impact Benchmark.
_Avoid_: Human review, usability test

**Agent Lane**:
The Paired Comparison in which a Codex agent uses the code graph or `rg` to answer the Impact Benchmark.
_Avoid_: Automated test, agent demo

**Adoption Candidate**:
A tool that passed the Pilot Pass Gate in both the Developer Lane and Agent Lane. Candidate status does not authorize rollout or make the tool a project standard.
_Avoid_: Adopted tool, approved integration, production-ready

**Stop Rule**:
The pilot ends without adoption when either evaluation lane misses the Pilot Pass Gate. Thresholds and answers are not relaxed or tuned after results are observed.
_Avoid_: Iterate until green, best-effort pass, conditional success

**Analysis Budget**:
One full analysis of an Analysis Snapshot may take at most thirty minutes, and an Incremental Refresh may take at most five minutes. Exceeding either limit stops that run.
_Avoid_: Best effort, unlimited initialization, background processing

**Evidence Answer**:
An Impact Benchmark answer that names the affected behavior, exact file or symbol, and related test evidence. Unresolved impact is reported as `unknown` rather than guessed.
_Avoid_: Graph summary, likely impact, unsupported answer

**Pilot Operator**:
The Codex coordinator that prepares the analysis and runs the Agent Lane, paired with one project developer who independently runs the Developer Lane. Neither role enables CI, schedules, or background automation.
_Avoid_: CI job, team rollout, autonomous monitor

**Artifact Retention**:
Pilot Artifacts and timing records remain local until the pilot result is accepted. Cleanup requires a separate explicit decision.
_Avoid_: Automatic cleanup, permanent archive, committed history
