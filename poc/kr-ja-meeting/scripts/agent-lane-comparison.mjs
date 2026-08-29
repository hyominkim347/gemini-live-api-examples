#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ANALYSIS_SNAPSHOT } from "./understand-anything-pilot.mjs";

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
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireDescendant(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must be below ${resolve(root)}`);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function insideGitCheckout(path) {
  const result = spawnSync("git", ["-C", resolve(path), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return result.status === 0;
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

function crossedRuns(questions, timeoutMs) {
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
  const artifactRoot = resolve(pilotArtifactRoot);
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

async function copyCorpus(snapshotRoot, included, targetRoot) {
  for (const entry of included) {
    if (!entry?.path || isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe Analysis Corpus path: ${entry?.path ?? "missing"}`);
    }
    const source = resolve(snapshotRoot, entry.path);
    const target = resolve(targetRoot, entry.path);
    requireDescendant(targetRoot, target, "rg material file");
    if (!(await regularFile(source))) throw new Error(`Analysis Corpus file is missing: ${entry.path}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
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
    "--sandbox",
    "read-only",
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
  const inputs = await loadPilotInputs(pilotArtifactRoot);
  const benchmarkText = await readFile(DEFAULT_BENCHMARK_PATH, "utf8");
  if (sha256(benchmarkText) !== FROZEN_BENCHMARK_SHA256) {
    throw new Error("Frozen Impact Benchmark content changed");
  }
  const benchmark = JSON.parse(benchmarkText);
  validateBenchmark(benchmark);
  const resultRoot = resolve(outputDir);
  if (!resultRoot.split(/[\\/]/).includes(".ua-pilot")) {
    throw new Error("Agent Lane Paired Comparison output must be local .ua-pilot storage");
  }
  const planPath = resolve(resultRoot, "raw-comparison-plan.json");
  if (await regularFile(planPath)) throw new Error(`Comparison plan already exists: ${planPath}`);
  const materialsRoot = resolve(resultRoot, "materials");
  const graphMaterialRoot = resolve(materialsRoot, "graph");
  const rgMaterialRoot = resolve(materialsRoot, "rg");
  const schemaPath = resolve(resultRoot, "raw-answer.schema.json");
  await Promise.all([
    mkdir(graphMaterialRoot, { recursive: true }),
    mkdir(rgMaterialRoot, { recursive: true }),
    mkdir(resolve(resultRoot, "runs"), { recursive: true }),
  ]);
  if (insideGitCheckout(resultRoot)) {
    throw new Error("Agent Lane material roots must be outside every Git checkout");
  }
  await Promise.all([
    copyFile(inputs.graphPath, resolve(graphMaterialRoot, "knowledge-graph.json")),
    copyCorpus(inputs.snapshotRoot, inputs.manifest.included, rgMaterialRoot),
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
      mechanism: "codex exec --ephemeral --ignore-user-config --sandbox read-only",
      resumeOrForkAllowed: false,
    },
    materialPolicy: {
      understandAnythingGraph: "sanitized-knowledge-graph-only",
      repositorySearchRg: "analysis-corpus-only-rg-discovery",
      benchmarkAnswersIncluded: false,
      evaluatorIncluded: false,
      previousAnswersIncluded: false,
    },
    questions,
    runs: crossedRuns(questions, timeoutMs),
  };
  await Promise.all([
    writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8"),
    writeFile(schemaPath, `${JSON.stringify(ANSWER_SCHEMA, null, 2)}\n`, "utf8"),
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
}) {
  const inputs = await loadPilotInputs(pilotArtifactRoot);
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
  const resultRoot = resolve(outputDir);
  const plan = await readJson(resolve(resultRoot, "raw-comparison-plan.json"), "raw comparison plan");
  if (
    plan.scored !== false ||
    plan.provider !== PROVIDER ||
    plan.analysisSnapshot !== ANALYSIS_SNAPSHOT ||
    !Array.isArray(plan.questions) ||
    plan.questions.length !== 12 ||
    !Array.isArray(plan.runs) ||
    plan.runs.length !== 24
  ) {
    throw new Error("Raw comparison plan is invalid");
  }
  return { resultRoot, plan, schemaPath: resolve(resultRoot, "raw-answer.schema.json") };
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
}) {
  const execution = await readJson(resolve(runRoot, "execution.json"), `${run.runId} execution`);
  const answer = await readJson(resolve(runRoot, "provider-answer.json"), `${run.runId} provider answer`);
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
    const runRoot = resolve(resultRoot, "runs", run.runId);
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
      }));
      process.stdout.write(`${JSON.stringify({ event: "run-reused", runId: run.runId, sequence: run.sequence })}\n`);
      continue;
    }
    await mkdir(runRoot, { recursive: true });
    const question = questionById.get(run.questionId);
    if (!question) throw new Error(`Question missing for run ${run.runId}`);
    const prompt = buildArmPrompt({ question, arm: run.arm });
    const promptPath = resolve(runRoot, "prompt.md");
    const providerAnswerPath = resolve(runRoot, "provider-answer.json");
    const materialRoot = resolve(resultRoot, "materials", run.arm === "understandAnythingGraph" ? "graph" : "rg");
    const args = buildCodexExecArgs({ materialRoot, schemaPath, answerPath: providerAnswerPath });
    await writeFile(promptPath, prompt, "utf8");
    process.stdout.write(`${JSON.stringify({ event: "run-started", runId: run.runId, sequence: run.sequence, arm: run.arm })}\n`);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const launched = spawnSync(codexExecutable, args, {
      input: prompt,
      encoding: "utf8",
      timeout: run.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const answerTimeMs = Math.max(0.01, Math.round((performance.now() - start) * 100) / 100);
    const finishedAt = new Date().toISOString();
    const execution = {
      provider: PROVIDER,
      freshContext: true,
      invocation: "codex exec --ephemeral --ignore-user-config --skip-git-repo-check --sandbox read-only",
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
    const rawResult = await materializeRawResult({
      pilotArtifactRoot,
      plan,
      run,
      question,
      runRoot,
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
    const runRoot = resolve(resultRoot, "runs", run.runId);
    const rawResult = await materializeRawResult({
      pilotArtifactRoot,
      plan,
      run,
      question: questionById.get(run.questionId),
      runRoot,
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
