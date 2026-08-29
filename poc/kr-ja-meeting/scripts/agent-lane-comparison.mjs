#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ANALYSIS_SNAPSHOT,
  loadCurrentPilotArtifact,
} from "./understand-anything-pilot.mjs";
import {
  buildCodexPermissionConfig,
  copyTrackedCorpus,
  copyRegularFileWithin,
  createIsolatedMaterialRoot,
  digestMaterialRoot,
  initializeEmptyPilotOutput,
  readRegularPilotFile,
  requireApprovedPilotOutput,
  requirePilotChildDirectory,
  resolvePilotChildPath,
  spawnCodexChild,
  validateIsolatedMaterialLayout,
} from "./pilot-local-safety.mjs";

const PROVIDER = "current-codex-provider-only";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const FROZEN_BENCHMARK_SHA256 = "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6";
const DEFAULT_BENCHMARK_PATH = fileURLToPath(
  new URL("../benchmark/impact-benchmark.v1.json", import.meta.url),
);

const ANSWER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["answer", "unknown", "evidence"],
  properties: {
    answer: { type: "string" },
    unknown: { type: "boolean" },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["code", "tests", "relations"],
      properties: {
        code: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "symbol"],
            properties: { path: { type: "string" }, symbol: { type: "string" } },
          },
        },
        tests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "test"],
            properties: { path: { type: "string" }, test: { type: "string" } },
          },
        },
        relations: {
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
    },
  },
};

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const name = option.slice(2);
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function readJson(path, label = path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error.message}`);
  }
}

async function regularFile(path) {
  try {
    const fileStat = await lstat(path);
    return fileStat.isFile() && !fileStat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function relationKey(relation) {
  return `${relation.source}\u0000${relation.type}\u0000${relation.target}`;
}

function relationLabel(relation) {
  return `${relation.source} --[${relation.type}]--> ${relation.target}`;
}

function symbolTokens(value) {
  return String(value)
    .split(/[^A-Za-z0-9_$]+/)
    .filter((token) => token && !/^lines?$/i.test(token) && !/^\d+$/.test(token));
}

function validateBenchmark(benchmark) {
  if (
    benchmark.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    !benchmark.revision ||
    !benchmark.frozenAt ||
    !Array.isArray(benchmark.questions) ||
    benchmark.questions.length !== 12 ||
    new Set(benchmark.questions.map((question) => question.id)).size !== 12
  ) {
    throw new Error("Agent comparison requires the frozen twelve-question Impact Benchmark");
  }
  for (const question of benchmark.questions) {
    if (!question.id || !question.category || !question.prompt) {
      throw new Error("Every frozen question requires id, category, and prompt");
    }
  }
}

function sanitizedQuestions(benchmark) {
  return benchmark.questions.map(({ id, category, prompt }) => ({ id, category, prompt }));
}

export function validateComparisonPlanSeal({ planText, sealText, schemaText }) {
  const seal = JSON.parse(sealText);
  if (
    seal.contractVersion !== 1 ||
    seal.planSha256 !== sha256(planText) ||
    seal.schemaSha256 !== sha256(schemaText)
  ) {
    throw new Error("Raw comparison plan or schema changed after prepare");
  }
  return JSON.parse(planText);
}

export function validateComparisonPlanControls({ plan, benchmark, benchmarkText }) {
  validateBenchmark(benchmark);
  const expectedQuestions = sanitizedQuestions(benchmark);
  const expectedRuns = buildCrossedRuns(expectedQuestions, plan.timeoutMs);
  const hashFields = [
    ...Object.values(plan.pilotArtifact ?? {}),
    ...Object.values(plan.materialDigests ?? {}),
  ];
  if (
    plan.contractVersion !== 1 ||
    plan.scored !== false ||
    plan.lane !== "agent" ||
    plan.provider !== PROVIDER ||
    plan.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    plan.benchmarkRevision !== benchmark.revision ||
    plan.benchmarkFrozenAt !== benchmark.frozenAt ||
    plan.benchmarkSha256 !== sha256(benchmarkText) ||
    !Number.isInteger(plan.timeoutMs) ||
    plan.timeoutMs <= 0 ||
    plan.orderPolicy !== "odd-graph-first-even-rg-first" ||
    !Number.isFinite(Date.parse(plan.preparedAt)) ||
    hashFields.length !== 6 ||
    hashFields.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    JSON.stringify(plan.questions) !== JSON.stringify(expectedQuestions) ||
    JSON.stringify(plan.runs) !== JSON.stringify(expectedRuns)
  ) {
    throw new Error("Raw comparison plan is invalid");
  }
}

export function buildCrossedRuns(questions, timeoutMs) {
  const runs = [];
  for (const [index, question] of questions.entries()) {
    const arms = index % 2 === 0
      ? ["understandAnythingGraph", "repositorySearchRg"]
      : ["repositorySearchRg", "understandAnythingGraph"];
    for (const [armIndex, arm] of arms.entries()) {
      const sequence = runs.length + 1;
      runs.push({
        runId: `${String(sequence).padStart(2, "0")}-${question.id}-${arm === "understandAnythingGraph" ? "graph" : "rg"}`,
        sequence,
        questionId: question.id,
        arm,
        orderWithinQuestion: armIndex + 1,
        timeoutMs,
      });
    }
  }
  return runs;
}

async function loadPilotInputs(pilotArtifactRoot) {
  const artifactRoot = await requireApprovedPilotOutput(
    pilotArtifactRoot,
    "Agent comparison Pilot Artifact",
  );
  const plan = await readJson(resolve(artifactRoot, "pilot-plan.json"), "pilot plan");
  const manifest = await readJson(resolve(artifactRoot, "corpus-manifest.json"), "corpus manifest");
  const snapshotRoot = resolve(plan.snapshotCheckout ?? "");
  const graphPath = resolve(plan.artifacts?.graphDirectory ?? resolve(snapshotRoot, ".ua"), "knowledge-graph.json");
  const graph = await readJson(graphPath, "knowledge graph");
  if (
    plan.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    manifest.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT
  ) {
    throw new Error("Pilot Artifact does not use the pinned Analysis Snapshot");
  }
  if (plan.provider !== PROVIDER) {
    throw new Error(`Agent comparison requires ${PROVIDER}`);
  }
  if (!Array.isArray(manifest.included)) {
    throw new Error("Analysis Corpus manifest requires included[]");
  }
  return { artifactRoot, plan, manifest, snapshotRoot, graphPath, graph };
}

export function buildArmPrompt({ question, arm }) {
  const common =
    `You are collecting one raw Agent Lane answer in a fresh OpenAI Codex context.\n` +
    `Question ID: ${question.id}\nQuestion: ${question.prompt}\n\n` +
    `Stay inside the current working directory. Do not access any parent or sibling path, ` +
    `benchmark contract, answer key, evaluator, or prior run. Never guess.\n`;
  const armMaterial = arm === "understandAnythingGraph"
    ? `Use only ./knowledge-graph.json for discovery and evidence. Cite file paths and symbols from graph nodes, ` +
      `test paths and names from graph nodes, and exact source/type/target triples from graph edges.\n`
    : arm === "repositorySearchRg"
      ? `Use only the files in this sanitized Analysis Corpus. Use rg for discovery. ` +
        `Cite exact code paths/symbols and test paths/test names. Leave relations empty because this arm has no graph.\n`
      : null;
  if (!armMaterial) throw new Error(`Unknown comparison arm: ${arm}`);
  return common + armMaterial +
    `Return a concise final answer and evidence. If the available material is insufficient, return ` +
    `answer "unknown", unknown true, and empty code/tests/relations arrays. Return JSON only.\n`;
}

export function buildCodexExecArgs({ materialRoot, schemaPath, answerPath }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    ...buildCodexPermissionConfig(materialRoot),
    "--cd",
    resolve(materialRoot),
    "--output-schema",
    resolve(schemaPath),
    "--output-last-message",
    resolve(answerPath),
    "-",
  ];
}

export async function prepareAgentComparison({
  pilotArtifactRoot,
  outputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");
  const requestedResultRoot = await requireApprovedPilotOutput(
    outputDir,
    "Agent Lane Paired Comparison output",
  );
  const inputs = await loadCurrentPilotArtifact(pilotArtifactRoot);
  const resultRoot = await initializeEmptyPilotOutput(
    requestedResultRoot,
    "Agent Lane Paired Comparison output",
  );
  const benchmarkText = await readFile(DEFAULT_BENCHMARK_PATH, "utf8");
  if (sha256(benchmarkText) !== FROZEN_BENCHMARK_SHA256) {
    throw new Error("Frozen Impact Benchmark content changed");
  }
  const benchmark = JSON.parse(benchmarkText);
  validateBenchmark(benchmark);
  const planPath = resolve(resultRoot, "raw-comparison-plan.json");
  const materialsRoot = await createIsolatedMaterialRoot("ua-comparison-material-");
  const graphMaterialRoot = resolve(materialsRoot, "graph");
  const rgMaterialRoot = resolve(materialsRoot, "rg");
  const schemaPath = resolve(resultRoot, "raw-answer.schema.json");
  await Promise.all([
    mkdir(graphMaterialRoot, { recursive: true }),
    mkdir(rgMaterialRoot, { recursive: true }),
    mkdir(resolve(resultRoot, "runs"), { recursive: true }),
  ]);
  await Promise.all([
    copyRegularFileWithin({
      sourceRoot: inputs.graphDirectory,
      relativePath: "knowledge-graph.json",
      targetRoot: graphMaterialRoot,
      targetPath: resolve(graphMaterialRoot, "knowledge-graph.json"),
    }),
    copyTrackedCorpus({
      snapshotRoot: inputs.snapshotRoot,
      included: inputs.manifest.included,
      targetRoot: rgMaterialRoot,
    }),
  ]);
  const questions = sanitizedQuestions(benchmark);
  const plan = {
    contractVersion: 1,
    scored: false,
    lane: "agent",
    provider: PROVIDER,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    benchmarkRevision: benchmark.revision,
    benchmarkFrozenAt: benchmark.frozenAt,
    benchmarkSha256: sha256(benchmarkText),
    preparedAt: now(),
    timeoutMs,
    orderPolicy: "odd-graph-first-even-rg-first",
    freshContext: {
      required: true,
      mechanism: "codex exec --ephemeral --ignore-user-config with material-only filesystem permissions",
      resumeOrForkAllowed: false,
    },
    pilotArtifact: {
      planSha256: inputs.planSha256,
      manifestSha256: inputs.manifestSha256,
      corpusDigestSha256: inputs.corpusDigestSha256,
      graphSha256: inputs.graphSha256,
    },
    materialRoots: {
      root: materialsRoot,
      understandAnythingGraph: graphMaterialRoot,
      repositorySearchRg: rgMaterialRoot,
    },
    materialDigests: {
      understandAnythingGraph: await digestMaterialRoot(graphMaterialRoot),
      repositorySearchRg: await digestMaterialRoot(rgMaterialRoot),
    },
    materialPolicy: {
      understandAnythingGraph: "sanitized-knowledge-graph-only",
      repositorySearchRg: "analysis-corpus-only-rg-discovery",
      benchmarkAnswersIncluded: false,
      evaluatorIncluded: false,
      previousAnswersIncluded: false,
    },
    questions,
    runs: buildCrossedRuns(questions, timeoutMs),
  };
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const schemaText = `${JSON.stringify(ANSWER_SCHEMA, null, 2)}\n`;
  const sealText = `${JSON.stringify({
    contractVersion: 1,
    planSha256: sha256(planText),
    schemaSha256: sha256(schemaText),
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(planPath, planText, "utf8"),
    writeFile(schemaPath, schemaText, "utf8"),
    writeFile(resolve(resultRoot, "raw-comparison-seal.json"), sealText, "utf8"),
  ]);
  return { planPath, schemaPath, graphMaterialRoot, rgMaterialRoot, outputDir: resultRoot };
}

function validateAnswerShape(answer) {
  if (
    !answer ||
    typeof answer.answer !== "string" ||
    typeof answer.unknown !== "boolean" ||
    !Array.isArray(answer.evidence?.code) ||
    !Array.isArray(answer.evidence?.tests) ||
    !Array.isArray(answer.evidence?.relations)
  ) {
    throw new Error("Provider returned an invalid raw answer shape");
  }
}

export async function verifyRawAnswer({
  pilotArtifactRoot,
  run,
  question,
  answer,
  answerTimeMs,
  pilotInputs,
}) {
  const inputs = pilotInputs ?? await loadPilotInputs(pilotArtifactRoot);
  validateAnswerShape(answer);
  if (!run?.runId || !Number.isInteger(run.sequence) || run.questionId !== question?.id) {
    throw new Error("Raw answer run identity is invalid");
  }
  if (!new Set(["understandAnythingGraph", "repositorySearchRg"]).has(run.arm)) {
    throw new Error("Raw answer arm is invalid");
  }
  if (!Number.isFinite(answerTimeMs) || answerTimeMs <= 0) {
    throw new Error("Raw answer requires a positive measured answerTimeMs");
  }
  const included = new Map(inputs.manifest.included.map((entry) => [entry.path, entry]));
  const graphNodesByPath = new Map();
  for (const node of inputs.graph.nodes ?? []) {
    if (!node.filePath) continue;
    const nodes = graphNodesByPath.get(node.filePath) ?? [];
    nodes.push(node);
    graphNodesByPath.set(node.filePath, nodes);
  }
  const relations = new Set((inputs.graph.edges ?? []).map(relationKey));
  const inventedFiles = [];
  const inventedRelations = [];
  const unverifiedEvidence = [];
  for (const item of [...answer.evidence.code, ...answer.evidence.tests]) {
    if (!item?.path || !included.has(item.path) || !(await regularFile(resolve(inputs.snapshotRoot, item.path)))) {
      if (item?.path && !inventedFiles.includes(item.path)) inventedFiles.push(item.path);
    }
  }
  for (const item of answer.evidence.code) {
    if (!item?.path || inventedFiles.includes(item.path)) continue;
    const source = await readFile(resolve(inputs.snapshotRoot, item.path), "utf8");
    const tokens = symbolTokens(item.symbol);
    if (tokens.length === 0 || tokens.some((token) => !source.includes(token))) {
      unverifiedEvidence.push(`${item.path}#${item.symbol ?? "missing-symbol"}`);
    }
  }
  for (const item of answer.evidence.tests) {
    if (!item?.path || inventedFiles.includes(item.path)) continue;
    const source = await readFile(resolve(inputs.snapshotRoot, item.path), "utf8");
    if (included.get(item.path)?.category !== "test" || !item.test || !source.includes(item.test)) {
      unverifiedEvidence.push(`${item.path}#${item.test ?? "missing-test"}`);
    }
  }
  if (run.arm === "understandAnythingGraph") {
    for (const item of answer.evidence.code) {
      if (!item?.path || inventedFiles.includes(item.path)) continue;
      const nodes = graphNodesByPath.get(item.path) ?? [];
      if (nodes.length === 0) {
        unverifiedEvidence.push(`${item.path} is absent from graph nodes`);
        continue;
      }
      const graphText = nodes.map((node) => JSON.stringify(node)).join("\n");
      const tokens = symbolTokens(item.symbol);
      if (tokens.length === 0 || tokens.some((token) => !graphText.includes(token))) {
        unverifiedEvidence.push(`${item.path}#${item.symbol ?? "missing-symbol"} is absent from graph nodes`);
      }
    }
    for (const item of answer.evidence.tests) {
      if (!item?.path || inventedFiles.includes(item.path)) continue;
      const nodes = graphNodesByPath.get(item.path) ?? [];
      if (nodes.length === 0) {
        unverifiedEvidence.push(`${item.path} is absent from graph nodes`);
        continue;
      }
      const graphText = nodes.map((node) => JSON.stringify(node)).join("\n");
      const tokens = symbolTokens(item.test);
      if (tokens.length === 0 || tokens.some((token) => !graphText.includes(token))) {
        unverifiedEvidence.push(`${item.path}#${item.test ?? "missing-test"} is absent from graph nodes`);
      }
    }
  }
  for (const relation of answer.evidence.relations) {
    if (!relations.has(relationKey(relation))) inventedRelations.push(relationLabel(relation));
  }
  const evidenceCount = answer.evidence.code.length + answer.evidence.tests.length + answer.evidence.relations.length;
  if (answer.unknown && (answer.answer !== "unknown" || evidenceCount > 0)) {
    unverifiedEvidence.push("unknown answer retained a claim or evidence");
  }
  if (!answer.unknown && (answer.evidence.code.length === 0 || answer.evidence.tests.length === 0)) {
    unverifiedEvidence.push("non-unknown answer requires code and test evidence");
  }
  if (run.arm === "repositorySearchRg" && answer.evidence.relations.length > 0) {
    unverifiedEvidence.push("repository search arm must not claim graph relations");
  }
  const validationStatus = answer.unknown && unverifiedEvidence.length === 0
    ? "unknown"
    : inventedFiles.length === 0 && inventedRelations.length === 0 && unverifiedEvidence.length === 0
      ? "grounded"
      : "unsupported";
  return {
    runId: run.runId,
    sequence: run.sequence,
    questionId: run.questionId,
    arm: run.arm,
    provider: PROVIDER,
    freshContext: true,
    answer: answer.answer,
    unknown: answer.unknown,
    evidence: answer.evidence,
    inventedFiles,
    inventedRelations,
    unverifiedEvidence,
    validationStatus,
    answerTimeMs,
  };
}

async function loadComparison(outputDir) {
  const resultRoot = await requireApprovedPilotOutput(
    outputDir,
    "Agent Lane Paired Comparison output",
  );
  const [planFile, sealFile, schemaFile, benchmarkText] = await Promise.all([
    readRegularPilotFile(resultRoot, "raw-comparison-plan.json", "raw comparison plan"),
    readRegularPilotFile(resultRoot, "raw-comparison-seal.json", "raw comparison seal"),
    readRegularPilotFile(resultRoot, "raw-answer.schema.json", "raw answer schema"),
    readFile(DEFAULT_BENCHMARK_PATH, "utf8"),
  ]);
  const plan = validateComparisonPlanSeal({
    planText: planFile.text,
    sealText: sealFile.text,
    schemaText: schemaFile.text,
  });
  if (sha256(benchmarkText) !== FROZEN_BENCHMARK_SHA256) {
    throw new Error("Frozen Impact Benchmark content changed");
  }
  const benchmark = JSON.parse(benchmarkText);
  validateComparisonPlanControls({ plan, benchmark, benchmarkText });
  for (const run of plan.runs) {
    resolvePilotChildPath(resultRoot, `runs/${run.runId}`, "Agent comparison run path");
  }
  const materialRoots = await validateCurrentMaterials(plan);
  return {
    resultRoot,
    plan,
    materialRoots,
    schemaPath: schemaFile.path,
  };
}

async function validateCurrentMaterials(plan) {
  const materialLayout = await validateIsolatedMaterialLayout({
    root: plan.materialRoots?.root,
    children: {
      understandAnythingGraph: plan.materialRoots?.understandAnythingGraph,
      repositorySearchRg: plan.materialRoots?.repositorySearchRg,
    },
  });
  const currentMaterialDigests = {
    understandAnythingGraph: await digestMaterialRoot(
      materialLayout.children.understandAnythingGraph,
    ),
    repositorySearchRg: await digestMaterialRoot(
      materialLayout.children.repositorySearchRg,
    ),
  };
  if (
    currentMaterialDigests.understandAnythingGraph !==
      plan.materialDigests?.understandAnythingGraph ||
    currentMaterialDigests.repositorySearchRg !== plan.materialDigests?.repositorySearchRg
  ) {
    throw new Error("Agent comparison material changed after prepare");
  }
  return materialLayout.children;
}

function requireCurrentPilotBinding(binding, currentInputs) {
  if (
    binding?.planSha256 !== currentInputs.planSha256 ||
    binding?.manifestSha256 !== currentInputs.manifestSha256 ||
    binding?.corpusDigestSha256 !== currentInputs.corpusDigestSha256 ||
    binding?.graphSha256 !== currentInputs.graphSha256
  ) {
    throw new Error("Pilot Artifact changed after Agent comparison prepare");
  }
}

async function requireCurrentComparisonState({ pilotArtifactRoot, plan }) {
  const [currentInputs, materialRoots] = await Promise.all([
    loadCurrentPilotArtifact(pilotArtifactRoot),
    validateCurrentMaterials(plan),
  ]);
  requireCurrentPilotBinding(plan.pilotArtifact, currentInputs);
  return { currentInputs, materialRoots };
}

async function writeAggregate(resultRoot, plan, results) {
  const aggregate = {
    contractVersion: 1,
    scored: false,
    lane: "agent",
    provider: PROVIDER,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    benchmarkRevision: plan.benchmarkRevision,
    benchmarkFrozenAt: plan.benchmarkFrozenAt,
    orderPolicy: plan.orderPolicy,
    timeoutMs: plan.timeoutMs,
    completedRuns: results.length,
    results,
  };
  await writeFile(resolve(resultRoot, "raw-results.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
  return aggregate;
}

async function materializeRawResult({
  pilotArtifactRoot,
  plan,
  run,
  question,
  runRoot,
  pilotInputs,
}) {
  const [executionFile, answerFile] = await Promise.all([
    readRegularPilotFile(runRoot, "execution.json", `${run.runId} execution`),
    readRegularPilotFile(runRoot, "provider-answer.json", `${run.runId} provider answer`),
  ]);
  const execution = JSON.parse(executionFile.text);
  const answer = JSON.parse(answerFile.text);
  if (
    execution.provider !== PROVIDER ||
    execution.freshContext !== true ||
    execution.timeoutMs !== plan.timeoutMs ||
    execution.exitCode !== 0
  ) {
    throw new Error(`Execution policy mismatch for ${run.runId}`);
  }
  const rawResult = await verifyRawAnswer({
    pilotArtifactRoot,
    run,
    question,
    answer,
    answerTimeMs: execution.answerTimeMs,
    pilotInputs,
  });
  await writeFile(resolve(runRoot, "raw-result.json"), `${JSON.stringify(rawResult, null, 2)}\n`, "utf8");
  return rawResult;
}

export async function runAgentComparison({
  pilotArtifactRoot,
  outputDir,
  codexExecutable = "codex",
}) {
  const { resultRoot, plan, schemaPath } = await loadComparison(outputDir);
  const questionById = new Map(plan.questions.map((question) => [question.id, question]));
  const results = [];
  for (const run of plan.runs) {
    let currentState = await requireCurrentComparisonState({ pilotArtifactRoot, plan });
    const runRoot = await requirePilotChildDirectory(
      resultRoot,
      `runs/${run.runId}`,
      "Agent comparison run path",
      { create: true },
    );
    const resultPath = resolve(runRoot, "raw-result.json");
    if (await regularFile(resultPath)) {
      const question = questionById.get(run.questionId);
      if (!question) throw new Error(`Question missing for run ${run.runId}`);
      results.push(await materializeRawResult({
        pilotArtifactRoot,
        plan,
        run,
        question,
        runRoot,
        pilotInputs: currentState.currentInputs,
      }));
      process.stdout.write(`${JSON.stringify({ event: "run-reused", runId: run.runId, sequence: run.sequence })}\n`);
      continue;
    }
    if ((await readdir(runRoot)).length > 0) {
      throw new Error(`Incomplete or pre-seeded run output for ${run.runId}`);
    }
    const question = questionById.get(run.questionId);
    if (!question) throw new Error(`Question missing for run ${run.runId}`);
    const prompt = buildArmPrompt({ question, arm: run.arm });
    const promptPath = resolve(runRoot, "prompt.md");
    const providerAnswerPath = resolve(runRoot, "provider-answer.json");
    const materialRoot = currentState.materialRoots[run.arm];
    const args = buildCodexExecArgs({ materialRoot, schemaPath, answerPath: providerAnswerPath });
    await writeFile(promptPath, prompt, "utf8");
    process.stdout.write(`${JSON.stringify({ event: "run-started", runId: run.runId, sequence: run.sequence, arm: run.arm })}\n`);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const launched = spawnCodexChild({
      executable: codexExecutable,
      args,
      prompt,
      timeoutMs: run.timeoutMs,
    });
    const answerTimeMs = Math.max(0.01, Math.round((performance.now() - start) * 100) / 100);
    const finishedAt = new Date().toISOString();
    const execution = {
      provider: PROVIDER,
      freshContext: true,
      invocation: "codex exec --ephemeral --ignore-user-config with material-only filesystem permissions",
      timeoutMs: run.timeoutMs,
      startedAt,
      finishedAt,
      answerTimeMs,
      exitCode: launched.status,
      signal: launched.signal,
    };
    await writeFile(resolve(runRoot, "execution.json"), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
    if (launched.status !== 0) {
      throw new Error(`Fresh Codex run ${run.runId} exited ${launched.status ?? launched.signal ?? "without status"}`);
    }
    currentState = await requireCurrentComparisonState({ pilotArtifactRoot, plan });
    const rawResult = await materializeRawResult({
      pilotArtifactRoot,
      plan,
      run,
      question,
      runRoot,
      pilotInputs: currentState.currentInputs,
    });
    results.push(rawResult);
    process.stdout.write(`${JSON.stringify({ event: "run-completed", runId: run.runId, sequence: run.sequence, validationStatus: rawResult.validationStatus, answerTimeMs })}\n`);
  }
  const aggregate = await writeAggregate(resultRoot, plan, results);
  return { outputDir: resultRoot, completedRuns: aggregate.completedRuns };
}

export async function verifyAgentComparison({ pilotArtifactRoot, outputDir }) {
  const { resultRoot, plan } = await loadComparison(outputDir);
  const questionById = new Map(plan.questions.map((question) => [question.id, question]));
  const results = [];
  for (const run of plan.runs) {
    const currentState = await requireCurrentComparisonState({ pilotArtifactRoot, plan });
    const runRoot = await requirePilotChildDirectory(
      resultRoot,
      `runs/${run.runId}`,
      "Agent comparison run path",
    );
    const rawResult = await materializeRawResult({
      pilotArtifactRoot,
      plan,
      run,
      question: questionById.get(run.questionId),
      runRoot,
      pilotInputs: currentState.currentInputs,
    });
    results.push(rawResult);
  }
  const aggregate = await writeAggregate(resultRoot, plan, results);
  return { outputDir: resultRoot, completedRuns: aggregate.completedRuns };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args, new Set([
    "pilot-artifact-root", "output-dir", "timeout-ms",
  ]));
  if (!options["pilot-artifact-root"] || !options["output-dir"]) {
    throw new Error("--pilot-artifact-root and --output-dir are required");
  }
  if (command === "prepare") {
    const prepared = await prepareAgentComparison({
      pilotArtifactRoot: options["pilot-artifact-root"],
      outputDir: options["output-dir"],
      timeoutMs: options["timeout-ms"] ? Number(options["timeout-ms"]) : DEFAULT_TIMEOUT_MS,
    });
    process.stdout.write(`${JSON.stringify({ command, scored: false, ...prepared })}\n`);
    return;
  }
  if (command === "run") {
    const result = await runAgentComparison({
      pilotArtifactRoot: options["pilot-artifact-root"],
      outputDir: options["output-dir"],
    });
    process.stdout.write(`${JSON.stringify({ command, scored: false, ...result })}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verifyAgentComparison({
      pilotArtifactRoot: options["pilot-artifact-root"],
      outputDir: options["output-dir"],
    });
    process.stdout.write(`${JSON.stringify({ command, scored: false, ...result })}\n`);
    return;
  }
  throw new Error(
    "Usage: node agent-lane-comparison.mjs <prepare|run|verify> " +
    "--pilot-artifact-root PATH --output-dir PATH [--timeout-ms N]",
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`agent-lane-comparison: ${error.message}\n`);
    process.exitCode = 1;
  });
}
