# Understand-Anything Code Understanding Pilot

## Goal

Evaluate whether Understand-Anything helps a developer and a Codex agent answer code-change impact questions more accurately and quickly than repository search alone.

## Analysis Boundary

- Analysis Snapshot: `5bf36dd61b6355368d736479c5ffb528b656d544`
- Include tracked code, documentation, and tests.
- Exclude ignored, untracked, secret, generated, and dependency files.
- Use the current Codex model provider without adding credentials or providers.

## Impact Benchmark

Freeze twelve questions and their code and test evidence before running the pilot:

- 3 direct-dependency changes
- 4 cross-layer changes
- 3 recovery or privacy changes
- 2 negative controls where no impact is expected

Every Evidence Answer must name the affected behavior, exact file or symbol, and related test. Use `unknown` instead of guessing.

## Comparison

Run both comparisons against the same Analysis Snapshot, Codex model, time limit, and question set. Use fresh context and cross the execution order.

- Developer Lane: Understand-Anything dashboard versus `rg`
- Agent Lane: Understand-Anything graph versus `rg`

## Pilot Pass Gate

Both lanes must independently achieve:

- at least 10 correct answers out of 12
- evidence links for all 12 answers
- zero invented files or relationships
- at least 25% lower median answer time

Missing the gate in either lane activates the Stop Rule. Do not relax thresholds or tune answers after observing results.

## Operating Policy

- One full analysis may take at most 30 minutes.
- An Incremental Refresh may take at most 5 minutes.
- Codex prepares the analysis and runs the Agent Lane.
- One project developer independently runs the Developer Lane.
- Pilot Artifacts remain local with no commit, CI, schedule, or background automation.
- Keep artifacts and timing records until the pilot result is accepted. Cleanup requires a separate explicit decision.

## Local Graph Adapter

AIN-7639 uses `poc/kr-ja-meeting/scripts/understand-anything-pilot.mjs` as a
fail-closed adapter around the reviewed upstream source. It pins:

- Analysis Snapshot: `5bf36dd61b6355368d736479c5ffb528b656d544`
- Understand-Anything: `ba450c43425f3de6d43daf76526950ad8ca93536`
- full analysis budget: 30 minutes
- Incremental Refresh budget: 5 minutes

The adapter never runs the upstream global installer, creates no skill
symlinks or hooks, and writes only under the ignored `.ua-pilot/` directory.
Give `prepare` either the reviewed local upstream checkout or the official
repository URL. Existing artifact checkouts are not overwritten when their
HEAD differs from the pin.

```bash
node poc/kr-ja-meeting/scripts/understand-anything-pilot.mjs prepare \
  --repo /absolute/path/to/repository \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run \
  --upstream-source /absolute/path/to/reviewed/Understand-Anything
```

Run the generated `codex-prompt.md` only with the current Codex provider and
`UNDERSTAND_NO_WORKTREE_REDIRECT=1`. The plan limits dependency installation
and the core build to the pinned artifact-local checkout. The prompt fixes
`--full`, `--language ko`, and `--no-auto-update`; automatic refresh is outside
this pilot.

After upstream scanning, require exact inventory equality:

```bash
node poc/kr-ja-meeting/scripts/understand-anything-pilot.mjs verify-scan \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run
```

`prepare` initializes `run-metrics.json` and `calibration-answer.json` with
`not-run` states. Replace those states only with observed local evidence, then
run `verify-artifact`. It rejects a missing or wrong graph revision, missing
fingerprints, corpus drift, calibration evidence that does not resolve to graph
nodes, an unmeasured run, or either time-budget overrun. A prepared corpus or
deterministic scan alone is not a passing pilot.

```bash
node poc/kr-ja-meeting/scripts/understand-anything-pilot.mjs verify-artifact \
  --artifact-root /absolute/path/to/repository/.ua-pilot/pilot-run
```

## Result Routing

Passing both lanes makes Understand-Anything an Adoption Candidate only. Rollout, implementation, issue publication, commit, PR, and deployment require a separate next-flow decision. Failing either lane ends adoption work for this approach.
