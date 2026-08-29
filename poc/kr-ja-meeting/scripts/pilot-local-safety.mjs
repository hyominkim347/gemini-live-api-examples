import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const CODEX_MATERIAL_PROFILE = "ua_pilot_material_only";

const CODEX_CHILD_ENV_KEYS = [
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
];

function pathIsInside(parent, child) {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === "" || (!fromParent.startsWith(`..${sep}`) && fromParent !== ".." && !isAbsolute(fromParent));
}

function requireDescendant(parent, child, label) {
  if (resolve(parent) === resolve(child) || !pathIsInside(parent, child)) {
    throw new Error(`${label} must be below ${resolve(parent)}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function nearestExistingPath(path) {
  let candidate = resolve(path);
  for (;;) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

async function canonicalPath(path) {
  const absolute = resolve(path);
  const existing = await nearestExistingPath(absolute);
  const canonicalExisting = await realpath(existing);
  return resolve(canonicalExisting, relative(existing, absolute));
}

async function regularFile(path, label) {
  let fileStat;
  try {
    fileStat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

async function readRegularTextWithin(root, relativePath, label) {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${label} path is unsafe`);
  }
  const canonicalRoot = await canonicalPath(root);
  const requested = resolve(canonicalRoot, relativePath);
  requireDescendant(canonicalRoot, requested, label);
  await regularFile(requested, label);
  const canonicalFile = await canonicalPath(requested);
  requireDescendant(canonicalRoot, canonicalFile, label);
  return { path: canonicalFile, text: await readFile(canonicalFile, "utf8") };
}

export function resolvePilotChildPath(root, relativePath, label = "Pilot path") {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${label} is unsafe`);
  }
  const child = resolve(root, relativePath);
  requireDescendant(root, child, label);
  return child;
}

export function readRegularPilotFile(root, relativePath, label = "Pilot file") {
  return readRegularTextWithin(root, relativePath, label);
}

export async function requirePilotChildDirectory(
  root,
  relativePath,
  label = "Pilot directory",
  { create = false } = {},
) {
  const canonicalRoot = await canonicalPath(root);
  const requested = resolvePilotChildPath(canonicalRoot, relativePath, label);
  const parts = relative(canonicalRoot, requested).split(sep).filter(Boolean);
  let child = canonicalRoot;
  for (const part of parts) {
    child = resolve(child, part);
    try {
      const childStat = await lstat(child);
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
        throw new Error(`${label} must not contain symlinked directories`);
      }
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(child, { mode: 0o700 });
    }
  }
  return child;
}

function gitResult(path, args, allowedStatuses = new Set([0])) {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowedStatuses.has(result.status)) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function requireGitText(path, args, label) {
  try {
    return gitResult(path, args).stdout.trim();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function containingGitCheckout(path) {
  const existing = await nearestExistingPath(path);
  const result = gitResult(
    existing,
    ["rev-parse", "--show-toplevel"],
    new Set([0, 128]),
  );
  return result.status === 0 ? resolve(result.stdout.trim()) : null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export async function requireApprovedPilotOutput(path, label = "Pilot output") {
  const requested = resolve(path);
  const output = await canonicalPath(requested);
  if (!requested.split(sep).includes(".ua-pilot") || !output.split(sep).includes(".ua-pilot")) {
    throw new Error(`${label} must be stored below an exact .ua-pilot directory`);
  }
  const checkout = await containingGitCheckout(output);
  if (!checkout) return output;
  const ignored = gitResult(
    checkout,
    ["check-ignore", "-q", "--", output],
    new Set([0, 1]),
  );
  if (ignored.status !== 0) {
    throw new Error(`${label} inside Git must be ignored local .ua-pilot storage`);
  }
  return output;
}

export async function initializeEmptyPilotOutput(path, label = "Pilot output") {
  const output = await requireApprovedPilotOutput(path, label);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const outputStat = await lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a local directory`);
  }
  const entries = await readdir(output);
  if (entries.length > 0) {
    throw new Error(`${label} must be new and empty`);
  }
  return output;
}

export async function assertIsolatedMaterialRoot(path) {
  const materialRoot = await canonicalPath(path);
  const requestedTemporaryRoots = new Set([resolve(tmpdir())]);
  if (process.platform === "darwin") requestedTemporaryRoots.add(resolve("/private/tmp"));
  if (process.platform !== "win32") requestedTemporaryRoots.add(resolve("/tmp"));
  for (const requestedTemporaryRoot of requestedTemporaryRoots) {
    const temporaryRoot = await canonicalPath(requestedTemporaryRoot);
    if (pathIsInside(temporaryRoot, materialRoot)) {
      throw new Error(
        `Agent material root must not use platform temporary storage: ${temporaryRoot}`,
      );
    }
  }
  if (await containingGitCheckout(materialRoot)) {
    throw new Error("Agent material root must be outside every Git checkout");
  }
  return materialRoot;
}

export async function createIsolatedMaterialRoot(prefix) {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error("Agent material prefix is invalid");
  const base = await requireApprovedPilotOutput(
    resolve(homedir(), ".ua-pilot"),
    "Agent material base",
  );
  await mkdir(base, { recursive: true, mode: 0o700 });
  const materialRoot = await mkdtemp(resolve(base, prefix));
  await assertIsolatedMaterialRoot(materialRoot);
  return materialRoot;
}

export function buildCodexChildEnv(source = process.env) {
  const environment = {};
  for (const key of CODEX_CHILD_ENV_KEYS) {
    if (typeof source[key] === "string" && source[key]) environment[key] = source[key];
  }
  return environment;
}

export function spawnCodexChild({ executable, args, prompt, timeoutMs }) {
  return spawnSync(executable, args, {
    input: prompt,
    env: buildCodexChildEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function buildCodexPermissionConfig(materialRoot) {
  const root = resolve(materialRoot);
  const profile = {
    filesystem: {
      ":minimal": "read",
      [root]: "read",
    },
    network: { enabled: false },
  };
  const filesystem = Object.entries(profile.filesystem)
    .map(([path, access]) => `${tomlString(path)}=${tomlString(access)}`)
    .join(", ");
  const inlineProfile =
    `permissions.${CODEX_MATERIAL_PROFILE}={` +
    `filesystem={${filesystem}}, network={enabled=false}}`;
  return [
    "-c",
    `default_permissions=${tomlString(CODEX_MATERIAL_PROFILE)}`,
    "-c",
    inlineProfile,
    "-c",
    "approval_policy=\"never\"",
    "-c",
    "shell_environment_policy.inherit=\"none\"",
  ];
}

async function prepareCopyTarget(targetRoot, target, label) {
  const requestedRoot = resolve(targetRoot);
  const requestedTarget = resolve(target);
  requireDescendant(requestedRoot, requestedTarget, label);
  const canonicalRoot = await canonicalPath(targetRoot);
  const requested = resolve(canonicalRoot, relative(requestedRoot, requestedTarget));
  requireDescendant(canonicalRoot, requested, label);
  const parentParts = relative(canonicalRoot, dirname(requested)).split(sep).filter(Boolean);
  let parent = canonicalRoot;
  for (const part of parentParts) {
    parent = resolve(parent, part);
    try {
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error(`${label} parent must not be a symlink`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(parent, { mode: 0o700 });
    }
  }
  try {
    await lstat(requested);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return requested;
}

export async function copyRegularFileWithin({ sourceRoot, relativePath, targetRoot, targetPath }) {
  const source = await readRegularTextWithin(sourceRoot, relativePath, "Agent material source");
  const target = await prepareCopyTarget(targetRoot, targetPath, "Agent material target");
  await copyFile(source.path, target);
}

export async function copyTrackedCorpus({ snapshotRoot, included, targetRoot }) {
  const sourceRoot = await canonicalPath(snapshotRoot);
  const destinationRoot = await canonicalPath(targetRoot);
  for (const entry of included) {
    if (!entry?.path || isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe Analysis Corpus path: ${entry?.path ?? "missing"}`);
    }
    const source = resolve(sourceRoot, entry.path);
    const target = resolve(destinationRoot, entry.path);
    requireDescendant(sourceRoot, source, "Analysis Corpus source");
    await regularFile(source, `Analysis Corpus file ${entry.path}`);
    await prepareCopyTarget(destinationRoot, target, `Agent material file ${entry.path}`);
    await copyFile(source, target);
  }
}

export async function digestMaterialRoot(path) {
  const root = await canonicalPath(path);
  const rows = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Agent material must not contain symlinks");
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) throw new Error("Agent material must contain only regular files");
      const relativePath = relative(root, entryPath);
      rows.push(`${relativePath}\0${sha256(await readFile(entryPath))}`);
    }
  }
  await walk(root);
  return sha256(rows.join("\n"));
}

export async function validateIsolatedMaterialLayout({ root, children }) {
  const approvedRoot = await requireApprovedPilotOutput(root, "Agent material root");
  const materialRoot = await assertIsolatedMaterialRoot(approvedRoot);
  const canonicalChildren = {};
  for (const [label, child] of Object.entries(children)) {
    const canonicalChild = await canonicalPath(child);
    requireDescendant(materialRoot, canonicalChild, `Agent ${label} material`);
    const childStat = await lstat(canonicalChild);
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new Error(`Agent ${label} material must be a regular directory`);
    }
    canonicalChildren[label] = canonicalChild;
  }
  return { root: materialRoot, children: canonicalChildren };
}

function trackedTree(repo, commit) {
  const output = requireGitText(
    repo,
    ["ls-tree", "-r", "-z", "--format=%(objectname)%x09%(path)", commit],
    "tracked tree check",
  );
  const entries = new Map();
  for (const row of output.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    if (tab <= 0) throw new Error("tracked tree emitted an invalid row");
    entries.set(row.slice(tab + 1), row.slice(0, tab));
  }
  return entries;
}

function validateManifestPaths(manifest, tree) {
  if (!Array.isArray(manifest.included) || !Array.isArray(manifest.excluded)) {
    throw new Error("Analysis Corpus manifest requires included[] and excluded[]");
  }
  const seen = new Set();
  for (const entry of [...manifest.included, ...manifest.excluded]) {
    if (
      !entry?.path ||
      isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes("..") ||
      seen.has(entry.path) ||
      !tree.has(entry.path)
    ) {
      throw new Error(`Analysis Corpus manifest has an unsafe or non-snapshot path: ${entry?.path ?? "missing"}`);
    }
    seen.add(entry.path);
  }
  if (seen.size !== tree.size) {
    throw new Error("Analysis Corpus manifest does not partition the complete tracked snapshot");
  }
}

function corpusDigest(manifest, tree) {
  const rows = manifest.included
    .map(({ path, category }) => `${path}\0${category}\0${tree.get(path)}`)
    .sort();
  return sha256(rows.join("\n"));
}

export async function loadVerifiedPilotArtifact({
  artifactRoot: requestedArtifactRoot,
  analysisSnapshot,
  upstreamCommit,
  expectedManifest,
  expectedManifestForSource,
  provider = "current-codex-provider-only",
}) {
  const artifactRoot = await requireApprovedPilotOutput(
    requestedArtifactRoot,
    "Pilot Artifact root",
  );
  const [planFile, manifestFile, preparedFile, verificationFile, inventoryFile] =
    await Promise.all([
      readRegularTextWithin(artifactRoot, "pilot-plan.json", "pilot plan"),
      readRegularTextWithin(artifactRoot, "corpus-manifest.json", "corpus manifest"),
      readRegularTextWithin(artifactRoot, "prepare-result.json", "prepare evidence"),
      readRegularTextWithin(artifactRoot, "artifact-verification.json", "artifact verification"),
      readRegularTextWithin(artifactRoot, "inventory-verification.json", "inventory verification"),
    ]);
  const planText = planFile.text;
  const manifestText = manifestFile.text;
  const plan = JSON.parse(planText);
  const manifest = JSON.parse(manifestText);
  const prepared = JSON.parse(preparedFile.text);
  const verification = JSON.parse(verificationFile.text);
  const inventory = JSON.parse(inventoryFile.text);

  const sourceRepository = await canonicalPath(plan.sourceRepository ?? "");
  const snapshotRoot = await canonicalPath(plan.snapshotCheckout ?? "");
  const upstreamRoot = await canonicalPath(plan.upstream?.checkout ?? "");
  const graphDirectory = await canonicalPath(plan.artifacts?.graphDirectory ?? "");
  if (await canonicalPath(plan.artifacts?.root ?? "") !== artifactRoot) {
    throw new Error("Pilot Artifact root does not match its pinned plan");
  }
  requireDescendant(artifactRoot, snapshotRoot, "snapshot checkout");
  requireDescendant(artifactRoot, upstreamRoot, "upstream checkout");
  requireDescendant(snapshotRoot, graphDirectory, "graph directory");

  if (
    plan.analysisSnapshot !== analysisSnapshot ||
    manifest.analysisSnapshot !== analysisSnapshot ||
    prepared.snapshotHead !== analysisSnapshot ||
    verification.analysisSnapshot !== analysisSnapshot
  ) {
    throw new Error(`Pilot Artifact must use Analysis Snapshot ${analysisSnapshot}`);
  }
  if (
    plan.upstream?.commit !== upstreamCommit ||
    prepared.upstreamHead !== upstreamCommit
  ) {
    throw new Error(`Pilot Artifact must use reviewed upstream commit ${upstreamCommit}`);
  }
  if (
    plan.provider !== provider ||
    plan.upstream?.installScope !== "artifact-local" ||
    plan.artifacts?.commitPolicy !== "local-uncommitted-only" ||
    prepared.snapshotClean !== true ||
    prepared.globalInstallerUsed !== false ||
    prepared.symlinksCreated !== false ||
    verification.passed !== true ||
    inventory.passed !== true
  ) {
    throw new Error("Pilot Artifact local-only verification policy is not satisfied");
  }

  const snapshotHead = requireGitText(snapshotRoot, ["rev-parse", "HEAD"], "snapshot HEAD check");
  const upstreamHead = requireGitText(upstreamRoot, ["rev-parse", "HEAD"], "upstream HEAD check");
  if (snapshotHead !== analysisSnapshot || upstreamHead !== upstreamCommit) {
    throw new Error("Pilot Artifact checkout pins changed after graph generation");
  }
  const snapshotStatus = requireGitText(
    snapshotRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "snapshot tracked-state check",
  );
  const upstreamStatus = requireGitText(
    upstreamRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "upstream tracked-state check",
  );
  if (snapshotStatus) throw new Error(`Snapshot checkout has tracked changes: ${snapshotStatus}`);
  if (upstreamStatus) throw new Error(`Pinned upstream checkout has tracked changes: ${upstreamStatus}`);

  const sourceSnapshot = requireGitText(
    sourceRepository,
    ["rev-parse", `${analysisSnapshot}^{commit}`],
    "source snapshot check",
  );
  if (sourceSnapshot !== analysisSnapshot) {
    throw new Error("Source repository does not contain the exact Analysis Snapshot");
  }
  const deterministicManifest = expectedManifest ?? expectedManifestForSource?.(sourceRepository);
  if (!deterministicManifest) {
    throw new Error("Pilot Artifact verification requires a deterministic manifest");
  }
  if (JSON.stringify(manifest) !== JSON.stringify(deterministicManifest)) {
    throw new Error("Analysis Corpus manifest differs from the deterministic snapshot manifest");
  }
  const tree = trackedTree(sourceRepository, analysisSnapshot);
  validateManifestPaths(manifest, tree);
  const includedPaths = manifest.included.map(({ path }) => path).sort();
  const scanFile = await readRegularTextWithin(
    graphDirectory,
    "intermediate/scan-result.json",
    "scan result",
  );
  const scan = JSON.parse(scanFile.text);
  const scannedPaths = (scan.files ?? []).map(({ path }) => path).sort();
  if (
    JSON.stringify(scannedPaths) !== JSON.stringify(includedPaths) ||
    inventory.expectedCount !== includedPaths.length ||
    inventory.scannedCount !== includedPaths.length ||
    inventory.missing?.length !== 0 ||
    inventory.unexpected?.length !== 0 ||
    inventory.duplicates?.length !== 0
  ) {
    throw new Error("Pilot Artifact inventory no longer matches the deterministic Analysis Corpus");
  }

  const graphFile = await readRegularTextWithin(
    graphDirectory,
    "knowledge-graph.json",
    "knowledge graph",
  );
  const graphPath = graphFile.path;
  const graph = JSON.parse(graphFile.text);
  if (
    graph.project?.gitCommitHash !== analysisSnapshot ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.layers) ||
    !Array.isArray(graph.tour)
  ) {
    throw new Error("Pilot Artifact knowledge graph identity or structure is invalid");
  }

  return {
    artifactRoot,
    corpusDigestSha256: corpusDigest(manifest, tree),
    graph,
    graphDirectory,
    graphPath,
    graphSha256: sha256(graphFile.text),
    manifest,
    manifestSha256: sha256(manifestText),
    plan,
    planSha256: sha256(planText),
    snapshotRoot,
    sourceRepository,
    upstreamRoot,
  };
}
