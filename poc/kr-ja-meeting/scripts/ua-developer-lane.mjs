#!/usr/bin/env node

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ANALYSIS_SNAPSHOT,
  CALIBRATION_QUESTION,
  UPSTREAM_COMMIT,
} from "./understand-anything-pilot.mjs";

const QUESTION_ID = "ain-7640-calibration";
const CALIBRATION_IDENTITY = Object.freeze({
  lane: "developer",
  runKind: "unscored-calibration",
  scored: false,
  questionId: QUESTION_ID,
  analysisSnapshot: ANALYSIS_SNAPSHOT,
});
const LAYER_IDS = [
  "layer:ui",
  "layer:application-api",
  "layer:realtime-integration",
  "layer:meeting-domain",
];
const RELATIONSHIPS = [
  {
    id: "application-to-translation",
    source: "file:poc/kr-ja-meeting/src/server.mjs",
    target: "file:poc/kr-ja-meeting/src/live-translation-bridge.mjs",
    type: "imports",
  },
  {
    id: "application-to-provider",
    source: "file:poc/kr-ja-meeting/src/server.mjs",
    target: "file:poc/kr-ja-meeting/src/gemini-live-socket.mjs",
    type: "imports",
  },
  {
    id: "application-to-audio-gateway",
    source: "file:poc/kr-ja-meeting/src/server.mjs",
    target: "file:poc/kr-ja-meeting/src/livekit-audio-gateway.mjs",
    type: "imports",
  },
  {
    id: "translation-to-regression-test",
    source: "file:poc/kr-ja-meeting/src/live-translation-bridge.mjs",
    target: "file:poc/kr-ja-meeting/test/live-translation-bridge.test.mjs",
    type: "tested_by",
  },
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

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid at ${path}: ${error.message}`);
  }
}

function gitText(repo, args, label) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr.trim() || `git ${args.join(" ")} exited ${result.status}`}`,
    );
  }
  return result.stdout;
}

function requireDescendant(parent, child, label) {
  const pathFromParent = relative(parent, child);
  if (!pathFromParent || pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
    throw new Error(`${label} must remain inside its allowed parent directory`);
  }
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireCalibrationIdentity(value, label) {
  for (const [key, expected] of Object.entries(CALIBRATION_IDENTITY)) {
    if (value[key] !== expected) {
      throw new Error(`${label} has invalid ${key}`);
    }
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDeclaredSymbol(contents, symbol) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return false;
  const escaped = escapeRegularExpression(symbol);
  return [
    new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`\\b(?:class|const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:async\\s+def|def|class)\\s+${escaped}\\b`),
  ].some((pattern) => pattern.test(contents));
}

function isDeclaredTest(contents, testName) {
  const escaped = escapeRegularExpression(testName);
  return new RegExp(`\\b(?:test|it)\\s*\\(\\s*(["'\x60])${escaped}\\1`).test(contents);
}

async function loadPilotArtifact(artifactRoot) {
  const plan = await readJson(resolve(artifactRoot, "pilot-plan.json"), "pilot plan");
  const prepared = await readJson(
    resolve(artifactRoot, "prepare-result.json"),
    "prepare evidence",
  );
  const verification = await readJson(
    resolve(artifactRoot, "artifact-verification.json"),
    "artifact verification",
  );
  const manifest = await readJson(
    resolve(artifactRoot, "corpus-manifest.json"),
    "corpus manifest",
  );

  if (
    plan.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    manifest.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    verification.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    prepared.snapshotHead !== ANALYSIS_SNAPSHOT
  ) {
    throw new Error(`Pilot Artifact must use Analysis Snapshot ${ANALYSIS_SNAPSHOT}`);
  }
  if (plan.upstream?.commit !== UPSTREAM_COMMIT || prepared.upstreamHead !== UPSTREAM_COMMIT) {
    throw new Error(`Pilot Artifact must use reviewed upstream commit ${UPSTREAM_COMMIT}`);
  }
  if (
    verification.passed !== true ||
    prepared.snapshotClean !== true ||
    prepared.globalInstallerUsed !== false ||
    prepared.symlinksCreated !== false ||
    plan.upstream?.installScope !== "artifact-local" ||
    plan.provider !== "current-codex-provider-only"
  ) {
    throw new Error("Pilot Artifact verification or local-only execution policy is not satisfied");
  }
  if (!Array.isArray(manifest.included)) {
    throw new Error("Pilot Artifact corpus manifest must contain included[]");
  }

  const snapshotCheckout = resolve(plan.snapshotCheckout);
  const upstreamCheckout = resolve(plan.upstream.checkout);
  requireDescendant(artifactRoot, snapshotCheckout, "snapshot checkout");
  requireDescendant(artifactRoot, upstreamCheckout, "upstream checkout");
  const snapshotHead = gitText(snapshotCheckout, ["rev-parse", "HEAD"], "snapshot HEAD check").trim();
  const upstreamHead = gitText(upstreamCheckout, ["rev-parse", "HEAD"], "upstream HEAD check").trim();
  if (snapshotHead !== ANALYSIS_SNAPSHOT) {
    throw new Error(`Snapshot current HEAD is ${snapshotHead}; expected ${ANALYSIS_SNAPSHOT}`);
  }
  if (upstreamHead !== UPSTREAM_COMMIT) {
    throw new Error(`Upstream current HEAD is ${upstreamHead}; expected ${UPSTREAM_COMMIT}`);
  }
  const snapshotStatus = gitText(
    snapshotCheckout,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "snapshot tracked-state check",
  );
  if (snapshotStatus.trim()) {
    throw new Error(`Snapshot checkout has tracked changes: ${snapshotStatus.trim()}`);
  }
  const upstreamSourceChanges = gitText(
    upstreamCheckout,
    [
      "diff", "--name-only", "HEAD", "--",
      "understand-anything-plugin/packages/core",
      "understand-anything-plugin/packages/dashboard",
    ],
    "upstream dashboard source check",
  );
  if (upstreamSourceChanges.trim()) {
    throw new Error(`Pinned upstream dashboard source has tracked changes: ${upstreamSourceChanges.trim()}`);
  }
  const graphDirectory = plan.artifacts?.graphDirectory
    ? resolve(plan.artifacts.graphDirectory)
    : resolve(snapshotCheckout, ".ua");
  requireDescendant(snapshotCheckout, graphDirectory, "graph directory");
  const graph = await readJson(
    resolve(graphDirectory, "knowledge-graph.json"),
    "knowledge graph",
  );
  if (graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT) {
    throw new Error(`Knowledge graph must use Analysis Snapshot ${ANALYSIS_SNAPSHOT}`);
  }
  if (
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.layers) ||
    !Array.isArray(graph.tour)
  ) {
    throw new Error("Knowledge graph must contain nodes, edges, layers, and tour arrays");
  }

  const nodeIds = new Set(graph.nodes.map(({ id }) => id));
  const layerIds = new Set(graph.layers.map(({ id }) => id));
  for (const layerId of LAYER_IDS) {
    if (!layerIds.has(layerId)) throw new Error(`Knowledge graph lacks major layer ${layerId}`);
  }
  for (const relationship of RELATIONSHIPS) {
    if (!nodeIds.has(relationship.source) || !nodeIds.has(relationship.target)) {
      throw new Error(`Knowledge graph lacks nodes for ${relationship.id}`);
    }
    const present = graph.edges.some((edge) =>
      edge.source === relationship.source &&
      edge.target === relationship.target &&
      edge.type === relationship.type
    );
    if (!present) throw new Error(`Knowledge graph lacks major relationship ${relationship.id}`);
  }

  return { plan, manifest, graph, snapshotCheckout, graphDirectory };
}

async function loadSession(artifactRoot, sessionRoot) {
  requireDescendant(artifactRoot, sessionRoot, "session root");
  const session = await readJson(resolve(sessionRoot, "session.json"), "calibration session");
  requireCalibrationIdentity(session, "Calibration session");
  if (
    session.artifactRoot !== artifactRoot ||
    session.question !== CALIBRATION_QUESTION ||
    !Number.isFinite(session.startedAtMilliseconds) ||
    new Date(session.startedAtMilliseconds).toISOString() !== session.startedAt
  ) {
    throw new Error("Calibration session identity or unscored contract is invalid");
  }
  return session;
}

async function validateKnownEvidence(answer, artifact) {
  requireExactKeys(answer.evidence, new Set(["behavior", "code", "tests"]), "evidence");
  requireNonEmptyText(answer.evidence.behavior, "evidence.behavior");
  if (!Array.isArray(answer.evidence.code) || answer.evidence.code.length === 0) {
    throw new Error("evidence.code must contain at least one actual file and symbol");
  }
  if (!Array.isArray(answer.evidence.tests) || answer.evidence.tests.length === 0) {
    throw new Error("evidence.tests must contain at least one related test");
  }

  const manifestByPath = new Map(
    artifact.manifest.included.map((entry) => [entry.path, entry]),
  );
  const graphFilePaths = new Set(
    artifact.graph.nodes
      .filter(({ type, filePath }) => type === "file" && typeof filePath === "string")
      .map(({ filePath }) => filePath),
  );

  const validateReference = (reference, kind) => {
    const fragmentKey = kind === "code" ? "symbol" : "test";
    requireExactKeys(reference, new Set(["path", fragmentKey]), `evidence.${kind} item`);
    const path = requireNonEmptyText(reference.path, `evidence.${kind}.path`);
    const fragment = requireNonEmptyText(reference[fragmentKey], `evidence.${kind}.${fragmentKey}`);
    if (path.includes("\\") || isAbsolute(path)) {
      throw new Error(`Evidence path must be canonical and relative: ${path}`);
    }
    const expectedCategory = kind === "code" ? "code" : "test";
    if (manifestByPath.get(path)?.category !== expectedCategory) {
      throw new Error(`Evidence path is not a ${expectedCategory} file in the fixed corpus: ${path}`);
    }
    if (!graphFilePaths.has(path)) {
      throw new Error(`Evidence path has no file node in the fixed graph: ${path}`);
    }
    const contents = gitText(
      artifact.snapshotCheckout,
      ["show", `${ANALYSIS_SNAPSHOT}:${path}`],
      `immutable evidence read for ${path}`,
    );
    if (kind === "code") {
      const graphDeclaresSymbol = artifact.graph.nodes.some((node) =>
        node.type !== "file" && node.filePath === path && node.name === fragment
      );
      if (!graphDeclaresSymbol && !isDeclaredSymbol(contents, fragment)) {
        throw new Error(`Evidence is not a declared symbol in ${path}: ${fragment}`);
      }
    } else if (!isDeclaredTest(contents, fragment)) {
      throw new Error(`Evidence is not a declared test in ${path}: ${fragment}`);
    }
    return path;
  };

  const codePaths = answer.evidence.code.map((reference) => validateReference(reference, "code"));
  const testPaths = answer.evidence.tests.map((reference) => validateReference(reference, "tests"));
  const related = (codePath, testPath) => artifact.graph.edges.some((edge) =>
    edge.source === `file:${codePath}` &&
    edge.target === `file:${testPath}` &&
    edge.type === "tested_by"
  );
  for (const codePath of codePaths) {
    if (!testPaths.some((testPath) => related(codePath, testPath))) {
      throw new Error(`No selected test has a tested_by relation from ${codePath}`);
    }
  }
  for (const testPath of testPaths) {
    if (!codePaths.some((codePath) => related(codePath, testPath))) {
      throw new Error(`Selected test has no tested_by relation from the code evidence: ${testPath}`);
    }
  }
}

async function validateAnswer(answer, artifact) {
  requireExactKeys(answer, new Set(["answer", "evidence", "unknown"]), "answer file");
  if (typeof answer.unknown !== "boolean") throw new Error("unknown must be a boolean");
  const answerText = requireNonEmptyText(answer.answer, "answer");
  requireExactKeys(answer.evidence, new Set(["behavior", "code", "tests"]), "evidence");

  if (answer.unknown) {
    if (
      answerText !== "unknown" ||
      answer.evidence.behavior !== "unknown" ||
      !Array.isArray(answer.evidence.code) ||
      answer.evidence.code.length !== 0 ||
      !Array.isArray(answer.evidence.tests) ||
      answer.evidence.tests.length !== 0
    ) {
      throw new Error(
        "unknown answers must use answer/evidence.behavior='unknown' with empty code/tests",
      );
    }
    return;
  }

  if (answerText === "unknown") throw new Error("A known answer cannot use the unknown sentinel");
  await validateKnownEvidence(answer, artifact);
}

async function beginCommand(args) {
  const options = parseOptions(args, new Set(["artifact-root", "session-root"]));
  if (!options["artifact-root"]) throw new Error("--artifact-root is required");
  const artifactRoot = resolve(options["artifact-root"]);
  const sessionRoot = resolve(
    options["session-root"] ?? resolve(artifactRoot, "developer-lane-calibration"),
  );
  requireDescendant(artifactRoot, sessionRoot, "session root");
  const artifact = await loadPilotArtifact(artifactRoot);

  await mkdir(sessionRoot);
  const template = {
    answer: "",
    unknown: false,
    evidence: {
      behavior: "",
      code: [{ path: "", symbol: "" }],
      tests: [{ path: "", test: "" }],
    },
  };
  await writeFile(
    resolve(sessionRoot, "answer-template.json"),
    `${JSON.stringify(template, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const startedAtMilliseconds = Date.now();
  process.stdout.write(`UNSCORED CALIBRATION\n${CALIBRATION_QUESTION}\n`);
  const session = {
    contractVersion: 1,
    status: "active",
    ...CALIBRATION_IDENTITY,
    question: CALIBRATION_QUESTION,
    artifactRoot,
    snapshotCheckout: artifact.snapshotCheckout,
    graphDirectory: artifact.graphDirectory,
    startedAt: new Date(startedAtMilliseconds).toISOString(),
    startedAtMilliseconds,
    exploration: {
      layerIds: [...LAYER_IDS],
      relationships: RELATIONSHIPS.map((relationship) => ({ ...relationship })),
    },
  };
  await writeFile(
    resolve(sessionRoot, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  process.stdout.write(`${JSON.stringify({
    command: "begin",
    sessionRoot,
    scored: false,
    startedAtMilliseconds,
    exploration: session.exploration,
  })}\n`);
}

async function submitCommand(args) {
  const options = parseOptions(
    args,
    new Set(["artifact-root", "session-root", "answer-file"]),
  );
  if (!options["artifact-root"] || !options["session-root"] || !options["answer-file"]) {
    throw new Error("submit requires --artifact-root, --session-root, and --answer-file");
  }
  const artifactRoot = resolve(options["artifact-root"]);
  const sessionRoot = resolve(options["session-root"]);
  const answerFile = resolve(options["answer-file"]);
  requireDescendant(sessionRoot, answerFile, "answer file");
  const artifact = await loadPilotArtifact(artifactRoot);
  const session = await loadSession(artifactRoot, sessionRoot);
  if (session.status !== "active") throw new Error("Calibration session is not active");
  const answer = await readJson(answerFile, "developer answer");
  await validateAnswer(answer, artifact);

  const completedAtMilliseconds = Date.now();
  const elapsedMilliseconds = completedAtMilliseconds - session.startedAtMilliseconds;
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    throw new Error("Calibration clock moved backwards; answer time cannot be trusted");
  }
  const result = {
    contractVersion: 1,
    ...CALIBRATION_IDENTITY,
    answer: answer.answer.trim(),
    unknown: answer.unknown,
    evidence: answer.evidence,
    answerTimeMs: Math.max(1, elapsedMilliseconds),
    startedAt: session.startedAt,
    completedAt: new Date(completedAtMilliseconds).toISOString(),
    completedAtMilliseconds,
  };
  await writeFile(
    resolve(sessionRoot, "calibration-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    resolve(sessionRoot, "session.json"),
    `${JSON.stringify({ ...session, status: "completed" }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({
    command: "submit",
    sessionRoot,
    scored: false,
    unknown: result.unknown,
    answerTimeMs: result.answerTimeMs,
  })}\n`);
}

async function verifyCommand(args) {
  const options = parseOptions(args, new Set(["artifact-root", "session-root"]));
  if (!options["artifact-root"] || !options["session-root"]) {
    throw new Error("verify requires --artifact-root and --session-root");
  }
  const artifactRoot = resolve(options["artifact-root"]);
  const sessionRoot = resolve(options["session-root"]);
  const artifact = await loadPilotArtifact(artifactRoot);
  const session = await loadSession(artifactRoot, sessionRoot);
  const result = await readJson(
    resolve(sessionRoot, "calibration-result.json"),
    "calibration result",
  );
  requireExactKeys(result, new Set([
    "analysisSnapshot",
    "answer",
    "answerTimeMs",
    "completedAt",
    "completedAtMilliseconds",
    "contractVersion",
    "evidence",
    "lane",
    "questionId",
    "runKind",
    "scored",
    "startedAt",
    "unknown",
  ]), "calibration result");
  const rawAnswerTimeMs = result.completedAtMilliseconds - session.startedAtMilliseconds;
  const expectedAnswerTimeMs = Math.max(1, rawAnswerTimeMs);
  requireCalibrationIdentity(result, "Calibration result");
  if (
    session.status !== "completed" ||
    result.contractVersion !== 1 ||
    result.startedAt !== session.startedAt ||
    !Number.isFinite(result.completedAtMilliseconds) ||
    new Date(result.completedAtMilliseconds).toISOString() !== result.completedAt ||
    !Number.isFinite(rawAnswerTimeMs) ||
    rawAnswerTimeMs < 0 ||
    !Number.isFinite(result.answerTimeMs) ||
    result.answerTimeMs <= 0 ||
    result.answerTimeMs !== expectedAnswerTimeMs
  ) {
    throw new Error("Calibration result identity, timing, or unscored contract is invalid");
  }
  await validateAnswer({
    answer: result.answer,
    unknown: result.unknown,
    evidence: result.evidence,
  }, artifact);

  const report = {
    contractVersion: 1,
    passed: true,
    ...CALIBRATION_IDENTITY,
    unknown: result.unknown,
    answerTimeMs: result.answerTimeMs,
    evidenceVerified: result.unknown ? "unknown" : true,
  };
  await writeFile(
    resolve(sessionRoot, "developer-lane-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({
    command: "verify",
    sessionRoot,
    passed: true,
    scored: false,
  })}\n`);
}

function dashboardEnvironment(graphDirectory) {
  const environment = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    BROWSER: "none",
    FORCE_COLOR: "0",
    GRAPH_DIR: graphDirectory,
    NO_COLOR: "1",
  };
}

async function dashboardCommand(args) {
  const options = parseOptions(args, new Set(["artifact-root", "port"]));
  if (!options["artifact-root"]) throw new Error("dashboard requires --artifact-root");
  const artifactRoot = resolve(options["artifact-root"]);
  const artifact = await loadPilotArtifact(artifactRoot);
  const upstreamCheckout = resolve(artifact.plan.upstream.checkout);
  requireDescendant(artifactRoot, upstreamCheckout, "upstream checkout");
  const dashboardRoot = resolve(
    upstreamCheckout,
    "understand-anything-plugin/packages/dashboard",
  );
  const viteBinary = resolve(dashboardRoot, "node_modules/.bin/vite");
  try {
    await stat(viteBinary);
  } catch (error) {
    throw new Error(
      `Artifact-local dashboard is not installed at ${viteBinary}: ${error.message}`,
    );
  }
  const [resolvedDashboardRoot, resolvedBinary] = await Promise.all([
    realpath(dashboardRoot),
    realpath(viteBinary),
  ]);
  requireDescendant(resolvedDashboardRoot, resolvedBinary, "dashboard binary");

  const viteArguments = ["--host", "127.0.0.1"];
  if (options.port) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("--port must be an integer from 1 through 65535");
    }
    viteArguments.push("--port", String(port), "--strictPort");
  }
  process.stdout.write(`${JSON.stringify({
    command: "dashboard",
    host: "127.0.0.1",
    graphDirectory: artifact.snapshotCheckout,
    upstreamCommit: UPSTREAM_COMMIT,
    installScope: "artifact-local",
  })}\n`);
  const launched = spawnSync(viteBinary, viteArguments, {
    cwd: dashboardRoot,
    env: dashboardEnvironment(artifact.snapshotCheckout),
    stdio: "inherit",
  });
  if (launched.error) throw launched.error;
  if (launched.status !== 0) {
    throw new Error(
      `Artifact-local dashboard exited ${launched.status ?? launched.signal ?? "without status"}`,
    );
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "begin") {
    await beginCommand(args);
    return;
  }
  if (command === "submit") {
    await submitCommand(args);
    return;
  }
  if (command === "verify") {
    await verifyCommand(args);
    return;
  }
  if (command === "dashboard") {
    await dashboardCommand(args);
    return;
  }
  throw new Error(
    "Usage: node ua-developer-lane.mjs <begin|submit|verify|dashboard> " +
    "--artifact-root PATH [--session-root PATH] [--answer-file PATH]",
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`ua-developer-lane: ${error.message}\n`);
    process.exitCode = 1;
  });
}
