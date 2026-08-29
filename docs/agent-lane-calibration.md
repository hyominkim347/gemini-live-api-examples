# Agent Lane Calibration

AIN-7641 adds one non-scored Agent Lane calibration before the twelve-question
Paired Comparison. It reuses the pinned local graph produced by AIN-7639 and
does not generate, read, or score an Impact Benchmark run.

## Run

Use the AIN-7639 Pilot Artifact as a read-only input and keep this run's output
under an ignored local directory:

```bash
node poc/kr-ja-meeting/scripts/agent-lane-calibration.mjs run \
  --pilot-artifact-root .ua-pilot/pilot-run \
  --output-dir .ua-pilot/agent-lane-calibration
```

The command checks that the pilot plan and graph name the fixed Analysis
Snapshot and `current-codex-provider-only`. It then starts `codex exec` with:

- `--ephemeral` for a fresh context
- `--ignore-user-config` so no alternate provider profile is selected
- `--sandbox read-only` against the Analysis Snapshot
- an output schema containing only the non-scored calibration question

The timer begins immediately before provider invocation and stops when the
schema-conforming final answer is written. `calibration-execution.json` records
the elapsed milliseconds and fresh-context mechanism.

## Evidence Answer policy

An answered calibration must name:

- the affected behavior
- an actual Analysis Corpus code path and symbol
- an actual related test path and test name
- graph node IDs used to ground the answer
- only graph relations that exist exactly in `knowledge-graph.json`

The verifier fails when an answer cites a nonexistent file, graph node, or
relation. When existing evidence is insufficient to establish the symbol,
test, or behavior, verification returns `unknown` instead of accepting a
guess. An explicit `unknown` answer carries no behavior or evidence claims.

## Local outputs

The output directory contains:

- `calibration-protocol.json`
- `calibration-prompt.md`
- `evidence-answer.schema.json`
- `raw-answer.json`
- `calibration-answer.json`
- `calibration-verification.json`
- `calibration-execution.json`

These files are Pilot Artifacts. They stay local and untracked. The scored
twelve-question Agent Lane and its expected answers remain outside this flow
and belong to AIN-7643.
