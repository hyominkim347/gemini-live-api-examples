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

## Result Routing

Passing both lanes makes Understand-Anything an Adoption Candidate only. Rollout, implementation, issue publication, commit, PR, and deployment require a separate next-flow decision. Failing either lane ends adoption work for this approach.
