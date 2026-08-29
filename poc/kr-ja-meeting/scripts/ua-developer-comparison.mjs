#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ANALYSIS_SNAPSHOT,
  UPSTREAM_COMMIT,
} from "./understand-anything-pilot.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(
  scriptDirectory,
  "../benchmark/impact-benchmark.v1.json",
);
const scorerPath = resolve(scriptDirectory, "score-impact-benchmark.mjs");
const scorerContractPath = resolve(
  scriptDirectory,
  "../src/impact-benchmark-contract.mjs",
);
const dashboardScript = resolve(scriptDirectory, "ua-developer-lane.mjs");

const CONTRACT_VERSION = 1;
const QUESTION_COUNT = 12;
const RECORD_COUNT = QUESTION_COUNT * 2;
const CROSSED_ORDER =
  "odd-understandAnything-first_even-repositorySearch-first";
const SESSION_FILE = "session.json";
const PROJECTION_FILE = "prompt-projection.json";
const ATTESTATION_TEMPLATE_FILE = "operator-attestation-template.json";
const ATTESTATION_FILE = "operator-attestation.json";
const ANSWER_TEMPLATE_FILE = "answer-template.json";
const RAW_RESULT_FILE = "paired-comparison-raw.json";
const VERIFICATION_FILE = "developer-comparison-verification.json";
const REVIEWED_FROZEN_CONTROL = Object.freeze({
  benchmarkSha256: "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6",
  passGateSha256: "07bcd69cec5e81120cb77f03e1426b59e0bad82fbb3659bdb5a28fcbb0aa6713",
  projectionSha256: "ff3bcd99cd1ddbf0038b6fad8eba42993bc09117b0ed1dae584bb84ed37cb305",
  controlSha256: "a2fafaff12f856caa1bd0b8426ad25eab4d575708f139651b29a428c3771c42a",
});
const RAW_IDENTITY = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  lane: "developer",
  runKind: "paired-comparison-raw",
  scored: false,
  analysisSnapshot: ANALYSIS_SNAPSHOT,
});
const ATTESTATION_KEYS = [
  "willAuthorAllAnswers",
  "willNotReusePreviousAnswers",
  "willNotViewExpectedAnswers",
  "willUseFreshContextPerArm",
  "isActualProjectDeveloper",
];
const ARM_ATTESTATION_KEYS = [
  "answerAuthoredByOperator",
  "freshContextUsed",
  "toolUsed",
];

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const name = option.slice(2);
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${option}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain only ${expected.join(", ")}`);
  }
}

function requireNonEmptyText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireDescendant(parent, child, label) {
  const pathFromParent = relative(parent, child);
  if (!pathFromParent || pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
    throw new Error(`${label} must remain inside its allowed parent directory`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid at ${path}: ${error.message}`);
  }
}

async function writeJson(path, value, options = "utf8") {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function replaceJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeJson(temporary, value, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function sha256(...chunks) {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

function git(repo, args, label, allowedStatuses = new Set([0])) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowedStatuses.has(result.status)) {
    throw new Error(
      `${label} failed: ${result.stderr.trim() || `git ${args.join(" ")} exited ${result.status}`}`,
    );
  }
  return result;
}

function makeSchedule(questions) {
  const schedule = [];
  for (const question of questions) {
    const arms = question.ordinal % 2 === 1
      ? ["understandAnything", "repositorySearch"]
      : ["repositorySearch", "understandAnything"];
    for (const arm of arms) {
      schedule.push({
        sequence: schedule.length + 1,
        questionOrdinal: question.ordinal,
        questionId: question.id,
        arm,
      });
    }
  }
  return schedule;
}

function answerTemplate(arm = "") {
  return {
    answer: "",
    unknown: false,
    evidence: {
      code: ["relative/path.mjs#symbol"],
      tests: ["relative/test.test.mjs#test name"],
    },
    armAttestation: {
      answerAuthoredByOperator: false,
      freshContextUsed: false,
      toolUsed: arm,
    },
  };
}

function validateBenchmark(benchmark) {
  requireObject(benchmark, "frozen Impact Benchmark");
  if (
    benchmark.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    typeof benchmark.revision !== "string" ||
    !benchmark.revision ||
    typeof benchmark.frozenAt !== "string" ||
    !benchmark.frozenAt ||
    benchmark.freezePolicy !== "immutable-after-first-scored-run"
  ) {
    throw new Error("frozen Impact Benchmark identity is invalid");
  }
  if (!Array.isArray(benchmark.questions) || benchmark.questions.length !== QUESTION_COUNT) {
    throw new Error("frozen Impact Benchmark must contain exactly 12 questions");
  }
  if (new Set(benchmark.questions.map(({ id }) => id)).size !== QUESTION_COUNT) {
    throw new Error("frozen Impact Benchmark must contain 12 unique question ids");
  }
  for (const question of benchmark.questions) {
    requireNonEmptyText(question.id, "question.id");
    requireNonEmptyText(question.prompt, `question ${question.id} prompt`);
    if (!Object.hasOwn(question, "expectedAnswer")) {
      throw new Error(`question ${question.id} lacks its sealed expected answer`);
    }
  }
  requireObject(benchmark.passGate, "frozen legacy passGate contract");
}

async function loadFrozenControl() {
  const [benchmarkBytes, scorerBytes, scorerContractBytes] = await Promise.all([
    readFile(benchmarkPath),
    readFile(scorerPath),
    readFile(scorerContractPath),
  ]);
  const benchmark = JSON.parse(benchmarkBytes.toString("utf8"));
  validateBenchmark(benchmark);
  const questions = benchmark.questions.map(({ id, prompt }, index) => ({
    ordinal: index + 1,
    id,
    prompt,
  }));
  const hashes = {
    benchmarkSha256: sha256(benchmarkBytes),
    passGateSha256: sha256(JSON.stringify(benchmark.passGate)),
    projectionSha256: sha256(JSON.stringify(questions)),
    controlSha256: sha256(
      "benchmark\0",
      benchmarkBytes,
      "\0scorer\0",
      scorerBytes,
      "\0contract\0",
      scorerContractBytes,
    ),
  };
  if (!sameJson(hashes, REVIEWED_FROZEN_CONTROL)) {
    throw new Error("frozen benchmark, threshold, or scorer differs from the reviewed contract");
  }
  return {
    benchmark,
    questions,
    hashes,
  };
}

async function loadPilotArtifact(artifactRoot) {
  const [plan, prepared, verification, manifest] = await Promise.all([
    readJson(resolve(artifactRoot, "pilot-plan.json"), "pilot plan"),
    readJson(resolve(artifactRoot, "prepare-result.json"), "prepare evidence"),
    readJson(resolve(artifactRoot, "artifact-verification.json"), "artifact verification"),
    readJson(resolve(artifactRoot, "corpus-manifest.json"), "corpus manifest"),
  ]);
  if (
    plan.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    prepared.snapshotHead !== ANALYSIS_SNAPSHOT ||
    verification.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    manifest.analysisSnapshot !== ANALYSIS_SNAPSHOT
  ) {
    throw new Error(`Pilot Artifact must use Analysis Snapshot ${ANALYSIS_SNAPSHOT}`);
  }
  if (
    plan.upstream?.commit !== UPSTREAM_COMMIT ||
    prepared.upstreamHead !== UPSTREAM_COMMIT
  ) {
    throw new Error(`Pilot Artifact must use reviewed upstream commit ${UPSTREAM_COMMIT}`);
  }
  if (
    verification.passed !== true ||
    prepared.snapshotClean !== true ||
    prepared.globalInstallerUsed !== false ||
    prepared.symlinksCreated !== false ||
    plan.upstream?.installScope !== "artifact-local" ||
    plan.provider !== "current-codex-provider-only" ||
    plan.artifacts?.commitPolicy !== "local-uncommitted-only" ||
    !Array.isArray(manifest.included)
  ) {
    throw new Error("Pilot Artifact local-only verification policy is not satisfied");
  }

  const sourceRepository = resolve(plan.sourceRepository);
  const snapshotCheckout = resolve(plan.snapshotCheckout);
  const upstreamCheckout = resolve(plan.upstream.checkout);
  const graphDirectory = resolve(plan.artifacts.graphDirectory);
  if (resolve(plan.artifacts.root) !== artifactRoot) {
    throw new Error("Pilot Artifact root does not match its pinned plan");
  }
  requireDescendant(sourceRepository, artifactRoot, "Pilot Artifact root");
  requireDescendant(artifactRoot, snapshotCheckout, "snapshot checkout");
  requireDescendant(artifactRoot, upstreamCheckout, "upstream checkout");
  requireDescendant(snapshotCheckout, graphDirectory, "graph directory");

  const ignored = git(
    sourceRepository,
    ["check-ignore", "-q", artifactRoot],
    "Pilot Artifact ignore check",
    new Set([0, 1]),
  );
  if (ignored.status !== 0) {
    throw new Error("Pilot Artifact root must be ignored by its source repository");
  }
  const snapshotHead = git(
    snapshotCheckout,
    ["rev-parse", "HEAD"],
    "snapshot HEAD check",
  ).stdout.trim();
  const upstreamHead = git(
    upstreamCheckout,
    ["rev-parse", "HEAD"],
    "upstream HEAD check",
  ).stdout.trim();
  if (snapshotHead !== ANALYSIS_SNAPSHOT || upstreamHead !== UPSTREAM_COMMIT) {
    throw new Error("Pilot Artifact checkout pins changed after graph generation");
  }
  const snapshotStatus = git(
    snapshotCheckout,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "snapshot tracked-state check",
  ).stdout.trim();
  if (snapshotStatus) {
    throw new Error(`Snapshot checkout has tracked changes: ${snapshotStatus}`);
  }
  const upstreamChanges = git(
    upstreamCheckout,
    [
      "diff", "--name-only", "HEAD", "--",
      "understand-anything-plugin/packages/core",
      "understand-anything-plugin/packages/dashboard",
    ],
    "upstream source check",
  ).stdout.trim();
  if (upstreamChanges) {
    throw new Error(`Pinned upstream source has tracked changes: ${upstreamChanges}`);
  }

  const graph = await readJson(
    resolve(graphDirectory, "knowledge-graph.json"),
    "knowledge graph",
  );
  if (
    graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.layers) ||
    !Array.isArray(graph.tour)
  ) {
    throw new Error("Pilot Artifact knowledge graph identity or structure is invalid");
  }

  return {
    artifactRoot,
    sourceRepository,
    snapshotCheckout,
    upstreamCheckout,
    graphDirectory,
  };
}

function requireSessionIdentity(session, artifactRoot) {
  for (const [key, expected] of Object.entries(RAW_IDENTITY)) {
    if (session[key] !== expected) throw new Error(`Developer Lane session has invalid ${key}`);
  }
  if (
    session.artifactRoot !== artifactRoot ||
    session.crossedOrder !== CROSSED_ORDER ||
    !Number.isInteger(session.timeLimitMilliseconds) ||
    session.timeLimitMilliseconds <= 0 ||
    !Number.isInteger(session.recordedCount) ||
    session.recordedCount < 0 ||
    session.recordedCount > RECORD_COUNT ||
    !new Set([
      "awaiting-operator-attestation",
      "ready",
      "in-progress",
      "awaiting-verification",
      "raw-results-fixed",
    ]).has(session.status)
  ) {
    throw new Error("Developer Lane session identity is invalid");
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadSession(artifactRoot, sessionRoot) {
  requireDescendant(artifactRoot, sessionRoot, "session root");
  const [session, projection] = await Promise.all([
    readJson(resolve(sessionRoot, SESSION_FILE), "Developer Lane session"),
    readJson(resolve(sessionRoot, PROJECTION_FILE), "prompt-only projection"),
  ]);
  requireSessionIdentity(session, artifactRoot);
  requireExactKeys(
    projection,
    new Set(["benchmarkFrozenAt", "benchmarkRevision", "contractVersion", "questions"]),
    "prompt-only projection",
  );
  if (
    projection.contractVersion !== CONTRACT_VERSION ||
    projection.benchmarkRevision !== session.benchmarkRevision ||
    projection.benchmarkFrozenAt !== session.benchmarkFrozenAt ||
    !Array.isArray(projection.questions) ||
    projection.questions.length !== QUESTION_COUNT
  ) {
    throw new Error("prompt-only projection identity is invalid");
  }
  for (const question of projection.questions) {
    requireExactKeys(question, new Set(["id", "ordinal", "prompt"]), "projected question");
    requireNonEmptyText(question.id, "projected question id");
    requireNonEmptyText(question.prompt, "projected question prompt");
  }
  if (
    sha256(JSON.stringify(projection.questions)) !==
    session.frozenControl?.projectionSha256
  ) {
    throw new Error("prompt-only projection changed after prepare");
  }
  const expectedSchedule = makeSchedule(projection.questions);
  if (!sameJson(session.schedule, expectedSchedule)) {
    throw new Error("Developer Lane crossed order changed after prepare");
  }
  return { session, projection };
}

async function requireFrozenControl(session) {
  const current = await loadFrozenControl();
  if (
    session.benchmarkRevision !== current.benchmark.revision ||
    session.benchmarkFrozenAt !== current.benchmark.frozenAt ||
    !sameJson(session.frozenControl, current.hashes)
  ) {
    throw new Error("frozen benchmark or threshold changed after prepare");
  }
  return current;
}

function validateOperatorAttestation(input) {
  requireExactKeys(input, new Set(["attestation", "operator"]), "operator attestation input");
  requireExactKeys(
    input.operator,
    new Set(["displayName", "id", "projectRole"]),
    "operator identity",
  );
  requireNonEmptyText(input.operator.id, "operator.id");
  requireNonEmptyText(input.operator.displayName, "operator.displayName");
  if (input.operator.projectRole !== "project-developer") {
    throw new Error("operator.projectRole must be project-developer");
  }
  requireExactKeys(input.attestation, new Set(ATTESTATION_KEYS), "operator attestation");
  for (const key of ATTESTATION_KEYS) {
    if (input.attestation[key] !== true) throw new Error(`${key} must be true`);
  }
}

async function loadAttestation(sessionRoot, session) {
  if (session.operatorAttestationFile !== ATTESTATION_FILE) {
    throw new Error("actual project developer attestation is not recorded");
  }
  const attestation = await readJson(
    resolve(sessionRoot, ATTESTATION_FILE),
    "operator attestation",
  );
  requireExactKeys(
    attestation,
    new Set(["attestation", "attestedAt", "operator"]),
    "stored operator attestation",
  );
  validateOperatorAttestation({
    operator: attestation.operator,
    attestation: attestation.attestation,
  });
  if (
    typeof attestation.attestedAt !== "string" ||
    Number.isNaN(Date.parse(attestation.attestedAt)) ||
    !sameJson(session.operator, attestation.operator)
  ) {
    throw new Error("stored operator attestation identity is invalid");
  }
  return attestation;
}

function validateAnswer(answer) {
  requireExactKeys(answer, new Set(["answer", "evidence", "unknown"]), "answer file");
  const answerText = requireNonEmptyText(answer.answer, "answer");
  if (typeof answer.unknown !== "boolean") throw new Error("unknown must be a boolean");
  requireExactKeys(answer.evidence, new Set(["code", "tests"]), "answer evidence");
  for (const field of ["code", "tests"]) {
    if (!Array.isArray(answer.evidence[field])) {
      throw new Error(`evidence.${field} must be an array`);
    }
    for (const item of answer.evidence[field]) {
      requireNonEmptyText(item, `evidence.${field} item`);
    }
    if (new Set(answer.evidence[field]).size !== answer.evidence[field].length) {
      throw new Error(`evidence.${field} must not contain duplicates`);
    }
  }

  if (answer.unknown) {
    if (
      answerText !== "unknown" ||
      answer.evidence.code.length !== 0 ||
      answer.evidence.tests.length !== 0
    ) {
      throw new Error("canonical unknown requires answer='unknown' and empty code/tests");
    }
  } else if (
    answerText === "unknown" ||
    answer.evidence.code.length === 0 ||
    answer.evidence.tests.length === 0
  ) {
    throw new Error("a known raw answer requires both code and test evidence");
  }
  return {
    answer: answerText,
    unknown: answer.unknown,
    evidence: {
      code: answer.evidence.code.map((item) => item.trim()),
      tests: answer.evidence.tests.map((item) => item.trim()),
    },
  };
}

function validateArmAttestation(attestation, expectedArm) {
  requireExactKeys(
    attestation,
    new Set(ARM_ATTESTATION_KEYS),
    "arm attestation",
  );
  if (attestation.answerAuthoredByOperator !== true) {
    throw new Error("answerAuthoredByOperator must be true at record time");
  }
  if (attestation.freshContextUsed !== true) {
    throw new Error("freshContextUsed must be true at record time");
  }
  if (attestation.toolUsed !== expectedArm) {
    throw new Error(`toolUsed must match the scheduled ${expectedArm} arm`);
  }
  return { ...attestation };
}

function validateSubmission(input, expectedArm, answerRequired) {
  requireExactKeys(
    input,
    new Set(["answer", "armAttestation", "evidence", "unknown"]),
    "raw answer input",
  );
  const armAttestation = validateArmAttestation(
    input.armAttestation,
    expectedArm,
  );
  const answer = answerRequired
    ? validateAnswer({
        answer: input.answer,
        unknown: input.unknown,
        evidence: input.evidence,
      })
    : { answer: "unknown", unknown: true, evidence: { code: [], tests: [] } };
  return { ...answer, armAttestation };
}

function recordFileName(sequence) {
  return `${String(sequence).padStart(3, "0")}.json`;
}

function validateRecord(record, expected, operatorId, timeLimitMilliseconds) {
  requireExactKeys(record, new Set([
    "analysisSnapshot",
    "answer",
    "answerAuthoredByOperator",
    "answerTimeMs",
    "arm",
    "completedAt",
    "completedAtMilliseconds",
    "contractVersion",
    "evidence",
    "freshContextAttestation",
    "armAttestedAt",
    "lane",
    "operatorId",
    "questionId",
    "questionOrdinal",
    "runKind",
    "scored",
    "sequence",
    "startedAt",
    "startedAtMilliseconds",
    "timeLimitExceeded",
    "timeLimitMilliseconds",
    "toolUsed",
    "unknown",
  ]), `raw record ${expected.sequence}`);
  for (const [key, identityValue] of Object.entries(RAW_IDENTITY)) {
    if (record[key] !== identityValue) {
      throw new Error(`raw record ${expected.sequence} has invalid ${key}`);
    }
  }
  if (
    record.operatorId !== operatorId ||
    record.sequence !== expected.sequence ||
    record.questionOrdinal !== expected.questionOrdinal ||
    record.questionId !== expected.questionId ||
    record.arm !== expected.arm ||
    record.toolUsed !== expected.arm ||
    record.answerAuthoredByOperator !== true ||
    record.freshContextAttestation !== true ||
    typeof record.timeLimitExceeded !== "boolean" ||
    record.timeLimitMilliseconds !== timeLimitMilliseconds
  ) {
    throw new Error(`raw record ${expected.sequence} identity is invalid`);
  }
  validateAnswer({
    answer: record.answer,
    unknown: record.unknown,
    evidence: record.evidence,
  });
  const elapsed = record.completedAtMilliseconds - record.startedAtMilliseconds;
  if (
    !Number.isFinite(record.startedAtMilliseconds) ||
    !Number.isFinite(record.completedAtMilliseconds) ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    record.answerTimeMs !== Math.max(1, elapsed) ||
    new Date(record.startedAtMilliseconds).toISOString() !== record.startedAt ||
    new Date(record.completedAtMilliseconds).toISOString() !== record.completedAt ||
    record.armAttestedAt !== record.completedAt
  ) {
    throw new Error(`raw record ${expected.sequence} timing is invalid`);
  }
  if (
    (record.timeLimitExceeded && elapsed <= timeLimitMilliseconds) ||
    (!record.timeLimitExceeded && elapsed > timeLimitMilliseconds)
  ) {
    throw new Error(`raw record ${expected.sequence} time-limit status is invalid`);
  }
  if (
    record.timeLimitExceeded &&
    (
      record.answer !== "unknown" ||
      record.unknown !== true ||
      record.evidence.code.length !== 0 ||
      record.evidence.tests.length !== 0
    )
  ) {
    throw new Error(`raw record ${expected.sequence} must fail closed after timeout`);
  }
}

function timeLimitMilliseconds(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error("--time-limit-minutes must be an integer from 1 through 1440");
  }
  return minutes * 60_000;
}

function commandOptions(args, extra = []) {
  const allowed = new Set(["artifact-root", "session-root", ...extra]);
  const options = parseOptions(args, allowed);
  if (!options["artifact-root"] || !options["session-root"]) {
    throw new Error("--artifact-root and --session-root are required");
  }
  return {
    ...options,
    artifactRoot: resolve(options["artifact-root"]),
    sessionRoot: resolve(options["session-root"]),
  };
}

async function prepareCommand(args) {
  const options = commandOptions(args, ["time-limit-minutes"]);
  if (!options["time-limit-minutes"]) {
    throw new Error("prepare requires a pre-approved --time-limit-minutes value");
  }
  const armTimeLimitMilliseconds = timeLimitMilliseconds(
    options["time-limit-minutes"],
  );
  const artifact = await loadPilotArtifact(options.artifactRoot);
  const frozen = await loadFrozenControl();
  requireDescendant(options.artifactRoot, options.sessionRoot, "session root");
  await mkdir(options.sessionRoot);
  await mkdir(resolve(options.sessionRoot, "records"));

  const projection = {
    contractVersion: CONTRACT_VERSION,
    benchmarkRevision: frozen.benchmark.revision,
    benchmarkFrozenAt: frozen.benchmark.frozenAt,
    questions: frozen.questions,
  };
  const attestationTemplate = {
    operator: {
      id: "",
      displayName: "",
      projectRole: "project-developer",
    },
    attestation: Object.fromEntries(ATTESTATION_KEYS.map((key) => [key, false])),
  };
  const preparedAt = new Date().toISOString();
  const session = {
    ...RAW_IDENTITY,
    status: "awaiting-operator-attestation",
    benchmarkRevision: frozen.benchmark.revision,
    benchmarkFrozenAt: frozen.benchmark.frozenAt,
    artifactRoot: options.artifactRoot,
    snapshotCheckout: artifact.snapshotCheckout,
    graphDirectory: artifact.graphDirectory,
    crossedOrder: CROSSED_ORDER,
    timeLimitMilliseconds: armTimeLimitMilliseconds,
    schedule: makeSchedule(frozen.questions),
    frozenControl: frozen.hashes,
    preparedAt,
    operator: null,
    operatorAttestationFile: null,
    recordedCount: 0,
    activeArm: null,
  };
  await Promise.all([
    writeJson(resolve(options.sessionRoot, PROJECTION_FILE), projection, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeJson(resolve(options.sessionRoot, ATTESTATION_TEMPLATE_FILE), attestationTemplate, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeJson(resolve(options.sessionRoot, ANSWER_TEMPLATE_FILE), answerTemplate(), {
      encoding: "utf8",
      flag: "wx",
    }),
    writeJson(resolve(options.sessionRoot, SESSION_FILE), session, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  process.stdout.write(`${JSON.stringify({
    command: "prepare",
    status: session.status,
    sessionRoot: options.sessionRoot,
    promptCount: QUESTION_COUNT,
    armCount: RECORD_COUNT,
    crossedOrder: CROSSED_ORDER,
    timeLimitMilliseconds: armTimeLimitMilliseconds,
    scored: false,
    operatorActionRequired: "complete and submit the local operator attestation",
  })}\n`);
}

async function attestCommand(args) {
  const options = commandOptions(args, ["attestation-file"]);
  if (!options["attestation-file"]) throw new Error("--attestation-file is required");
  await loadPilotArtifact(options.artifactRoot);
  const { session } = await loadSession(options.artifactRoot, options.sessionRoot);
  await requireFrozenControl(session);
  if (session.status !== "awaiting-operator-attestation") {
    throw new Error("Developer Lane session is not awaiting operator attestation");
  }
  const attestationInput = resolve(options["attestation-file"]);
  requireDescendant(options.sessionRoot, attestationInput, "operator attestation input");
  const input = await readJson(attestationInput, "operator attestation input");
  validateOperatorAttestation(input);
  const stored = {
    operator: {
      id: input.operator.id.trim(),
      displayName: input.operator.displayName.trim(),
      projectRole: input.operator.projectRole,
    },
    attestation: { ...input.attestation },
    attestedAt: new Date().toISOString(),
  };
  await writeJson(resolve(options.sessionRoot, ATTESTATION_FILE), stored, {
    encoding: "utf8",
    flag: "wx",
  });
  await replaceJson(resolve(options.sessionRoot, SESSION_FILE), {
    ...session,
    status: "ready",
    operator: stored.operator,
    operatorAttestationFile: ATTESTATION_FILE,
  });
  process.stdout.write(`${JSON.stringify({
    command: "attest",
    status: "ready",
    operatorId: stored.operator.id,
    recordedCount: 0,
    scored: false,
  })}\n`);
}

async function showCommand(args) {
  const options = commandOptions(args, ["fresh-context"]);
  if (options["fresh-context"] !== "true") {
    throw new Error("show requires --fresh-context true after opening a new arm context");
  }
  const artifact = await loadPilotArtifact(options.artifactRoot);
  const { session, projection } = await loadSession(
    options.artifactRoot,
    options.sessionRoot,
  );
  await requireFrozenControl(session);
  await loadAttestation(options.sessionRoot, session);
  if (!new Set(["ready", "in-progress"]).has(session.status)) {
    throw new Error("Developer Lane session is not ready for another arm");
  }
  if (session.activeArm !== null) {
    throw new Error("An arm is already active; record it before showing another prompt");
  }
  if (session.recordedCount >= RECORD_COUNT) {
    throw new Error("All 24 arms are recorded; run verify instead");
  }

  const scheduled = session.schedule[session.recordedCount];
  const question = projection.questions[scheduled.questionOrdinal - 1];
  if (question.id !== scheduled.questionId) {
    throw new Error("prompt projection no longer matches the crossed schedule");
  }
  const startedAtMilliseconds = Date.now();
  const activeArm = {
    ...scheduled,
    freshContextAttestation: true,
    startedAt: new Date(startedAtMilliseconds).toISOString(),
    startedAtMilliseconds,
  };
  await writeJson(
    resolve(options.sessionRoot, ANSWER_TEMPLATE_FILE),
    answerTemplate(scheduled.arm),
    "utf8",
  );
  await replaceJson(resolve(options.sessionRoot, SESSION_FILE), {
    ...session,
    status: "in-progress",
    activeArm,
  });

  const tool = scheduled.arm === "understandAnything"
    ? {
        kind: "understand-anything-dashboard-only",
        command: [
          process.execPath,
          dashboardScript,
          "dashboard",
          "--artifact-root",
          options.artifactRoot,
        ],
      }
    : {
        kind: "repository-search-only",
        workingDirectory: artifact.snapshotCheckout,
        command: "rg",
      };
  process.stdout.write(`${JSON.stringify({
    command: "show",
    sequence: scheduled.sequence,
    arm: scheduled.arm,
    question,
    tool,
    startedAt: activeArm.startedAt,
    deadlineAt: new Date(
      startedAtMilliseconds + session.timeLimitMilliseconds,
    ).toISOString(),
    timeLimitMilliseconds: session.timeLimitMilliseconds,
    freshContextAttestation: true,
  })}\n`);
}

async function recordCommand(args) {
  const options = commandOptions(args, ["answer-file"]);
  if (!options["answer-file"]) throw new Error("--answer-file is required");
  await loadPilotArtifact(options.artifactRoot);
  const { session } = await loadSession(options.artifactRoot, options.sessionRoot);
  await requireFrozenControl(session);
  const attestation = await loadAttestation(options.sessionRoot, session);
  if (session.status !== "in-progress" || !session.activeArm) {
    throw new Error("No active arm is waiting for a raw answer");
  }
  const answerFile = resolve(options["answer-file"]);
  requireDescendant(options.sessionRoot, answerFile, "answer file");

  const completedAtMilliseconds = Date.now();
  const elapsed = completedAtMilliseconds - session.activeArm.startedAtMilliseconds;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error("Developer Lane clock moved backwards; answer time cannot be trusted");
  }
  const timeLimitExceeded = elapsed > session.timeLimitMilliseconds;
  const submission = validateSubmission(
    await readJson(answerFile, "raw answer"),
    session.activeArm.arm,
    !timeLimitExceeded,
  );
  const record = {
    ...RAW_IDENTITY,
    sequence: session.activeArm.sequence,
    questionOrdinal: session.activeArm.questionOrdinal,
    questionId: session.activeArm.questionId,
    arm: session.activeArm.arm,
    toolUsed: submission.armAttestation.toolUsed,
    operatorId: attestation.operator.id,
    answer: submission.answer,
    unknown: submission.unknown,
    evidence: submission.evidence,
    answerAuthoredByOperator: submission.armAttestation.answerAuthoredByOperator,
    freshContextAttestation: submission.armAttestation.freshContextUsed,
    startedAt: session.activeArm.startedAt,
    startedAtMilliseconds: session.activeArm.startedAtMilliseconds,
    completedAt: new Date(completedAtMilliseconds).toISOString(),
    completedAtMilliseconds,
    armAttestedAt: new Date(completedAtMilliseconds).toISOString(),
    answerTimeMs: Math.max(1, elapsed),
    timeLimitExceeded,
    timeLimitMilliseconds: session.timeLimitMilliseconds,
  };
  const recordPath = resolve(
    options.sessionRoot,
    "records",
    recordFileName(record.sequence),
  );
  await writeJson(recordPath, record, { encoding: "utf8", flag: "wx" });
  await writeJson(answerFile, answerTemplate(), "utf8");
  const recordedCount = session.recordedCount + 1;
  const status = recordedCount === RECORD_COUNT ? "awaiting-verification" : "ready";
  await replaceJson(resolve(options.sessionRoot, SESSION_FILE), {
    ...session,
    status,
    recordedCount,
    activeArm: null,
  });
  process.stdout.write(`${JSON.stringify({
    command: "record",
    status,
    sequence: record.sequence,
    recordedCount,
    remainingCount: RECORD_COUNT - recordedCount,
    answerTimeMs: record.answerTimeMs,
    timeLimitExceeded,
    scored: false,
  })}\n`);
}

async function statusCommand(args) {
  const options = commandOptions(args);
  await loadPilotArtifact(options.artifactRoot);
  const { session } = await loadSession(options.artifactRoot, options.sessionRoot);
  await requireFrozenControl(session);
  const next = session.activeArm ?? session.schedule[session.recordedCount] ?? null;
  process.stdout.write(`${JSON.stringify({
    command: "status",
    status: session.status,
    recordedCount: session.recordedCount,
    remainingCount: RECORD_COUNT - session.recordedCount,
    currentOrNext: next && {
      sequence: next.sequence,
      questionOrdinal: next.questionOrdinal,
      questionId: next.questionId,
      arm: next.arm,
      active: session.activeArm !== null,
    },
    scored: false,
  })}\n`);
}

async function verifyCommand(args) {
  const options = commandOptions(args);
  await loadPilotArtifact(options.artifactRoot);
  const { session } = await loadSession(options.artifactRoot, options.sessionRoot);
  await requireFrozenControl(session);
  const attestation = await loadAttestation(options.sessionRoot, session);
  if (
    session.status !== "awaiting-verification" ||
    session.recordedCount !== RECORD_COUNT ||
    session.activeArm !== null
  ) {
    throw new Error("exactly 24 raw records are required before verify");
  }

  const recordsDirectory = resolve(options.sessionRoot, "records");
  const expectedNames = session.schedule.map(({ sequence }) => recordFileName(sequence));
  const actualNames = (await readdir(recordsDirectory)).sort();
  if (!sameJson(actualNames, expectedNames)) {
    throw new Error("raw record inventory must contain exactly the fixed 24 sequence files");
  }
  const records = [];
  for (const scheduled of session.schedule) {
    const record = await readJson(
      resolve(recordsDirectory, recordFileName(scheduled.sequence)),
      `raw record ${scheduled.sequence}`,
    );
    validateRecord(
      record,
      scheduled,
      attestation.operator.id,
      session.timeLimitMilliseconds,
    );
    records.push(record);
  }
  await requireFrozenControl(session);

  const raw = {
    ...RAW_IDENTITY,
    benchmarkRevision: session.benchmarkRevision,
    benchmarkFrozenAt: session.benchmarkFrozenAt,
    crossedOrder: CROSSED_ORDER,
    timeLimitMilliseconds: session.timeLimitMilliseconds,
    frozenControl: session.frozenControl,
    operator: attestation.operator,
    operatorAttestation: {
      ...attestation.attestation,
      attestedAt: attestation.attestedAt,
    },
    recordCount: RECORD_COUNT,
    records,
  };
  const verification = {
    contractVersion: CONTRACT_VERSION,
    status: "raw-results-fixed",
    lane: "developer",
    scored: false,
    recordCount: RECORD_COUNT,
    crossedOrder: CROSSED_ORDER,
    timeLimitMilliseconds: session.timeLimitMilliseconds,
    freshContextAttestations: RECORD_COUNT,
    toolUseAttestations: RECORD_COUNT,
    answerAuthorshipAttestations: RECORD_COUNT,
    operatorAttestationRecorded: true,
    benchmarkControlUnchanged: true,
    rawContractValid: true,
  };
  await Promise.all([
    writeJson(resolve(options.sessionRoot, RAW_RESULT_FILE), raw, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeJson(resolve(options.sessionRoot, VERIFICATION_FILE), verification, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  await replaceJson(resolve(options.sessionRoot, SESSION_FILE), {
    ...session,
    status: "raw-results-fixed",
  });
  process.stdout.write(`${JSON.stringify({
    command: "verify",
    status: "raw-results-fixed",
    recordCount: RECORD_COUNT,
    scored: false,
    rawResultFile: resolve(options.sessionRoot, RAW_RESULT_FILE),
  })}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") return prepareCommand(args);
  if (command === "attest") return attestCommand(args);
  if (command === "show") return showCommand(args);
  if (command === "record") return recordCommand(args);
  if (command === "status") return statusCommand(args);
  if (command === "verify") return verifyCommand(args);
  throw new Error(
    "Usage: node ua-developer-comparison.mjs " +
    "<prepare|attest|show|record|status|verify> " +
    "--artifact-root PATH --session-root PATH " +
    "[--time-limit-minutes N|--attestation-file PATH|--fresh-context true|--answer-file PATH]",
  );
}

const isCli = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`ua-developer-comparison: ${error.message}\n`);
    process.exitCode = 1;
  });
}
