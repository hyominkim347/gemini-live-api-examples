#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  buildCodexChildEnv,
  loadVerifiedPilotArtifact,
  requireApprovedPilotOutput,
  runProcessGroupWithTimeout,
} from "./pilot-local-safety.mjs";

export const ANALYSIS_SNAPSHOT = "5bf36dd61b6355368d736479c5ffb528b656d544";
export const UPSTREAM_REPOSITORY = "https://github.com/Egonex-AI/Understand-Anything.git";
export const UPSTREAM_COMMIT = "ba450c43425f3de6d43daf76526950ad8ca93536";
export const FULL_ANALYSIS_BUDGET_MS = 30 * 60 * 1000;
export const INCREMENTAL_REFRESH_BUDGET_MS = 5 * 60 * 1000;
export const BUDGET_MEASUREMENT = "budgeted-child-process-v1";
export const CALIBRATION_QUESTION =
  "Live Translate가 completion event를 보내지 않을 때 phraseBoundary()는 번역 오디오를 " +
  "유실하지 않고 다음 입력 구간을 어떻게 시작하며, 첫 audible output이 없으면 어떻게 실패하는가?";
const PHASES = ["fullAnalysis", "incrementalRefresh"];
const PLAN_SEAL_FILE = "pilot-plan-seal.json";
const UPSTREAM_RUNTIME_PREFIXES = [
  "homepage/node_modules/",
  "node_modules/",
  "understand-anything-plugin/node_modules/",
  "understand-anything-plugin/packages/core/dist/",
  "understand-anything-plugin/packages/core/node_modules/",
  "understand-anything-plugin/packages/dashboard/node_modules/",
];

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".mts",
  ".php", ".py", ".pyi", ".rb", ".rs", ".scala", ".scss", ".sh",
  ".sql", ".swift", ".ts", ".tsx", ".vue",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".text", ".txt"]);
const DEPENDENCY_BASENAMES = new Set([
  "bun.lock", "bun.lockb", "composer.lock", "Gemfile.lock", "go.sum",
  "package-lock.json", "pnpm-lock.yaml", "requirements.txt", "yarn.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  ".cache", ".next", ".turbo", "build", "coverage", "dist", "out", "target",
]);
const DEPENDENCY_DIRECTORIES = new Set([
  ".venv", "node_modules", "vendor", "venv",
]);

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runBudgetedPilotPhase({
  phase,
  budgetMilliseconds,
  command,
  cwd = process.cwd(),
  env = process.env,
  killGraceMilliseconds = 1_000,
  stdinText,
}) {
  if (!PHASES.includes(phase)) {
    throw new TypeError(`Unsupported pilot phase: ${phase}`);
  }
  if (!Number.isFinite(budgetMilliseconds) || budgetMilliseconds <= 0) {
    throw new TypeError("budgetMilliseconds must be a positive finite number");
  }
  if (!Array.isArray(command) || command.length === 0 ||
      command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new TypeError("command must be a non-empty string array");
  }
  if (!Number.isFinite(killGraceMilliseconds) || killGraceMilliseconds < 0) {
    throw new TypeError("killGraceMilliseconds must be a non-negative finite number");
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = await runProcessGroupWithTimeout({
    executable: command[0],
    args: command.slice(1),
    cwd,
    env,
    input: stdinText,
    timeoutMs: budgetMilliseconds,
    killGraceMilliseconds,
    output: "inherit",
  });
  const elapsedMilliseconds = Math.round((performance.now() - started) * 1_000) / 1_000;
  return {
    status: child.timedOut
      ? "timed-out"
      : child.error || child.status !== 0
        ? "failed"
        : "completed",
    phase,
    measurement: BUDGET_MEASUREMENT,
    budgetMilliseconds,
    elapsedMilliseconds,
    timedOut: child.timedOut,
    exitCode: child.status,
    signal: child.signal,
    spawnError: child.error?.message ?? null,
    commandSha256: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function extensionOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function classifyCorpusPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  const lowerName = name.toLowerCase();

  if (
    lowerName === ".env" || lowerName.startsWith(".env.") ||
    /(?:^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i.test(normalized) ||
    /\.(?:jks|key|keystore|p12|pem|pfx)$/i.test(name) ||
    /(?:^|\/)id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/i.test(normalized)
  ) {
    return { include: false, reason: "secret-bearing-path" };
  }

  if (
    DEPENDENCY_BASENAMES.has(name) || lowerName.endsWith(".lock") ||
    segments.some((segment) => DEPENDENCY_DIRECTORIES.has(segment.toLowerCase()))
  ) {
    return { include: false, reason: "dependency" };
  }

  if (
    segments.some((segment) => GENERATED_DIRECTORIES.has(segment.toLowerCase())) ||
    /(?:\.generated\.|\.min\.(?:css|js)$|\.map$)/i.test(name)
  ) {
    return { include: false, reason: "generated" };
  }

  if (lowerName === ".gitignore" || lowerName === ".dockerignore") {
    return { include: false, reason: "repository-metadata" };
  }

  const extension = extensionOf(normalized);
  const isTest = segments.some((segment) => /^(?:__tests__|spec|test|tests)$/i.test(segment)) ||
    /(?:^|[._-])(?:spec|test)(?:[._-]|$)/i.test(lowerName);
  if (isTest) return { include: true, category: "test" };
  if (DOC_EXTENSIONS.has(extension) || /^readme(?:\.|$)/i.test(name)) {
    return { include: true, category: "documentation" };
  }
  if (CODE_EXTENSIONS.has(extension)) return { include: true, category: "code" };

  return { include: false, reason: "outside-code-doc-test" };
}

export function buildCorpusManifest(repo) {
  const projectRoot = resolve(repo);
  const resolvedSnapshot = git(projectRoot, ["rev-parse", `${ANALYSIS_SNAPSHOT}^{commit}`]).trim();
  if (resolvedSnapshot !== ANALYSIS_SNAPSHOT) {
    throw new Error(`Analysis Snapshot mismatch: expected ${ANALYSIS_SNAPSHOT}, got ${resolvedSnapshot}`);
  }

  const trackedPaths = git(projectRoot, [
    "ls-tree", "-r", "-z", "--name-only", ANALYSIS_SNAPSHOT,
  ]).split("\0").filter(Boolean);
  const included = [];
  const excluded = [];

  for (const path of trackedPaths) {
    const classification = classifyCorpusPath(path);
    if (classification.include) {
      included.push({ path, category: classification.category });
    } else {
      excluded.push({ path, reason: classification.reason });
    }
  }

  return {
    contractVersion: 1,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    upstream: {
      repository: UPSTREAM_REPOSITORY,
      commit: UPSTREAM_COMMIT,
    },
    providerPolicy: "current-codex-provider-only",
    refreshPolicy: "manual-only",
    budgetsMilliseconds: {
      fullAnalysis: FULL_ANALYSIS_BUDGET_MS,
      incrementalRefresh: INCREMENTAL_REFRESH_BUDGET_MS,
    },
    selection: {
      source: `git ls-tree -r --name-only ${ANALYSIS_SNAPSHOT}`,
      trackedOnly: true,
      ignoredAndUntrackedExcludedByConstruction: true,
      allowedCategories: ["code", "documentation", "test"],
    },
    counts: {
      trackedAtSnapshot: trackedPaths.length,
      included: included.length,
      excluded: excluded.length,
    },
    included,
    excluded,
  };
}

export function loadCurrentPilotArtifact(pilotArtifactRoot) {
  return loadVerifiedPilotArtifact({
    artifactRoot: pilotArtifactRoot,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    upstreamCommit: UPSTREAM_COMMIT,
    expectedManifestForSource: buildCorpusManifest,
    provider: "current-codex-provider-only",
  });
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--") || option.length === 2) {
      throw new Error(`Unexpected argument: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[option.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function manifestCommand(args) {
  const options = parseOptions(args);
  const repo = await realpath(options.repo ? resolve(options.repo) : process.cwd());
  const artifactRoot = await requireApprovedPilotOutput(
    options["artifact-root"] ?? resolve(repo, ".ua-pilot"),
    "Understand-Anything manifest output",
  );
  const manifest = buildCorpusManifest(repo);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    resolve(artifactRoot, "corpus-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({
    command: "manifest",
    analysisSnapshot: manifest.analysisSnapshot,
    included: manifest.counts.included,
    excluded: manifest.counts.excluded,
    artifactRoot,
  })}\n`);
}

function buildPilotPlan(repo, artifactRoot) {
  const snapshotCheckout = resolve(artifactRoot, "analysis-snapshot");
  const upstreamCheckout = resolve(artifactRoot, "understand-anything");
  const plan = {
    contractVersion: 1,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    upstream: {
      repository: UPSTREAM_REPOSITORY,
      commit: UPSTREAM_COMMIT,
      checkout: upstreamCheckout,
      installScope: "artifact-local",
      installRoot: upstreamCheckout,
      pluginRoot: resolve(upstreamCheckout, "understand-anything-plugin"),
      localBuild: [
        ["corepack", "pnpm", "install", "--frozen-lockfile"],
        ["corepack", "pnpm", "--filter", "@understand-anything/core", "build"],
      ],
    },
    sourceRepository: resolve(repo),
    snapshotCheckout,
    provider: "current-codex-provider-only",
    environment: {
      UNDERSTAND_NO_WORKTREE_REDIRECT: "1",
    },
    understandArguments: ["--full", "--language", "ko", "--no-auto-update"],
    budgetsMilliseconds: {
      fullAnalysis: FULL_ANALYSIS_BUDGET_MS,
      incrementalRefresh: INCREMENTAL_REFRESH_BUDGET_MS,
    },
    budgetRunner: {
      command: "npm run pilot:run-budgeted --",
      measurement: BUDGET_MEASUREMENT,
      phases: PHASES,
      timeoutPolicy: "SIGTERM-then-SIGKILL",
    },
    artifacts: {
      root: resolve(artifactRoot),
      graphDirectory: resolve(snapshotCheckout, ".ua"),
      commitPolicy: "local-uncommitted-only",
    },
    expectedOutputs: [
      ".ua/knowledge-graph.json",
      ".ua/meta.json",
      ".ua/fingerprints.json",
      ".ua/intermediate/scan-result.json",
    ],
    prohibited: [
      "global-installer",
      "symlink",
      "new-provider-credentials",
      "auto-update-hook",
      "ci",
      "schedule",
      "background-automation",
    ],
  };
  plan.phaseInvocations = Object.fromEntries(PHASES.map((phase) => [phase, {
    command: buildCodexCommand(plan),
    promptFile: phase === "fullAnalysis" ? "codex-prompt.md" : "incremental-codex-prompt.md",
  }]));
  return plan;
}

function corpusSha256(repo, manifest) {
  const treeRows = git(repo, [
    "ls-tree", "-r", "-z", "--format=%(objectname)%x09%(path)", ANALYSIS_SNAPSHOT,
  ]).split("\0").filter(Boolean);
  const objectByPath = new Map(treeRows.map((row) => {
    const separator = row.indexOf("\t");
    if (separator <= 0) throw new Error("Analysis Corpus tree emitted an invalid row");
    return [row.slice(separator + 1), row.slice(0, separator)];
  }));
  const rows = manifest.included.map(({ path, category }) => {
    const objectId = objectByPath.get(path);
    if (!objectId) throw new Error(`Analysis Corpus path is absent from snapshot: ${path}`);
    return `${path}\0${category}\0${objectId}`;
  }).sort();
  return sha256(rows.join("\n"));
}

function buildPlanSeal({ plan, planText, manifest, manifestText }) {
  return {
    contractVersion: 1,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    upstreamCommit: UPSTREAM_COMMIT,
    planSha256: sha256(planText),
    corpusManifestSha256: sha256(manifestText),
    corpusSha256: corpusSha256(plan.sourceRepository, manifest),
    phaseInvocations: Object.fromEntries(PHASES.map((phase) => [phase, {
      commandSha256: sha256(JSON.stringify(buildCodexCommand(plan))),
      promptSha256: sha256(buildCodexPrompt(plan, phase)),
    }])),
  };
}

async function writeSealedPlanFiles({ artifactRoot, plan, manifest }) {
  const planText = jsonText(plan);
  const manifestText = jsonText(manifest);
  const prompts = Object.fromEntries(PHASES.map((phase) => [phase, buildCodexPrompt(plan, phase)]));
  const seal = buildPlanSeal({ plan, planText, manifest, manifestText });
  const sealText = jsonText(seal);
  await Promise.all([
    writeFile(resolve(artifactRoot, "corpus-manifest.json"), manifestText, "utf8"),
    writeFile(resolve(artifactRoot, "pilot-plan.json"), planText, "utf8"),
    writeFile(resolve(artifactRoot, "codex-prompt.md"), prompts.fullAnalysis, "utf8"),
    writeFile(
      resolve(artifactRoot, "incremental-codex-prompt.md"),
      prompts.incrementalRefresh,
      "utf8",
    ),
    writeFile(resolve(artifactRoot, PLAN_SEAL_FILE), sealText, "utf8"),
  ]);
  return { seal, sealSha256: sha256(sealText) };
}

function buildCodexCommand(plan) {
  return [
    "codex", "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
    "--sandbox", "workspace-write", "-C", plan.snapshotCheckout,
    "--add-dir", plan.upstream.checkout, "-",
  ];
}

function buildCodexPrompt(plan, phase = "fullAnalysis") {
  const skillPath = resolve(
    plan.upstream.checkout,
    "understand-anything-plugin/skills/understand/SKILL.md",
  );
  const analysisMode = phase === "fullAnalysis" ? "full analysis" : "Incremental Refresh";
  const understandArguments = phase === "fullAnalysis"
    ? plan.understandArguments
    : plan.understandArguments.filter((argument) => argument !== "--full");
  return `Execute the pinned Understand-Anything ${analysisMode} for the local AIN-7639 pilot.\n\n` +
    `1. Read the complete upstream skill at ${skillPath}.\n` +
    `   If core dist is absent, run the plan's localBuild commands only in ` +
    `${plan.upstream.installRoot}; do not install globally.\n` +
    `2. Analyze only ${plan.snapshotCheckout}, whose HEAD must equal ${plan.analysisSnapshot}.\n` +
    `3. Use the pre-approved .ua/.understandignore without prompting. Keep ` +
    `UNDERSTAND_NO_WORKTREE_REDIRECT=1.\n` +
    `4. Apply ${understandArguments.join(" ")}. Do not install globally, create symlinks, ` +
    `add hooks, add credentials/providers, or modify tracked source files.\n` +
    `5. Use the current Codex provider. Write only local .ua artifacts. Preserve scan-result.json.\n` +
    `6. Stop with a non-zero result if the analysis cannot finish within the enclosing budget.\n`;
}

async function planCommand(args) {
  const options = parseOptions(args);
  const repo = await realpath(options.repo ? resolve(options.repo) : process.cwd());
  const artifactRoot = await requireApprovedPilotOutput(
    options["artifact-root"] ?? resolve(repo, ".ua-pilot"),
    "Understand-Anything plan output",
  );
  const manifest = buildCorpusManifest(repo);
  const plan = buildPilotPlan(repo, artifactRoot);
  await mkdir(artifactRoot, { recursive: true });
  await writeSealedPlanFiles({ artifactRoot, plan, manifest });
  process.stdout.write(`${JSON.stringify({ command: "plan", artifactRoot })}\n`);
}

function requireDescendant(root, child, label) {
  const childRelative = relative(root, child);
  if (!childRelative || childRelative === ".." || childRelative.startsWith(`..${sep}`)) {
    throw new Error(`${label} crossed the Pilot Artifact material boundary`);
  }
}

async function assertTrackedTreeBytes({ checkout, commit, label }) {
  const objectFormat = git(checkout, ["rev-parse", "--show-object-format"]).trim();
  if (objectFormat !== "sha1") {
    throw new Error(`${label} uses unsupported Git object format: ${objectFormat}`);
  }
  const entries = git(checkout, [
    "ls-tree", "-r", "-z", "--format=%(objectmode)%x09%(objectname)%x09%(path)", commit,
  ]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const firstSeparator = entry.indexOf("\t");
    const secondSeparator = entry.indexOf("\t", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator) {
      throw new Error(`${label} pinned tree emitted an invalid row`);
    }
    const mode = entry.slice(0, firstSeparator);
    const expectedObjectId = entry.slice(firstSeparator + 1, secondSeparator);
    const relativePath = entry.slice(secondSeparator + 1);
    if (!mode.startsWith("100")) {
      throw new Error(`${label} pinned tree contains unsupported mode ${mode}: ${relativePath}`);
    }
    const path = resolve(checkout, relativePath);
    requireDescendant(checkout, path, `${label} tracked path`);
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error(`${label} tracked path is not a canonical regular file: ${relativePath}`);
    }
    const executable = (pathStat.mode & 0o111) !== 0;
    if (executable !== (mode === "100755")) {
      throw new Error(`${label} tracked mode differs from the pinned tree: ${relativePath}`);
    }
    const bytes = await readFile(path);
    const actualObjectId = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actualObjectId !== expectedObjectId) {
      throw new Error(`${label} tracked bytes differ from the pinned tree: ${relativePath}`);
    }
  }
}

export async function assertSealedCheckoutState({
  checkout,
  commit,
  label,
  allowedIgnoredPrefixes = [],
  allowedIgnoredDigestSha256 = null,
  requireAllowedIgnoredDigest = false,
  allowIgnoredSymlinks = false,
}) {
  const [canonicalCheckout, gitDirectoryStat] = await Promise.all([
    realpath(checkout),
    lstat(resolve(checkout, ".git")),
  ]);
  if (!gitDirectoryStat.isDirectory() || gitDirectoryStat.isSymbolicLink()) {
    throw new Error(`${label} .git must be a non-symlink directory`);
  }
  const gitTopLevel = await realpath(git(checkout, ["rev-parse", "--show-toplevel"]).trim());
  if (gitTopLevel !== canonicalCheckout) {
    throw new Error(`${label} Git worktree redirected outside the canonical checkout`);
  }
  const head = git(checkout, ["rev-parse", "HEAD"]).trim();
  if (head !== commit) throw new Error(`${label} HEAD changed: expected ${commit}, got ${head}`);
  await assertTrackedTreeBytes({ checkout: canonicalCheckout, commit, label });
  const entries = git(checkout, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching",
  ]).split("\0").filter(Boolean);
  const rejected = entries.filter((entry) => {
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    return status !== "!!" || !allowedIgnoredPrefixes.some(
      (prefix) => path === prefix || path.startsWith(prefix),
    );
  });
  if (rejected.length > 0) {
    throw new Error(`${label} contains unsealed content: ${rejected.join(", ")}`);
  }
  const allowedEntries = entries.filter((entry) => entry.slice(0, 2) === "!!");
  if (allowedEntries.length > 0 && !allowIgnoredSymlinks) {
    for (const prefix of allowedIgnoredPrefixes) {
      await assertNoSymlinkDescendants(canonicalCheckout, resolve(canonicalCheckout, prefix));
    }
  }
  if (allowedEntries.length > 0 && requireAllowedIgnoredDigest && !allowedIgnoredDigestSha256) {
    throw new Error(`${label} contains executable build content without a runner digest`);
  }
  if (allowedIgnoredDigestSha256) {
    const actualDigest = await runtimeMaterialSha256(canonicalCheckout, allowedIgnoredPrefixes);
    if (actualDigest !== allowedIgnoredDigestSha256) {
      throw new Error(`${label} executable build content differs from the runner digest`);
    }
  }
}

async function assertNoSymlinkDescendants(root, path) {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  requireDescendant(root, path, "Ignored Pilot output");
  if (pathStat.isSymbolicLink()) {
    throw new Error(`Ignored Pilot output contains a symlink: ${relative(root, path)}`);
  }
  if (!pathStat.isDirectory()) return;
  for (const child of await readdir(path)) {
    await assertNoSymlinkDescendants(root, resolve(path, child));
  }
}

function pathAtOrBelow(root, path) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function runtimeMaterialRows(root, path, rows, allowedRoots, trackedPaths) {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const relativePath = relative(root, path);
  requireDescendant(root, path, "Upstream runtime material");
  if (pathStat.isSymbolicLink()) {
    const canonicalTarget = await realpath(path);
    requireDescendant(root, canonicalTarget, "Upstream runtime material symlink target");
    const targetRelative = relative(root, canonicalTarget);
    const withinRuntimeMaterial = allowedRoots.some((allowedRoot) =>
      pathAtOrBelow(allowedRoot, canonicalTarget));
    const trackedTarget = trackedPaths.some((trackedPath) =>
      trackedPath === targetRelative || trackedPath.startsWith(`${targetRelative}/`));
    if (!withinRuntimeMaterial && !trackedTarget) {
      throw new Error(`Upstream runtime symlink target is not sealed: ${relativePath}`);
    }
    rows.push(`${relativePath}\0symlink\0${await readlink(path)}`);
    return;
  }
  if (pathStat.isDirectory()) {
    const children = (await readdir(path)).sort();
    for (const child of children) {
      await runtimeMaterialRows(root, resolve(path, child), rows, allowedRoots, trackedPaths);
    }
    return;
  }
  if (!pathStat.isFile() || await realpath(path) !== path) {
    throw new Error(`Upstream runtime material is not a canonical regular file: ${relativePath}`);
  }
  const bytes = await readFile(path);
  rows.push(`${relativePath}\0${pathStat.mode & 0o777}\0${sha256(bytes)}`);
}

export async function runtimeMaterialSha256(checkout, prefixes = UPSTREAM_RUNTIME_PREFIXES) {
  const canonicalCheckout = await realpath(checkout);
  const allowedRoots = prefixes.map((prefix) => resolve(canonicalCheckout, prefix));
  const trackedPaths = git(canonicalCheckout, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const rows = [];
  for (const prefix of [...prefixes].sort()) {
    await runtimeMaterialRows(
      canonicalCheckout,
      resolve(canonicalCheckout, prefix),
      rows,
      allowedRoots,
      trackedPaths,
    );
  }
  return sha256(rows.sort().join("\n"));
}

async function requirePinnedCheckout({
  artifactRoot,
  path,
  expectedPath,
  commit,
  label,
  allowedIgnoredPrefixes,
  allowedIgnoredDigestSha256,
  requireAllowedIgnoredDigest,
  allowIgnoredSymlinks,
}) {
  if (resolve(path) !== resolve(expectedPath)) {
    throw new Error(`${label} path changed from the sealed plan`);
  }
  const pathStat = await lstat(path);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const [canonicalRoot, canonicalCheckout] = await Promise.all([
    realpath(artifactRoot),
    realpath(path),
  ]);
  requireDescendant(canonicalRoot, canonicalCheckout, label);
  if (canonicalCheckout !== resolve(canonicalRoot, relative(artifactRoot, expectedPath))) {
    throw new Error(`${label} canonical path changed from the sealed plan`);
  }
  await assertSealedCheckoutState({
    checkout: canonicalCheckout,
    commit,
    label,
    allowedIgnoredPrefixes,
    allowedIgnoredDigestSha256,
    requireAllowedIgnoredDigest,
    allowIgnoredSymlinks,
  });
  return canonicalCheckout;
}

async function validateSealedPlanFiles(approvedRoot) {
  const [planText, manifestText, sealText] = await Promise.all([
    readFile(resolve(approvedRoot, "pilot-plan.json"), "utf8"),
    readFile(resolve(approvedRoot, "corpus-manifest.json"), "utf8"),
    readFile(resolve(approvedRoot, PLAN_SEAL_FILE), "utf8"),
  ]);
  const plan = JSON.parse(planText);
  const sourceRepository = await realpath(plan.sourceRepository);
  const expectedPlan = buildPilotPlan(sourceRepository, approvedRoot);
  const expectedPlanText = jsonText(expectedPlan);
  if (planText !== expectedPlanText) {
    throw new Error("Pilot plan differs from the deterministic prepared plan");
  }
  const manifest = buildCorpusManifest(sourceRepository);
  const expectedManifestText = jsonText(manifest);
  if (manifestText !== expectedManifestText) {
    throw new Error("Analysis Corpus manifest differs from the deterministic snapshot corpus");
  }
  const expectedSealText = jsonText(buildPlanSeal({
    plan: expectedPlan,
    planText: expectedPlanText,
    manifest,
    manifestText: expectedManifestText,
  }));
  if (sealText !== expectedSealText) {
    throw new Error("Pilot plan seal or bound digests changed");
  }
  return { plan, manifest, sealText };
}

export function runtimeDigestBeforePhase(metrics, phase) {
  return phase === "incrementalRefresh"
    ? metrics.incrementalRefresh?.runtimeMaterialSha256 ?? metrics.fullAnalysis?.runtimeMaterialSha256
    : metrics.fullAnalysis?.runtimeMaterialSha256;
}

export function snapshotDigestBeforePhase(metrics, phase) {
  return phase === "incrementalRefresh"
    ? metrics.incrementalRefresh?.snapshotOutputSha256 ?? metrics.fullAnalysis?.snapshotOutputSha256
    : metrics.fullAnalysis?.snapshotOutputSha256;
}

export async function validateSealedPilotRun(artifactRoot, phase) {
  const approvedRoot = await requireApprovedPilotOutput(
    artifactRoot,
    "Understand-Anything budget runner output",
  );
  const { plan, manifest, sealText } = await validateSealedPlanFiles(approvedRoot);
  const metrics = await readJson(resolve(approvedRoot, "run-metrics.json"));
  const priorRuntimeDigest = runtimeDigestBeforePhase(metrics, phase);
  const priorSnapshotDigest = snapshotDigestBeforePhase(metrics, phase);
  await Promise.all([
    requirePinnedCheckout({
      artifactRoot: approvedRoot,
      path: plan.snapshotCheckout,
      expectedPath: resolve(approvedRoot, "analysis-snapshot"),
      commit: ANALYSIS_SNAPSHOT,
      label: "Analysis Snapshot checkout",
      allowedIgnoredPrefixes: [".ua/", ".understand-anything/"],
      allowedIgnoredDigestSha256: priorSnapshotDigest,
      requireAllowedIgnoredDigest: true,
    }),
    requirePinnedCheckout({
      artifactRoot: approvedRoot,
      path: plan.upstream.checkout,
      expectedPath: resolve(approvedRoot, "understand-anything"),
      commit: UPSTREAM_COMMIT,
      label: "Understand-Anything checkout",
      allowedIgnoredPrefixes: UPSTREAM_RUNTIME_PREFIXES,
      allowedIgnoredDigestSha256: priorRuntimeDigest,
      requireAllowedIgnoredDigest: true,
      allowIgnoredSymlinks: true,
    }),
  ]);
  const promptFile = phase === "fullAnalysis"
    ? "codex-prompt.md"
    : "incremental-codex-prompt.md";
  const promptText = await readFile(resolve(approvedRoot, promptFile), "utf8");
  if (sha256(promptText) !== JSON.parse(sealText).phaseInvocations[phase]?.promptSha256) {
    throw new Error(`${phase} prompt digest changed from the sealed plan`);
  }
  return { artifactRoot: approvedRoot, plan, manifest, promptFile, promptText };
}

async function ensurePinnedCheckout({ source, destination, commit, label }) {
  const gitDirectory = resolve(destination, ".git");
  if (await pathExists(destination)) {
    if (!(await pathExists(gitDirectory))) {
      throw new Error(`${label} checkout exists without .git: ${destination}`);
    }
    const existingHead = git(destination, ["rev-parse", "HEAD"]).trim();
    if (existingHead !== commit) {
      throw new Error(
        `${label} checkout is ${existingHead}; expected ${commit}. ` +
        "Refusing to overwrite an existing Pilot Artifact.",
      );
    }
    return existingHead;
  }

  await mkdir(destination, { recursive: true });
  git(destination, ["init", "--quiet"]);
  git(destination, ["remote", "add", "origin", source]);
  try {
    git(destination, ["fetch", "--quiet", "--depth=1", "origin", commit]);
  } catch (error) {
    throw new Error(`${label} source does not provide pinned commit ${commit}: ${error.message}`);
  }
  git(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const head = git(destination, ["rev-parse", "HEAD"]).trim();
  if (head !== commit) throw new Error(`${label} pin mismatch: expected ${commit}, got ${head}`);
  return head;
}

async function readFileIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeSnapshotIgnore(snapshotCheckout, manifest) {
  const uaDirectory = resolve(snapshotCheckout, ".ua");
  await mkdir(uaDirectory, { recursive: true });

  const grouped = new Map();
  for (const entry of manifest.excluded) {
    const paths = grouped.get(entry.reason) ?? [];
    paths.push(entry.path);
    grouped.set(entry.reason, paths);
  }
  const lines = [
    "# Generated by the local AIN-7639 adapter; Pilot Artifact only.",
    "/.ua/",
    "/.understand-anything/",
  ];
  for (const reason of [...grouped.keys()].sort()) {
    lines.push("", `# ${reason}`);
    for (const path of grouped.get(reason).sort()) lines.push(`/${path}`);
  }
  await writeFile(resolve(uaDirectory, ".understandignore"), `${lines.join("\n")}\n`, "utf8");

  const excludePathText = git(snapshotCheckout, ["rev-parse", "--git-path", "info/exclude"]).trim();
  const excludePath = resolve(snapshotCheckout, excludePathText);
  const existing = await readFileIfPresent(excludePath);
  const required = ["/.ua/", "/.understand-anything/"];
  const additions = required.filter((pattern) => !existing.split("\n").includes(pattern));
  if (additions.length > 0) {
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(
      excludePath,
      `${existing}${separator}# Local AIN-7639 Pilot Artifacts\n${additions.join("\n")}\n`,
      "utf8",
    );
  }
}

async function prepareCommand(args) {
  const options = parseOptions(args);
  const repo = await realpath(options.repo ? resolve(options.repo) : process.cwd());
  const artifactRoot = await requireApprovedPilotOutput(
    options["artifact-root"] ?? resolve(repo, ".ua-pilot"),
    "Understand-Anything prepare output",
  );
  const upstreamSource = options["upstream-source"] ?? UPSTREAM_REPOSITORY;
  const manifest = buildCorpusManifest(repo);
  const plan = buildPilotPlan(repo, artifactRoot);

  await mkdir(artifactRoot, { recursive: true });
  const snapshotHead = await ensurePinnedCheckout({
    source: repo,
    destination: plan.snapshotCheckout,
    commit: ANALYSIS_SNAPSHOT,
    label: "Analysis Snapshot",
  });
  const upstreamHead = await ensurePinnedCheckout({
    source: upstreamSource,
    destination: plan.upstream.checkout,
    commit: UPSTREAM_COMMIT,
    label: "Understand-Anything upstream",
  });
  await writeSnapshotIgnore(plan.snapshotCheckout, manifest);

  const snapshotStatus = git(plan.snapshotCheckout, ["status", "--porcelain", "--untracked-files=all"]);
  if (snapshotStatus.trim()) {
    throw new Error(`Analysis Snapshot is not clean after local exclusions:\n${snapshotStatus}`);
  }

  const { seal, sealSha256 } = await writeSealedPlanFiles({ artifactRoot, plan, manifest });
  const initialSnapshotOutputSha256 = await runtimeMaterialSha256(
    plan.snapshotCheckout,
    [".ua/", ".understand-anything/"],
  );
  const initialRuntimeMaterialSha256 = await runtimeMaterialSha256(plan.upstream.checkout);
  await Promise.all([
    writeFile(resolve(artifactRoot, "prepare-result.json"), `${JSON.stringify({
      snapshotHead,
      upstreamHead,
      snapshotClean: true,
      globalInstallerUsed: false,
      symlinksCreated: false,
      planSealSha256: sealSha256,
      planSha256: seal.planSha256,
      corpusSha256: seal.corpusSha256,
      commandSha256: Object.fromEntries(PHASES.map((phase) => [
        phase,
        seal.phaseInvocations[phase].commandSha256,
      ])),
    }, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "run-metrics.json"), `${JSON.stringify({
      fullAnalysis: {
        status: "not-run", measurement: BUDGET_MEASUREMENT,
        budgetMilliseconds: FULL_ANALYSIS_BUDGET_MS, elapsedMilliseconds: null,
        snapshotOutputSha256: initialSnapshotOutputSha256,
        runtimeMaterialSha256: initialRuntimeMaterialSha256,
      },
      incrementalRefresh: {
        status: "not-run", measurement: BUDGET_MEASUREMENT,
        budgetMilliseconds: INCREMENTAL_REFRESH_BUDGET_MS, elapsedMilliseconds: null,
      },
    }, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "calibration-answer.json"), `${JSON.stringify({
      status: "not-run",
      question: CALIBRATION_QUESTION,
      affectedBehavior: "unknown",
      codeEvidence: [],
      testEvidence: [],
      graphNodeIds: [],
    }, null, 2)}\n`, "utf8"),
  ]);

  process.stdout.write(`${JSON.stringify({
    command: "prepare",
    artifactRoot,
    snapshotHead,
    upstreamHead,
    included: manifest.counts.included,
  })}\n`);
}

async function runBudgetedCommand(args) {
  const options = parseOptions(args);
  const phase = options.phase;
  if (!PHASES.includes(phase)) {
    throw new Error("--phase must be fullAnalysis or incrementalRefresh");
  }
  const validated = await validateSealedPilotRun(
    options["artifact-root"] ?? resolve(process.cwd(), ".ua-pilot"),
    phase,
  );
  const { artifactRoot, plan, promptText } = validated;
  const budgetMilliseconds = plan.budgetsMilliseconds?.[phase];
  const requiredBudget = phase === "fullAnalysis"
    ? FULL_ANALYSIS_BUDGET_MS
    : INCREMENTAL_REFRESH_BUDGET_MS;
  if (budgetMilliseconds !== requiredBudget ||
      plan.budgetRunner?.measurement !== BUDGET_MEASUREMENT) {
    throw new Error(`${phase} budget runner contract changed`);
  }
  const expectedCommand = buildCodexCommand(plan);
  const invocation = plan.phaseInvocations?.[phase];
  if (JSON.stringify(invocation?.command) !== JSON.stringify(expectedCommand)) {
    throw new Error(`${phase} command contract changed`);
  }
  const expectedPromptFile = phase === "fullAnalysis"
    ? "codex-prompt.md"
    : "incremental-codex-prompt.md";
  if (invocation.promptFile !== expectedPromptFile) {
    throw new Error(`${phase} prompt contract changed`);
  }
  const metric = await runBudgetedPilotPhase({
    phase,
    budgetMilliseconds,
    command: expectedCommand,
    cwd: plan.snapshotCheckout,
    env: { ...buildCodexChildEnv(), ...plan.environment },
    stdinText: promptText,
  });
  metric.runtimeMaterialSha256 = await runtimeMaterialSha256(plan.upstream.checkout);
  metric.snapshotOutputSha256 = await runtimeMaterialSha256(
    plan.snapshotCheckout,
    [".ua/", ".understand-anything/"],
  );
  await Promise.all([
    assertSealedCheckoutState({
      checkout: plan.snapshotCheckout,
      commit: ANALYSIS_SNAPSHOT,
      label: "Analysis Snapshot checkout after runner",
      allowedIgnoredPrefixes: [".ua/", ".understand-anything/"],
      allowedIgnoredDigestSha256: metric.snapshotOutputSha256,
      requireAllowedIgnoredDigest: true,
    }),
    assertSealedCheckoutState({
      checkout: plan.upstream.checkout,
      commit: UPSTREAM_COMMIT,
      label: "Understand-Anything checkout after local build",
      allowedIgnoredPrefixes: UPSTREAM_RUNTIME_PREFIXES,
      allowedIgnoredDigestSha256: metric.runtimeMaterialSha256,
      requireAllowedIgnoredDigest: true,
      allowIgnoredSymlinks: true,
    }),
  ]);
  const metricsPath = resolve(artifactRoot, "run-metrics.json");
  const metrics = await readJson(metricsPath);
  metrics[phase] = metric;
  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ command: "run-budgeted", metric })}\n`);
  if (metric.status !== "completed") {
    throw new Error(`${phase} ${metric.status} after ${metric.elapsedMilliseconds}ms`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function verifyScanCommand(args) {
  const options = parseOptions(args);
  const artifactRoot = await requireApprovedPilotOutput(
    options["artifact-root"] ?? resolve(process.cwd(), ".ua-pilot"),
    "Understand-Anything inventory output",
  );
  const manifest = await readJson(resolve(artifactRoot, "corpus-manifest.json"));
  const planPath = resolve(artifactRoot, "pilot-plan.json");
  const plan = await pathExists(planPath) ? await readJson(planPath) : null;
  const scanResultPath = resolve(
    options["scan-result"] ??
    resolve(plan?.snapshotCheckout ?? artifactRoot, ".ua/intermediate/scan-result.json"),
  );
  const scanResult = await readJson(scanResultPath);
  if (!Array.isArray(manifest.included) || !Array.isArray(scanResult.files)) {
    throw new Error("Corpus manifest and scan result must contain included[] and files[]");
  }

  const expectedPaths = manifest.included.map(({ path }) => path).sort();
  const scannedPaths = scanResult.files.map(({ path }) => path).sort();
  const expected = new Set(expectedPaths);
  const scanned = new Set(scannedPaths);
  const missing = expectedPaths.filter((path) => !scanned.has(path));
  const unexpected = scannedPaths.filter((path) => !expected.has(path));
  const duplicates = scannedPaths.filter((path, index) => index > 0 && scannedPaths[index - 1] === path);
  const report = {
    analysisSnapshot: manifest.analysisSnapshot,
    scanResult: scanResultPath,
    expectedCount: expectedPaths.length,
    scannedCount: scannedPaths.length,
    missing,
    unexpected,
    duplicates,
    passed: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0,
  };
  await writeFile(
    resolve(artifactRoot, "inventory-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (!report.passed) {
    throw new Error(
      `Scan inventory mismatch: missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}; duplicates=${duplicates.join(",") || "none"}`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    command: "verify-scan",
    passed: true,
    scannedCount: report.scannedCount,
  })}\n`);
}

async function verifyArtifactCommand(args) {
  const options = parseOptions(args);
  const artifactRoot = await requireApprovedPilotOutput(
    options["artifact-root"] ?? resolve(process.cwd(), ".ua-pilot"),
    "Understand-Anything verification output",
  );
  const { plan, manifest } = await validateSealedPlanFiles(artifactRoot);
  const prepared = await readJson(resolve(artifactRoot, "prepare-result.json"));
  const metrics = await readJson(resolve(artifactRoot, "run-metrics.json"));
  await assertSealedCheckoutState({
    checkout: plan.snapshotCheckout,
    commit: ANALYSIS_SNAPSHOT,
    label: "Final Analysis Snapshot checkout",
    allowedIgnoredPrefixes: [".ua/", ".understand-anything/"],
    allowedIgnoredDigestSha256: metrics.incrementalRefresh?.snapshotOutputSha256,
    requireAllowedIgnoredDigest: true,
  });
  const finalRuntimeMaterialSha256 = await runtimeMaterialSha256(plan.upstream.checkout);
  if (finalRuntimeMaterialSha256 !== metrics.incrementalRefresh?.runtimeMaterialSha256) {
    throw new Error("Upstream executable build content differs from the final runner digest");
  }
  await assertSealedCheckoutState({
    checkout: plan.upstream.checkout,
    commit: UPSTREAM_COMMIT,
    label: "Final Understand-Anything checkout",
    allowedIgnoredPrefixes: UPSTREAM_RUNTIME_PREFIXES,
    allowedIgnoredDigestSha256: metrics.incrementalRefresh?.runtimeMaterialSha256,
    requireAllowedIgnoredDigest: true,
    allowIgnoredSymlinks: true,
  });
  const calibration = await readJson(resolve(artifactRoot, "calibration-answer.json"));
  const uaDirectory = resolve(plan.snapshotCheckout, ".ua");
  const graph = await readJson(resolve(uaDirectory, "knowledge-graph.json"));
  const meta = await readJson(resolve(uaDirectory, "meta.json"));
  const fingerprints = await readJson(resolve(uaDirectory, "fingerprints.json"));
  const config = await readJson(resolve(uaDirectory, "config.json"));
  const scan = await readJson(resolve(uaDirectory, "intermediate/scan-result.json"));
  const errors = [];

  const requiredBudgets = {
    fullAnalysis: FULL_ANALYSIS_BUDGET_MS,
    incrementalRefresh: INCREMENTAL_REFRESH_BUDGET_MS,
  };
  for (const [name, budget] of Object.entries(requiredBudgets)) {
    if (plan.budgetsMilliseconds?.[name] !== budget) {
      errors.push(`${name} budget contract changed`);
    }
    const metric = metrics[name];
    const expectedCommandSha256 = createHash("sha256")
      .update(JSON.stringify(buildCodexCommand(plan)))
      .digest("hex");
    if (metric?.measurement !== BUDGET_MEASUREMENT ||
        metric?.budgetMilliseconds !== budget || metric?.timedOut !== false ||
        metric?.exitCode !== 0 || metric?.phase !== name || metric?.signal !== null ||
        metric?.spawnError !== null || metric?.commandSha256 !== expectedCommandSha256 ||
        !metric?.runtimeMaterialSha256 || !metric?.snapshotOutputSha256 ||
        !metric?.startedAt || !metric?.finishedAt) {
      errors.push(`${name} timing evidence was not issued by the budgeted child runner`);
    } else if (metric.status !== "completed" || !Number.isFinite(metric.elapsedMilliseconds)) {
      errors.push(`${name} has no completed timing evidence`);
    } else if (metric.elapsedMilliseconds > budget) {
      errors.push(`${name} exceeded budget: ${metric.elapsedMilliseconds}ms > ${budget}ms`);
    }
  }

  if (plan.analysisSnapshot !== ANALYSIS_SNAPSHOT || manifest.analysisSnapshot !== ANALYSIS_SNAPSHOT) {
    errors.push("Analysis Snapshot contract is not pinned to the required revision");
  }
  if (plan.upstream?.commit !== UPSTREAM_COMMIT || prepared.upstreamHead !== UPSTREAM_COMMIT) {
    errors.push("Understand-Anything upstream commit is not the reviewed pin");
  }
  if (prepared.snapshotHead !== ANALYSIS_SNAPSHOT || prepared.snapshotClean !== true) {
    errors.push("prepared Analysis Snapshot is not exact and clean");
  }
  if (prepared.globalInstallerUsed !== false || prepared.symlinksCreated !== false) {
    errors.push("prepare evidence permits a global installer or symlink");
  }
  if (plan.provider !== "current-codex-provider-only" ||
      plan.environment?.UNDERSTAND_NO_WORKTREE_REDIRECT !== "1" ||
      !plan.understandArguments?.includes("--no-auto-update")) {
    errors.push("provider, worktree redirect, or auto-update policy changed");
  }
  if (config.autoUpdate !== false || config.outputLanguage !== "ko") {
    errors.push("Understand-Anything config must disable auto-update and use ko output");
  }
  if (graph.project?.gitCommitHash !== ANALYSIS_SNAPSHOT) {
    errors.push(`knowledge graph commit mismatch: ${graph.project?.gitCommitHash ?? "missing"}`);
  }
  if (meta.gitCommitHash !== ANALYSIS_SNAPSHOT) {
    errors.push(`meta commit mismatch: ${meta.gitCommitHash ?? "missing"}`);
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      !Array.isArray(graph.layers) || !Array.isArray(graph.tour)) {
    errors.push("knowledge graph is missing nodes, edges, layers, or tour arrays");
  }
  if (!fingerprints.files || Object.keys(fingerprints.files).length === 0) {
    errors.push("fingerprints contain no analyzed files");
  }

  const includedByPath = new Map((manifest.included ?? []).map((entry) => [entry.path, entry]));
  const expected = new Set(includedByPath.keys());
  const scanned = new Set((scan.files ?? []).map(({ path }) => path));
  const missing = [...expected].filter((path) => !scanned.has(path));
  const unexpected = [...scanned].filter((path) => !expected.has(path));
  if (missing.length || unexpected.length || scanned.size !== scan.files?.length) {
    errors.push(
      `scan inventory mismatch: missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}`,
    );
  }

  if (calibration.status !== "completed" || !calibration.question ||
      !calibration.affectedBehavior || !Array.isArray(calibration.codeEvidence) ||
      calibration.codeEvidence.length === 0 || !Array.isArray(calibration.testEvidence) ||
      calibration.testEvidence.length === 0) {
    errors.push("calibration answer lacks behavior, code evidence, or test evidence");
  }
  for (const evidence of calibration.codeEvidence ?? []) {
    if (!includedByPath.has(evidence.path) || !evidence.symbol) {
      errors.push(`invalid calibration code evidence: ${evidence.path ?? "missing"}`);
    }
  }
  for (const evidence of calibration.testEvidence ?? []) {
    if (includedByPath.get(evidence.path)?.category !== "test" || !evidence.test) {
      errors.push(`invalid calibration test evidence: ${evidence.path ?? "missing"}`);
    }
  }
  const nodeIds = new Set((graph.nodes ?? []).map(({ id }) => id));
  for (const nodeId of calibration.graphNodeIds ?? []) {
    if (!nodeIds.has(nodeId)) errors.push(`calibration references missing graph node: ${nodeId}`);
  }
  if (!Array.isArray(calibration.graphNodeIds) || calibration.graphNodeIds.length === 0) {
    errors.push("calibration answer lacks graph node evidence");
  }

  const report = {
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    graphNodes: graph.nodes?.length ?? 0,
    graphEdges: graph.edges?.length ?? 0,
    scannedFiles: scan.files?.length ?? 0,
    metrics,
    errors,
    passed: errors.length === 0,
  };
  await writeFile(
    resolve(artifactRoot, "artifact-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  if (!report.passed) throw new Error(`Pilot Artifact rejected: ${errors.join("; ")}`);
  process.stdout.write(`${JSON.stringify({ command: "verify-artifact", passed: true })}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") {
    await manifestCommand(args);
    return;
  }
  if (command === "plan") {
    await planCommand(args);
    return;
  }
  if (command === "prepare") {
    await prepareCommand(args);
    return;
  }
  if (command === "verify-scan") {
    await verifyScanCommand(args);
    return;
  }
  if (command === "verify-artifact") {
    await verifyArtifactCommand(args);
    return;
  }
  if (command === "run-budgeted") {
    await runBudgetedCommand(args);
    return;
  }
  throw new Error(
    "Usage: node understand-anything-pilot.mjs " +
    "<manifest|plan|prepare|verify-scan|verify-artifact|run-budgeted> " +
    "[--repo PATH] [--artifact-root PATH] [--upstream-source PATH_OR_URL]",
  );
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`understand-anything-pilot: ${error.message}\n`);
    process.exitCode = 1;
  });
}
