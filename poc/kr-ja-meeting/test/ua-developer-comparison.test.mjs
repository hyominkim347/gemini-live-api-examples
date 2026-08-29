import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const comparisonScript = resolve(here, "../scripts/ua-developer-comparison.mjs");
const snapshot = "5bf36dd61b6355368d736479c5ffb528b656d544";
const upstreamCommit = "ba450c43425f3de6d43daf76526950ad8ca93536";

function runComparison(args, fixture) {
  return spawnSync(process.execPath, [comparisonScript, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixture.artifactRoot, "fixture-bin")}:${process.env.PATH}`,
    },
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makePilotArtifact() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-developer-comparison-"));
  const sourceRepository = join(fixtureRoot, "source-repository");
  const artifactRoot = join(sourceRepository, ".ua-pilot/pilot-run");
  const snapshotCheckout = join(artifactRoot, "analysis-snapshot");
  const upstreamCheckout = join(artifactRoot, "understand-anything");
  const graphDirectory = join(snapshotCheckout, ".ua");
  const sessionRoot = join(artifactRoot, "developer-comparison");

  await Promise.all([
    mkdir(graphDirectory, { recursive: true }),
    mkdir(upstreamCheckout, { recursive: true }),
    mkdir(sourceRepository, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(snapshotCheckout, ".fixture-head"), `${snapshot}\n`, "utf8"),
    writeFile(join(upstreamCheckout, ".fixture-head"), `${upstreamCommit}\n`, "utf8"),
  ]);

  const fixtureGit = join(artifactRoot, "fixture-bin/git");
  await mkdir(dirname(fixtureGit), { recursive: true });
  await writeFile(fixtureGit, `#!/bin/sh
repo="$2"
command="$3"
if [ "$command" = "rev-parse" ]; then
  /bin/cat "$repo/.fixture-head"
  exit $?
fi
if [ "$command" = "status" ]; then
  if [ -f "$repo/.fixture-dirty" ]; then
    echo " M tracked-source.mjs"
  fi
  exit 0
fi
if [ "$command" = "diff" ]; then
  if [ -f "$repo/.fixture-dashboard-dirty" ]; then
    echo "understand-anything-plugin/packages/dashboard/src/App.tsx"
  fi
  exit 0
fi
if [ "$command" = "check-ignore" ]; then
  case "$5" in
    *"/.ua-pilot/"*) exit 0 ;;
  esac
  exit 1
fi
echo "unsupported fixture git command: $*" >&2
exit 2
`, "utf8");
  await chmod(fixtureGit, 0o755);

  await writeJson(join(graphDirectory, "knowledge-graph.json"), {
    project: { gitCommitHash: snapshot },
    nodes: [],
    edges: [],
    layers: [],
    tour: [],
  });
  await writeJson(join(artifactRoot, "pilot-plan.json"), {
    analysisSnapshot: snapshot,
    sourceRepository,
    snapshotCheckout,
    upstream: {
      commit: upstreamCommit,
      checkout: upstreamCheckout,
      installScope: "artifact-local",
    },
    provider: "current-codex-provider-only",
    artifacts: {
      root: artifactRoot,
      graphDirectory,
      commitPolicy: "local-uncommitted-only",
    },
  });
  await writeJson(join(artifactRoot, "prepare-result.json"), {
    snapshotHead: snapshot,
    upstreamHead: upstreamCommit,
    snapshotClean: true,
    globalInstallerUsed: false,
    symlinksCreated: false,
  });
  await writeJson(join(artifactRoot, "artifact-verification.json"), {
    analysisSnapshot: snapshot,
    passed: true,
  });
  await writeJson(join(artifactRoot, "corpus-manifest.json"), {
    analysisSnapshot: snapshot,
    included: [
      { path: "poc/kr-ja-meeting/src/example.mjs", category: "code" },
      { path: "poc/kr-ja-meeting/test/example.test.mjs", category: "test" },
    ],
  });

  return {
    fixtureRoot,
    artifactRoot,
    sessionRoot,
    snapshotCheckout,
  };
}

function options(fixture) {
  return [
    "--artifact-root", fixture.artifactRoot,
    "--session-root", fixture.sessionRoot,
  ];
}

function prepareOptions(fixture) {
  return [...options(fixture), "--time-limit-minutes", "10"];
}

function operatorAttestation(overrides = {}) {
  return {
    operator: {
      id: "test-fixture-project-developer",
      displayName: "Test Fixture Developer",
      projectRole: "project-developer",
    },
    attestation: {
      isActualProjectDeveloper: true,
      willAuthorAllAnswers: true,
      willNotReusePreviousAnswers: true,
      willNotViewExpectedAnswers: true,
      willUseFreshContextPerArm: true,
      ...overrides,
    },
  };
}

function armAttestation(toolUsed) {
  return {
    answerAuthoredByOperator: true,
    freshContextUsed: true,
    toolUsed,
  };
}

function unknownAnswer(toolUsed = "understandAnything", extra = {}) {
  return {
    answer: "unknown",
    unknown: true,
    evidence: { code: [], tests: [] },
    armAttestation: armAttestation(toolUsed),
    ...extra,
  };
}

function knownAnswer(
  answer = "TEST_FIXTURE_RAW_ANSWER",
  toolUsed = "understandAnything",
) {
  return {
    answer,
    unknown: false,
    evidence: {
      code: ["poc/kr-ja-meeting/src/example.mjs#exampleSymbol"],
      tests: ["poc/kr-ja-meeting/test/example.test.mjs#example behavior"],
    },
    armAttestation: armAttestation(toolUsed),
  };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

async function prepareAndAttest(fixture) {
  const prepared = runComparison(["prepare", ...prepareOptions(fixture)], fixture);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const attestationFile = join(fixture.sessionRoot, "operator-attestation.input.json");
  await writeJson(attestationFile, operatorAttestation());
  const attested = runComparison([
    "attest",
    ...options(fixture),
    "--attestation-file", attestationFile,
  ], fixture);
  assert.equal(attested.status, 0, attested.stderr || attested.stdout);
}

test("prepare creates a prompt-only projection and fixed odd/even crossed schedule", async () => {
  const fixture = await makePilotArtifact();
  try {
    const result = runComparison(["prepare", ...prepareOptions(fixture)], fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const session = JSON.parse(await readFile(join(fixture.sessionRoot, "session.json"), "utf8"));
    const projection = JSON.parse(
      await readFile(join(fixture.sessionRoot, "prompt-projection.json"), "utf8"),
    );
    const template = JSON.parse(
      await readFile(join(fixture.sessionRoot, "operator-attestation-template.json"), "utf8"),
    );
    const exposed = { stdout: result.stdout, session, projection, template };
    const exposedKeys = collectKeys(exposed);

    assert.equal(session.status, "awaiting-operator-attestation");
    assert.equal(session.lane, "developer");
    assert.equal(session.runKind, "paired-comparison-raw");
    assert.equal(session.scored, false);
    assert.equal(session.schedule.length, 24);
    assert.equal(session.timeLimitMilliseconds, 600_000);
    assert.deepEqual(
      session.schedule.slice(0, 4).map(({ questionOrdinal, arm }) => ({ questionOrdinal, arm })),
      [
        { questionOrdinal: 1, arm: "understandAnything" },
        { questionOrdinal: 1, arm: "repositorySearch" },
        { questionOrdinal: 2, arm: "repositorySearch" },
        { questionOrdinal: 2, arm: "understandAnything" },
      ],
    );
    assert.equal(projection.questions.length, 12);
    assert.deepEqual(Object.keys(projection.questions[0]).sort(), ["id", "ordinal", "prompt"]);
    assert.equal(exposedKeys.has("expectedAnswer"), false);
    assert.equal(exposedKeys.has("passGate"), false);
    assert.equal(exposedKeys.has("correct"), false);
    assert.equal(exposedKeys.has("inventedFiles"), false);
    assert.equal(exposedKeys.has("inventedRelations"), false);
    assert.equal(template.attestation.isActualProjectDeveloper, false);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("attest requires an actual project developer to own every independent-run declaration", async () => {
  const fixture = await makePilotArtifact();
  try {
    const prepared = runComparison(["prepare", ...prepareOptions(fixture)], fixture);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const attestationFile = join(fixture.sessionRoot, "operator-attestation.input.json");
    await writeJson(attestationFile, operatorAttestation({ willAuthorAllAnswers: false }));

    const rejected = runComparison([
      "attest",
      ...options(fixture),
      "--attestation-file", attestationFile,
    ], fixture);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /willAuthorAllAnswers must be true/);
    const session = JSON.parse(await readFile(join(fixture.sessionRoot, "session.json"), "utf8"));
    assert.equal(session.status, "awaiting-operator-attestation");
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("show starts one fresh-context arm and never exposes the previous raw answer", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const first = runComparison([
      "show", ...options(fixture), "--fresh-context", "true",
    ], fixture);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPrompt = JSON.parse(first.stdout);
    assert.equal(firstPrompt.sequence, 1);
    assert.equal(firstPrompt.arm, "understandAnything");
    assert.equal(typeof firstPrompt.question.prompt, "string");
    assert.equal(firstPrompt.timeLimitMilliseconds, 600_000);
    assert.ok(Date.parse(firstPrompt.deadlineAt) > Date.parse(firstPrompt.startedAt));

    const answerFile = join(fixture.sessionRoot, "answer.input.json");
    await writeJson(answerFile, knownAnswer("PREVIOUS_ANSWER_MUST_NOT_BE_REPRINTED"));
    const recorded = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    assert.equal(recorded.stdout.includes("PREVIOUS_ANSWER_MUST_NOT_BE_REPRINTED"), false);
    const scrubbedInput = await readFile(answerFile, "utf8");
    assert.equal(scrubbedInput.includes("PREVIOUS_ANSWER_MUST_NOT_BE_REPRINTED"), false);

    const second = runComparison([
      "show", ...options(fixture), "--fresh-context", "true",
    ], fixture);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(second.stdout.includes("PREVIOUS_ANSWER_MUST_NOT_BE_REPRINTED"), false);
    const secondPrompt = JSON.parse(second.stdout);
    assert.equal(secondPrompt.sequence, 2);
    assert.equal(secondPrompt.arm, "repositorySearch");

    const status = runComparison(["status", ...options(fixture)], fixture);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(status.stdout.includes("PREVIOUS_ANSWER_MUST_NOT_BE_REPRINTED"), false);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("record computes answerTimeMs and rejects scoring, expected-answer, or client timing fields", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const shown = runComparison([
      "show", ...options(fixture), "--fresh-context", "true",
    ], fixture);
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);

    const answerFile = join(fixture.sessionRoot, "answer.input.json");
    await writeJson(answerFile, unknownAnswer("repositorySearch"));
    const wrongTool = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.notEqual(wrongTool.status, 0);
    assert.match(wrongTool.stderr, /toolUsed must match the scheduled understandAnything arm/);

    await writeJson(answerFile, unknownAnswer("understandAnything", { answerTimeMs: 1 }));
    const timed = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.notEqual(timed.status, 0);
    assert.match(
      timed.stderr,
      /raw answer input must contain only answer, armAttestation, evidence, unknown/,
    );

    await writeJson(answerFile, unknownAnswer("understandAnything", { correct: true }));
    const scored = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.notEqual(scored.status, 0);

    await writeJson(answerFile, unknownAnswer());
    const recorded = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    const rawRecord = JSON.parse(
      await readFile(join(fixture.sessionRoot, "records/001.json"), "utf8"),
    );
    assert.ok(rawRecord.answerTimeMs > 0);
    assert.equal(rawRecord.answer, "unknown");
    assert.equal(rawRecord.freshContextAttestation, true);
    assert.equal(rawRecord.answerAuthoredByOperator, true);
    assert.equal(rawRecord.toolUsed, "understandAnything");
    assert.equal(rawRecord.armAttestedAt, rawRecord.completedAt);
    assert.equal(rawRecord.timeLimitExceeded, false);
    assert.equal(collectKeys(rawRecord).has("correct"), false);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("record preserves canonical unknown and rejects a guessed unknown", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const shown = runComparison([
      "show", ...options(fixture), "--fresh-context", "true",
    ], fixture);
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const answerFile = join(fixture.sessionRoot, "answer.input.json");
    await writeJson(answerFile, {
      answer: "probably no impact",
      unknown: true,
      evidence: { code: [], tests: [] },
      armAttestation: armAttestation("understandAnything"),
    });
    const rejected = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /canonical unknown/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("the shared arm limit fails a late submission closed as a timed-out unknown", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const shown = runComparison([
      "show", ...options(fixture), "--fresh-context", "true",
    ], fixture);
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);

    const sessionPath = join(fixture.sessionRoot, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    session.activeArm.startedAtMilliseconds = Date.now() - 600_001;
    session.activeArm.startedAt = new Date(
      session.activeArm.startedAtMilliseconds,
    ).toISOString();
    await writeJson(sessionPath, session);

    const answerFile = join(fixture.sessionRoot, "answer.input.json");
    await writeJson(answerFile, {
      answer: "",
      unknown: false,
      evidence: { code: [], tests: [] },
      armAttestation: armAttestation("understandAnything"),
    });
    const recorded = runComparison([
      "record", ...options(fixture), "--answer-file", answerFile,
    ], fixture);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    const output = JSON.parse(recorded.stdout);
    assert.equal(output.timeLimitExceeded, true);

    const rawRecord = JSON.parse(
      await readFile(join(fixture.sessionRoot, "records/001.json"), "utf8"),
    );
    assert.equal(rawRecord.timeLimitExceeded, true);
    assert.equal(rawRecord.answer, "unknown");
    assert.equal(rawRecord.unknown, true);
    assert.deepEqual(rawRecord.evidence, { code: [], tests: [] });
    assert.ok(rawRecord.answerTimeMs > 600_000);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("verify requires exactly twenty-four crossed records and unchanged frozen controls", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const incomplete = runComparison(["verify", ...options(fixture)], fixture);
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /24 raw records are required/);

    const projectionPath = join(fixture.sessionRoot, "prompt-projection.json");
    const projection = JSON.parse(await readFile(projectionPath, "utf8"));
    projection.questions[0].prompt = "MUTATED_PROMPT_MUST_FAIL";
    await writeJson(projectionPath, projection);
    const projected = runComparison(["verify", ...options(fixture)], fixture);
    assert.notEqual(projected.status, 0);
    assert.match(projected.stderr, /prompt-only projection changed after prepare/);
    projection.questions[0].prompt = JSON.parse(
      await readFile(resolve(here, "../benchmark/impact-benchmark.v1.json"), "utf8"),
    ).questions[0].prompt;
    await writeJson(projectionPath, projection);

    const sessionPath = join(fixture.sessionRoot, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    session.frozenControl.benchmarkSha256 = "0".repeat(64);
    await writeJson(sessionPath, session);
    const changed = runComparison(["verify", ...options(fixture)], fixture);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /frozen benchmark or threshold changed/);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("fixture completion verifies 24 raw records without answers, scores, or thresholds in command output", async () => {
  const fixture = await makePilotArtifact();
  try {
    await prepareAndAttest(fixture);
    const answerFile = join(fixture.sessionRoot, "answer.input.json");
    for (let sequence = 1; sequence <= 24; sequence += 1) {
      const shown = runComparison([
        "show", ...options(fixture), "--fresh-context", "true",
      ], fixture);
      assert.equal(shown.status, 0, `show ${sequence}: ${shown.stderr || shown.stdout}`);
      const arm = JSON.parse(shown.stdout).arm;
      await writeJson(answerFile, unknownAnswer(arm));
      const recorded = runComparison([
        "record", ...options(fixture), "--answer-file", answerFile,
      ], fixture);
      assert.equal(
        recorded.status,
        0,
        `record ${sequence}: ${recorded.stderr || recorded.stdout}`,
      );
    }

    const firstRecordPath = join(fixture.sessionRoot, "records/001.json");
    const firstRecord = JSON.parse(await readFile(firstRecordPath, "utf8"));
    firstRecord.armAttestedAt = new Date(
      firstRecord.completedAtMilliseconds - 1,
    ).toISOString();
    await writeJson(firstRecordPath, firstRecord);
    const staleArmAttestation = runComparison([
      "verify", ...options(fixture),
    ], fixture);
    assert.notEqual(staleArmAttestation.status, 0);
    assert.match(staleArmAttestation.stderr, /raw record 1 timing is invalid/);
    firstRecord.armAttestedAt = firstRecord.completedAt;
    await writeJson(firstRecordPath, firstRecord);

    const verified = runComparison(["verify", ...options(fixture)], fixture);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const verificationOutput = JSON.parse(verified.stdout);
    assert.equal(verificationOutput.status, "raw-results-fixed");
    assert.equal(verificationOutput.recordCount, 24);
    assert.equal(verificationOutput.scored, false);

    const raw = JSON.parse(
      await readFile(join(fixture.sessionRoot, "paired-comparison-raw.json"), "utf8"),
    );
    assert.equal(raw.records.length, 24);
    assert.equal(raw.records.filter(({ arm }) => arm === "repositorySearch").length, 12);
    assert.equal(raw.records.filter(({ arm }) => arm === "understandAnything").length, 12);
    assert.ok(raw.records.every(({ answerTimeMs }) => answerTimeMs > 0));
    assert.ok(raw.records.every(({ freshContextAttestation }) => freshContextAttestation));
    assert.ok(raw.records.every(({ answerAuthoredByOperator }) => answerAuthoredByOperator));
    assert.ok(raw.records.every(({ arm, toolUsed }) => arm === toolUsed));
    assert.ok(raw.records.every(({ armAttestedAt, completedAt }) => armAttestedAt === completedAt));
    assert.ok(raw.records.every(({ timeLimitExceeded }) => !timeLimitExceeded));
    assert.ok(raw.records.every(
      ({ timeLimitMilliseconds }) => timeLimitMilliseconds === 600_000,
    ));
    assert.equal(raw.timeLimitMilliseconds, 600_000);
    const forbidden = [
      "expectedAnswer",
      "passGate",
      "correct",
      "inventedFiles",
      "inventedRelations",
      "pass",
      "score",
    ];
    const rawKeys = collectKeys(raw);
    for (const key of forbidden) assert.equal(rawKeys.has(key), false, key);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
