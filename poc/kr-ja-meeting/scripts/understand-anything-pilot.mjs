#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ANALYSIS_SNAPSHOT = "5bf36dd61b6355368d736479c5ffb528b656d544";
export const UPSTREAM_REPOSITORY = "https://github.com/Egonex-AI/Understand-Anything.git";
export const UPSTREAM_COMMIT = "ba450c43425f3de6d43daf76526950ad8ca93536";
export const FULL_ANALYSIS_BUDGET_MS = 30 * 60 * 1000;
export const INCREMENTAL_REFRESH_BUDGET_MS = 5 * 60 * 1000;
export const CALIBRATION_QUESTION =
  "Live Translate가 completion event를 보내지 않을 때 phraseBoundary()는 번역 오디오를 " +
  "유실하지 않고 다음 입력 구간을 어떻게 시작하며, 첫 audible output이 없으면 어떻게 실패하는가?";

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

async function manifestCommand(args) {
  const options = parseOptions(args);
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const artifactRoot = resolve(options["artifact-root"] ?? resolve(repo, ".ua-pilot"));
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
  return {
    contractVersion: 1,
    analysisSnapshot: ANALYSIS_SNAPSHOT,
    upstream: {
      repository: UPSTREAM_REPOSITORY,
      commit: UPSTREAM_COMMIT,
      checkout: upstreamCheckout,
      installScope: "artifact-local",
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
}

function buildCodexPrompt(plan) {
  const skillPath = resolve(
    plan.upstream.checkout,
    "understand-anything-plugin/skills/understand/SKILL.md",
  );
  return `Execute the pinned Understand-Anything full analysis for the local AIN-7639 pilot.\n\n` +
    `1. Read the complete upstream skill at ${skillPath}.\n` +
    `   If core dist is absent, run the plan's localBuild commands only in ` +
    `${plan.upstream.pluginRoot}; do not install globally.\n` +
    `2. Analyze only ${plan.snapshotCheckout}, whose HEAD must equal ${plan.analysisSnapshot}.\n` +
    `3. Use the pre-approved .ua/.understandignore without prompting. Keep ` +
    `UNDERSTAND_NO_WORKTREE_REDIRECT=1.\n` +
    `4. Apply --full --language ko --no-auto-update. Do not install globally, create symlinks, ` +
    `add hooks, add credentials/providers, or modify tracked source files.\n` +
    `5. Use the current Codex provider. Write only local .ua artifacts. Preserve scan-result.json.\n` +
    `6. Stop with a non-zero result if the analysis cannot finish within the enclosing budget.\n`;
}

async function planCommand(args) {
  const options = parseOptions(args);
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const artifactRoot = resolve(options["artifact-root"] ?? resolve(repo, ".ua-pilot"));
  const plan = buildPilotPlan(repo, artifactRoot);
  await mkdir(artifactRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(artifactRoot, "pilot-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "codex-prompt.md"), buildCodexPrompt(plan), "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({ command: "plan", artifactRoot })}\n`);
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
  const repo = options.repo ? resolve(options.repo) : process.cwd();
  const artifactRoot = resolve(options["artifact-root"] ?? resolve(repo, ".ua-pilot"));
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

  await Promise.all([
    writeFile(resolve(artifactRoot, "corpus-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "pilot-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "codex-prompt.md"), buildCodexPrompt(plan), "utf8"),
    writeFile(resolve(artifactRoot, "prepare-result.json"), `${JSON.stringify({
      snapshotHead,
      upstreamHead,
      snapshotClean: true,
      globalInstallerUsed: false,
      symlinksCreated: false,
    }, null, 2)}\n`, "utf8"),
    writeFile(resolve(artifactRoot, "run-metrics.json"), `${JSON.stringify({
      fullAnalysis: { status: "not-run", elapsedMilliseconds: null },
      incrementalRefresh: { status: "not-run", elapsedMilliseconds: null },
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function verifyScanCommand(args) {
  const options = parseOptions(args);
  const artifactRoot = resolve(options["artifact-root"] ?? resolve(process.cwd(), ".ua-pilot"));
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
  const artifactRoot = resolve(options["artifact-root"] ?? resolve(process.cwd(), ".ua-pilot"));
  const plan = await readJson(resolve(artifactRoot, "pilot-plan.json"));
  const manifest = await readJson(resolve(artifactRoot, "corpus-manifest.json"));
  const prepared = await readJson(resolve(artifactRoot, "prepare-result.json"));
  const metrics = await readJson(resolve(artifactRoot, "run-metrics.json"));
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
    if (metric?.status !== "completed" || !Number.isFinite(metric?.elapsedMilliseconds)) {
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
  throw new Error(
    "Usage: node understand-anything-pilot.mjs " +
    "<manifest|plan|prepare|verify-scan|verify-artifact> " +
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
