import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../..");
const pilotScript = resolve(here, "../scripts/understand-anything-pilot.mjs");
const snapshot = "5bf36dd61b6355368d736479c5ffb528b656d544";

function runPilot(args, options = {}) {
  return spawnSync(process.execPath, [pilotScript, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });
}

test("manifest fixes the Analysis Snapshot and excludes non-corpus files", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-manifest-"));
  const untrackedSentinel = join(projectRoot, "ua-pilot-untracked-secret.env");

  try {
    await writeFile(untrackedSentinel, "SHOULD_NOT_ENTER_CORPUS=true\n", "utf8");
    const result = runPilot([
      "manifest",
      "--repo", projectRoot,
      "--artifact-root", artifactRoot,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(await readFile(join(artifactRoot, "corpus-manifest.json"), "utf8"));
    const included = new Set(manifest.included.map(({ path }) => path));
    const excluded = new Map(manifest.excluded.map(({ path, reason }) => [path, reason]));

    assert.equal(manifest.analysisSnapshot, snapshot);
    assert.equal(manifest.selection.trackedOnly, true);
    assert.equal(manifest.selection.ignoredAndUntrackedExcludedByConstruction, true);
    assert.ok(included.has("poc/kr-ja-meeting/src/meeting-session.mjs"));
    assert.ok(included.has("poc/kr-ja-meeting/test/meeting-session.test.mjs"));
    assert.ok(included.has("poc/kr-ja-meeting/README.md"));
    assert.equal(excluded.get("poc/kr-ja-meeting/package-lock.json"), "dependency");
    assert.equal(excluded.get("gemini-live-genai-python-sdk/.env.example"), "secret-bearing-path");
    assert.equal(included.has("ua-pilot-untracked-secret.env"), false);
    assert.equal(excluded.has("ua-pilot-untracked-secret.env"), false);
  } finally {
    await rm(untrackedSentinel, { force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("plan pins isolated upstream execution and disables redirect and automation", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-plan-"));

  try {
    const result = runPilot([
      "plan",
      "--repo", projectRoot,
      "--artifact-root", artifactRoot,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(await readFile(join(artifactRoot, "pilot-plan.json"), "utf8"));
    assert.equal(plan.analysisSnapshot, snapshot);
    assert.equal(plan.upstream.commit, "ba450c43425f3de6d43daf76526950ad8ca93536");
    assert.deepEqual(plan.upstream.localBuild, [
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
      ["corepack", "pnpm", "--filter", "@understand-anything/core", "build"],
    ]);
    assert.equal(plan.environment.UNDERSTAND_NO_WORKTREE_REDIRECT, "1");
    assert.deepEqual(plan.understandArguments, ["--full", "--language", "ko", "--no-auto-update"]);
    assert.equal(plan.provider, "current-codex-provider-only");
    assert.equal(plan.artifacts.commitPolicy, "local-uncommitted-only");
    assert.ok(plan.prohibited.includes("global-installer"));
    assert.ok(plan.prohibited.includes("symlink"));
    assert.ok(plan.prohibited.includes("new-provider-credentials"));
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("prepare refuses an upstream source that lacks the reviewed commit", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-prepare-reject-"));

  try {
    const result = runPilot([
      "prepare",
      "--repo", projectRoot,
      "--artifact-root", artifactRoot,
      "--upstream-source", projectRoot,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ba450c43425f3de6d43daf76526950ad8ca93536/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verify-scan rejects any inventory outside the tracked Analysis Corpus", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-verify-scan-"));
  const scanResult = join(artifactRoot, "scan-result.json");

  try {
    await writeFile(join(artifactRoot, "corpus-manifest.json"), JSON.stringify({
      analysisSnapshot: snapshot,
      included: [{ path: "src/app.mjs", category: "code" }],
    }), "utf8");
    await writeFile(scanResult, JSON.stringify({
      files: [{ path: "src/app.mjs" }, { path: "untracked.env" }],
    }), "utf8");

    const result = runPilot([
      "verify-scan",
      "--artifact-root", artifactRoot,
      "--scan-result", scanResult,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected=untracked\.env/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verify-artifact rejects a run that exceeds the declared budget", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-verify-artifact-"));
  const snapshotCheckout = join(artifactRoot, "analysis-snapshot");
  const uaDirectory = join(snapshotCheckout, ".ua");
  const intermediate = join(uaDirectory, "intermediate");

  try {
    await mkdir(intermediate, { recursive: true });
    await writeFile(join(artifactRoot, "pilot-plan.json"), JSON.stringify({
      analysisSnapshot: snapshot,
      snapshotCheckout,
      upstream: { commit: "ba450c43425f3de6d43daf76526950ad8ca93536" },
      provider: "current-codex-provider-only",
      environment: { UNDERSTAND_NO_WORKTREE_REDIRECT: "1" },
      understandArguments: ["--full", "--language", "ko", "--no-auto-update"],
      budgetsMilliseconds: { fullAnalysis: 1_800_000, incrementalRefresh: 300_000 },
    }), "utf8");
    await writeFile(join(artifactRoot, "prepare-result.json"), JSON.stringify({
      snapshotHead: snapshot,
      upstreamHead: "ba450c43425f3de6d43daf76526950ad8ca93536",
      snapshotClean: true,
      globalInstallerUsed: false,
      symlinksCreated: false,
    }), "utf8");
    await writeFile(join(artifactRoot, "corpus-manifest.json"), JSON.stringify({
      analysisSnapshot: snapshot,
      included: [
        { path: "src/bridge.mjs", category: "code" },
        { path: "test/bridge.test.mjs", category: "test" },
      ],
    }), "utf8");
    await writeFile(join(uaDirectory, "knowledge-graph.json"), JSON.stringify({
      project: { gitCommitHash: snapshot },
      nodes: [
        { id: "file:src/bridge.mjs", filePath: "src/bridge.mjs" },
        { id: "file:test/bridge.test.mjs", filePath: "test/bridge.test.mjs" },
      ],
      edges: [], layers: [], tour: [],
    }), "utf8");
    await writeFile(join(uaDirectory, "meta.json"), JSON.stringify({ gitCommitHash: snapshot }), "utf8");
    await writeFile(join(uaDirectory, "fingerprints.json"), JSON.stringify({
      files: { "src/bridge.mjs": { hash: "fixture" } },
    }), "utf8");
    await writeFile(join(uaDirectory, "config.json"), JSON.stringify({
      autoUpdate: false,
      outputLanguage: "ko",
    }), "utf8");
    await writeFile(join(intermediate, "scan-result.json"), JSON.stringify({
      files: [{ path: "src/bridge.mjs" }, { path: "test/bridge.test.mjs" }],
    }), "utf8");
    await writeFile(join(artifactRoot, "calibration-answer.json"), JSON.stringify({
      status: "completed",
      question: "How does phrase boundary drain translated audio?",
      affectedBehavior: "phrase boundary drains translated audio",
      codeEvidence: [{ path: "src/bridge.mjs", symbol: "Bridge.phraseBoundary" }],
      testEvidence: [{ path: "test/bridge.test.mjs", test: "drains audio" }],
      graphNodeIds: ["file:src/bridge.mjs", "file:test/bridge.test.mjs"],
    }), "utf8");
    await writeFile(join(artifactRoot, "run-metrics.json"), JSON.stringify({
      fullAnalysis: { status: "completed", elapsedMilliseconds: 1_800_001 },
      incrementalRefresh: { status: "completed", elapsedMilliseconds: 1 },
    }), "utf8");

    const result = runPilot(["verify-artifact", "--artifact-root", artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fullAnalysis exceeded budget/);

    await writeFile(join(artifactRoot, "run-metrics.json"), JSON.stringify({
      fullAnalysis: { status: "completed", elapsedMilliseconds: 1_800_000 },
      incrementalRefresh: { status: "completed", elapsedMilliseconds: 300_000 },
    }), "utf8");
    const accepted = runPilot(["verify-artifact", "--artifact-root", artifactRoot]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const report = JSON.parse(await readFile(join(artifactRoot, "artifact-verification.json"), "utf8"));
    assert.equal(report.passed, true);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
