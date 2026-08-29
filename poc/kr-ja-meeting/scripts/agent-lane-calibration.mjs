#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ANALYSIS_SNAPSHOT,
  CALIBRATION_QUESTION,
  loadCurrentPilotArtifact,
} from "./understand-anything-pilot.mjs";
import {
  assertIsolatedMaterialRoot,
  buildCodexPermissionConfig,
  copyTrackedCorpus,
  copyRegularFileWithin,
  createIsolatedMaterialRoot,
  initializeEmptyPilotOutput,
  requireApprovedPilotOutput,
  spawnCodexChild,
} from "./pilot-local-safety.mjs";

const PROVIDER = "current-codex-provider-only";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const ANSWER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "question",
    "affectedBehavior",
    "codeEvidence",
    "testEvidence",
    "graphNodeIds",
    "graphRelations",
  ],
  properties: {
    status: { type: "string", enum: ["answered", "unknown"] },
    question: { type: "string" },
    affectedBehavior: { type: "string" },
    codeEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "symbol"],
        properties: {
          path: { type: "string" },
          symbol: { type: "string" },
        },
      },
    },
    testEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "test"],
        properties: {
          path: { type: "string" },
          test: { type: "string" },
        },
      },
    },
    graphNodeIds: { type: "array", items: { type: "string" } },
    graphRelations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "type", "target"],
        properties: {
          source: { type: "string" },
          type: { type: "string" },
          target: { type: "string" },
        },
      },
    },
  },
};

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[option.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function answerArrays(answer) {
  for (const field of ["codeEvidence", "testEvidence", "graphNodeIds", "graphRelations"]) {
    if (!Array.isArray(answer[field])) throw new Error(`Evidence Answer ${field} must be an array`);
  }
}

function relationKey(relation) {
  return `${relation.source}\u0000${relation.type}\u0000${relation.target}`;
}

function symbolTokens(symbol) {
  return String(symbol)
    .split(/[^A-Za-z0-9_$]+/)
    .filter((token) => token && !/^lines?$/i.test(token) && !/^\d+$/.test(token));
}

function buildPrompt({ graphPath, snapshotRoot }) {
  return `You are the Agent Lane operator for one 비채점 calibration (UN-SCORED).\n\n` +
    `Provider boundary: use only this current OpenAI Codex session. Do not call another model, ` +
    `provider, network service, or local model.\n` +
    `Fresh-context boundary: this ephemeral session has no previous pilot answers.\n` +
    `Read-only inputs:\n` +
    `- knowledge graph: ${graphPath}\n` +
    `- exact Analysis Snapshot: ${snapshotRoot}\n\n` +
    `Question:\n${CALIBRATION_QUESTION}\n\n` +
    `Procedure:\n` +
    `1. Search only the local knowledge graph for relevant nodes and exact edges.\n` +
    `2. Verify every named file, symbol, and test in the Analysis Snapshot before citing it.\n` +
    `3. Return one Evidence Answer naming affected behavior, exact code file and symbol, related test, ` +
    `graph node IDs, and only relations that exist verbatim in graph.edges.\n` +
    `4. If the graph and source do not establish the answer, set status to "unknown", ` +
    `affectedBehavior to "unknown", and every evidence array to []. Never guess.\n` +
    `5. Do not read any Impact Benchmark, scoring script, expected answer, previous calibration answer, ` +
    `or scored result. This run is calibration only.\n` +
    `6. Return only JSON matching the supplied output schema.\n`;
}

export function buildCodexExecArgs({ snapshotRoot, schemaPath, answerPath }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    ...buildCodexPermissionConfig(snapshotRoot),
    "--cd",
    resolve(snapshotRoot),
    "--output-schema",
    resolve(schemaPath),
    "--output-last-message",
    resolve(answerPath),
    "-",
  ];
}

export async function prepareCalibration({
  pilotArtifactRoot,
  outputDir,
  now = () => new Date().toISOString(),
  loadPilotInputs = loadCurrentPilotArtifact,
  createMaterialRoot = () => createIsolatedMaterialRoot("ua-calibration-material-"),
}) {
  const artifactRoot = await requireApprovedPilotOutput(
    pilotArtifactRoot,
    "Agent calibration Pilot Artifact",
  );
  const requestedResultRoot = await requireApprovedPilotOutput(
    outputDir,
    "Agent calibration output",
  );
  const inputs = await loadPilotInputs(artifactRoot);
  const { plan, manifest, graphPath, graph } = inputs;
  if (plan.provider !== PROVIDER) {
    throw new Error(`Agent Lane provider mismatch: expected ${PROVIDER}, got ${plan.provider ?? "missing"}`);
  }
  if (plan.analysisSnapshot !== ANALYSIS_SNAPSHOT || graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT) {
    throw new Error("Agent Lane requires the pinned Analysis Snapshot graph");
  }

  if (!Array.isArray(manifest.included)) {
    throw new Error("Agent Lane calibration requires the Analysis Corpus manifest");
  }
  const resultRoot = await initializeEmptyPilotOutput(
    requestedResultRoot,
    "Agent calibration output",
  );
  const materialRoot = await createMaterialRoot();
  await mkdir(materialRoot, { recursive: true });
  await Promise.all([
    copyRegularFileWithin({
      sourceRoot: inputs.graphDirectory,
      relativePath: "knowledge-graph.json",
      targetRoot: materialRoot,
      targetPath: resolve(materialRoot, "knowledge-graph.json"),
    }),
    copyTrackedCorpus({
      snapshotRoot: inputs.snapshotRoot,
      included: manifest.included,
      targetRoot: materialRoot,
    }),
  ]);
  const promptPath = resolve(resultRoot, "calibration-prompt.md");
  const schemaPath = resolve(resultRoot, "evidence-answer.schema.json");
  const protocolPath = resolve(resultRoot, "calibration-protocol.json");
  const answerPath = resolve(resultRoot, "raw-answer.json");
  const protocol = {
    contractVersion: 1,
    scored: false,
    question: CALIBRATION_QUESTION,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    provider: PROVIDER,
    graphPath: resolve(materialRoot, "knowledge-graph.json"),
    snapshotRoot: resolve(plan.snapshotCheckout),
    materialRoot,
    pilotArtifact: {
      planSha256: inputs.planSha256,
      manifestSha256: inputs.manifestSha256,
      corpusDigestSha256: inputs.corpusDigestSha256,
      graphSha256: inputs.graphSha256,
    },
    preparedAt: now(),
    freshContext: {
      required: true,
      mechanism: "codex exec --ephemeral --ignore-user-config with material-only filesystem permissions",
      resumeOrForkAllowed: false,
    },
    timing: {
      startsImmediatelyBeforeProviderInvocation: true,
      stopsWhenFinalSchemaAnswerIsWritten: true,
      unit: "milliseconds",
    },
    benchmarkExposure: "calibration-question-only",
    expectedAnswersExposed: false,
  };
  await Promise.all([
    writeFile(
      promptPath,
      buildPrompt({ graphPath: "./knowledge-graph.json", snapshotRoot: "." }),
      "utf8",
    ),
    writeFile(schemaPath, `${JSON.stringify(ANSWER_SCHEMA, null, 2)}\n`, "utf8"),
    writeFile(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`, "utf8"),
  ]);
  return {
    promptPath,
    schemaPath,
    protocolPath,
    answerPath,
    outputDir: resultRoot,
    snapshotRoot: materialRoot,
    materialRoot,
    pilotArtifact: protocol.pilotArtifact,
  };
}

export async function verifyEvidenceAnswer({
  pilotArtifactRoot,
  answer,
  answerTimeMs,
  loadPilotInputs = loadCurrentPilotArtifact,
  pilotInputs,
}) {
  const artifactRoot = await requireApprovedPilotOutput(
    pilotArtifactRoot,
    "Agent calibration Pilot Artifact",
  );
  const inputs = pilotInputs ?? await loadPilotInputs(artifactRoot);
  const { plan, manifest, graph } = inputs;
  if (plan.provider !== PROVIDER) throw new Error("Agent Lane provider policy changed");
  if (plan.analysisSnapshot !== ANALYSIS_SNAPSHOT || graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT) {
    throw new Error("Evidence Answer graph is not the pinned Analysis Snapshot");
  }
  if (!Number.isFinite(answerTimeMs) || answerTimeMs <= 0) {
    throw new Error("Evidence Answer requires a positive measured answerTimeMs");
  }
  if (answer.question !== CALIBRATION_QUESTION) {
    throw new Error("Evidence Answer question is not the unscored calibration");
  }
  if (!new Set(["answered", "unknown"]).has(answer.status)) {
    throw new Error("Evidence Answer status must be answered or unknown");
  }
  answerArrays(answer);

  const included = new Map((manifest.included ?? []).map((entry) => [entry.path, entry]));
  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const relations = new Set((graph.edges ?? []).map(relationKey));

  for (const evidence of [...answer.codeEvidence, ...answer.testEvidence]) {
    if (!included.has(evidence.path) || !(await isRegularFile(resolve(inputs.snapshotRoot, evidence.path)))) {
      throw new Error(`invented file evidence: ${evidence.path ?? "missing"}`);
    }
  }
  for (const evidence of answer.testEvidence) {
    if (included.get(evidence.path)?.category !== "test") {
      throw new Error(`test evidence is not in the test corpus: ${evidence.path}`);
    }
  }
  for (const nodeId of answer.graphNodeIds) {
    if (!nodeById.has(nodeId)) throw new Error(`invented graph node: ${nodeId}`);
  }
  for (const relation of answer.graphRelations) {
    if (!relations.has(relationKey(relation))) {
      throw new Error(`invented graph relation: ${relation.source} --[${relation.type}]--> ${relation.target}`);
    }
  }

  if (answer.status === "unknown") {
    const hasClaim = answer.affectedBehavior !== "unknown" ||
      answer.codeEvidence.length > 0 || answer.testEvidence.length > 0 ||
      answer.graphNodeIds.length > 0 || answer.graphRelations.length > 0;
    if (hasClaim) throw new Error("unknown Evidence Answer must not retain unsupported claims");
    return { status: "unknown", passed: true, answerTimeMs, errors: [] };
  }

  const insufficiencies = [];
  if (!answer.affectedBehavior || answer.affectedBehavior === "unknown") {
    insufficiencies.push("affected behavior is missing");
  }
  if (answer.codeEvidence.length === 0) insufficiencies.push("code evidence is missing");
  if (answer.testEvidence.length === 0) insufficiencies.push("test evidence is missing");
  if (answer.graphNodeIds.length === 0) insufficiencies.push("graph node evidence is missing");

  for (const evidence of answer.codeEvidence) {
    const source = await readFile(resolve(inputs.snapshotRoot, evidence.path), "utf8");
    const tokens = symbolTokens(evidence.symbol);
    if (tokens.length === 0 || tokens.some((token) => !source.includes(token))) {
      insufficiencies.push(`symbol not established in source: ${evidence.path}#${evidence.symbol}`);
    }
    if (![...nodeById.values()].some((node) => node.filePath === evidence.path)) {
      insufficiencies.push(`code path has no graph node: ${evidence.path}`);
    }
  }
  for (const evidence of answer.testEvidence) {
    const source = await readFile(resolve(inputs.snapshotRoot, evidence.path), "utf8");
    if (!evidence.test || !source.includes(evidence.test)) {
      insufficiencies.push(`test not established in source: ${evidence.path}#${evidence.test}`);
    }
    if (![...nodeById.values()].some((node) => node.filePath === evidence.path)) {
      insufficiencies.push(`test path has no graph node: ${evidence.path}`);
    }
  }

  if (insufficiencies.length > 0) {
    return {
      status: "unknown",
      passed: true,
      answerTimeMs,
      errors: [],
      unknownReasons: insufficiencies,
    };
  }
  return { status: "answered", passed: true, answerTimeMs, errors: [] };
}

export async function runCalibration({
  pilotArtifactRoot,
  outputDir,
  codexExecutable = "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loadPilotInputs = loadCurrentPilotArtifact,
  createMaterialRoot = () => createIsolatedMaterialRoot("ua-calibration-material-"),
}) {
  const prepared = await prepareCalibration({
    pilotArtifactRoot,
    outputDir,
    loadPilotInputs,
    createMaterialRoot,
  });
  await assertIsolatedMaterialRoot(prepared.materialRoot);
  const resultRoot = prepared.outputDir;
  const prompt = await readFile(prepared.promptPath, "utf8");
  const args = buildCodexExecArgs({
    snapshotRoot: prepared.snapshotRoot,
    schemaPath: prepared.schemaPath,
    answerPath: prepared.answerPath,
  });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = await spawnCodexChild({
    executable: codexExecutable,
    args,
    prompt,
    timeoutMs,
  });
  const answerTimeMs = Math.round((performance.now() - start) * 100) / 100;
  const finishedAt = new Date().toISOString();
  const executionPath = resolve(resultRoot, "calibration-execution.json");
  if (result.error || result.timedOut || result.status !== 0) {
    const processError = result.error?.code ?? (result.error ? "UNKNOWN" : null);
    await writeFile(executionPath, `${JSON.stringify({
      status: result.timedOut ? "timed-out" : "failed",
      provider: PROVIDER,
      freshContext: true,
      startedAt,
      finishedAt,
      answerTimeMs,
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.timedOut,
      processError,
    }, null, 2)}\n`, "utf8");
    if (result.timedOut) {
      throw new Error(`fresh Codex calibration timed out after ${timeoutMs}ms`);
    }
    if (result.error) {
      throw new Error(`fresh Codex calibration execution error (${processError})`);
    }
    throw new Error(`fresh Codex calibration failed with exit ${result.status ?? result.signal ?? "unknown"}`);
  }
  const answer = await readJson(prepared.answerPath);
  const currentInputs = await loadPilotInputs(pilotArtifactRoot);
  if (
    prepared.pilotArtifact.planSha256 !== currentInputs.planSha256 ||
    prepared.pilotArtifact.manifestSha256 !== currentInputs.manifestSha256 ||
    prepared.pilotArtifact.corpusDigestSha256 !== currentInputs.corpusDigestSha256 ||
    prepared.pilotArtifact.graphSha256 !== currentInputs.graphSha256
  ) {
    throw new Error("Pilot Artifact changed during Agent calibration");
  }
  const verification = await verifyEvidenceAnswer({
    pilotArtifactRoot,
    answer,
    answerTimeMs,
    pilotInputs: currentInputs,
  });
  await Promise.all([
    writeFile(resolve(resultRoot, "calibration-answer.json"), `${JSON.stringify(answer, null, 2)}\n`, "utf8"),
    writeFile(resolve(resultRoot, "calibration-verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8"),
    writeFile(executionPath, `${JSON.stringify({
      status: "completed",
      provider: PROVIDER,
      freshContext: true,
      invocation: "codex exec --ephemeral --ignore-user-config with material-only filesystem permissions",
      startedAt,
      finishedAt,
      answerTimeMs,
      exitCode: 0,
      timedOut: false,
      processError: null,
      scored: false,
    }, null, 2)}\n`, "utf8"),
  ]);
  return { answer, verification, answerTimeMs, outputDir: resultRoot };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  const pilotArtifactRoot = resolve(options["pilot-artifact-root"] ?? "");
  const outputDir = resolve(options["output-dir"] ?? "");
  if (!options["pilot-artifact-root"] || !options["output-dir"]) {
    throw new Error("--pilot-artifact-root and --output-dir are required");
  }
  if (command === "prepare") {
    const prepared = await prepareCalibration({ pilotArtifactRoot, outputDir });
    process.stdout.write(`${JSON.stringify({ command, scored: false, ...prepared })}\n`);
    return;
  }
  if (command === "run") {
    const result = await runCalibration({ pilotArtifactRoot, outputDir });
    process.stdout.write(`${JSON.stringify({
      command,
      scored: false,
      status: result.verification.status,
      answerTimeMs: result.answerTimeMs,
      outputDir: result.outputDir,
    })}\n`);
    return;
  }
  if (command === "verify") {
    if (!options.answer || !options["answer-time-ms"]) {
      throw new Error("verify requires --answer and --answer-time-ms");
    }
    const answer = await readJson(resolve(options.answer));
    const verification = await verifyEvidenceAnswer({
      pilotArtifactRoot,
      answer,
      answerTimeMs: Number(options["answer-time-ms"]),
    });
    const verifiedOutputDir = await requireApprovedPilotOutput(
      outputDir,
      "Agent calibration verification output",
    );
    await mkdir(verifiedOutputDir, { recursive: true });
    await writeFile(
      resolve(verifiedOutputDir, "calibration-verification.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify({ command, scored: false, ...verification })}\n`);
    return;
  }
  throw new Error(
    "Usage: node agent-lane-calibration.mjs <prepare|run|verify> " +
    "--pilot-artifact-root PATH --output-dir PATH",
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`agent-lane-calibration: ${error.message}\n`);
    process.exitCode = 1;
  });
}
