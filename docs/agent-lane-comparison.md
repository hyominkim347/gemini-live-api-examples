# Agent Lane Paired Comparison raw results

AIN-7643 runs the frozen twelve-question Impact Benchmark twice: once with the pinned
Understand-Anything graph and once with repository search using `rg`. This
Agent Lane Paired Comparison records twenty-four raw answers only. It does not evaluate correctness,
apply the Pilot Pass Gate, or change any threshold.

## Isolation contract

`prepare` creates two sanitized, local-only material roots below the ignored
output directory:

- `materials/graph` contains only the pinned `knowledge-graph.json`.
- `materials/rg` contains only files listed in the Analysis Corpus manifest.

The output path must contain a `.ua-pilot` directory and must be outside every
Git checkout. The benchmark answer key, scorer, earlier answers, and files outside the
Analysis Corpus are absent from both roots. Each invocation receives one
question and one arm's material. Every invocation uses the current OpenAI
Codex provider with `codex exec --ephemeral --ignore-user-config
--skip-git-repo-check --sandbox read-only`; resume, fork, local providers, and alternate provider profiles are
not used.

The order is fixed before execution. Odd-numbered questions run graph first;
even-numbered questions run `rg` first. Both arms use the same timeout.

## Run

From the repository root, reuse the AIN-7639 Pilot Artifact and keep outputs
under ignored `.ua-pilot` storage:

```bash
node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs prepare \
  --pilot-artifact-root <PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison \
  --timeout-ms 600000

node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs run \
  --pilot-artifact-root <PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison

node poc/kr-ja-meeting/scripts/agent-lane-comparison.mjs verify \
  --pilot-artifact-root <PILOT_ARTIFACT_ROOT> \
  --output-dir /private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison
```

`run` writes one directory per scheduled invocation. A completed
`raw-result.json` is reusable after interruption, but no prior result is ever
included in a later provider context. `verify` rebuilds every raw record from
the provider answer, execution timing, pinned snapshot, corpus manifest, and
graph.

## Raw evidence

Each `raw-result.json` records:

- final answer and `unknown`
- cited code paths and symbols
- cited test paths and test names
- graph relations, when the graph arm uses them
- invented files and relations detected against the pinned artifact
- source/test evidence that could not be established
- provider invocation timing in milliseconds

`raw-results.json` collects the twenty-four records with the frozen order and
timeout. It intentionally has no `correct`, `pass`, failure threshold, median,
or comparison metric. The raw Pilot Artifact remains ignored and must not be
committed. Evaluation belongs to a later, separately authorized step.
