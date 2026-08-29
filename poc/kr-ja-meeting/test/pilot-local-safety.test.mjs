import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CODEX_MATERIAL_PROFILE,
  assertIsolatedMaterialRoot,
  buildCodexChildEnv,
  buildCodexPermissionConfig,
  copyTrackedCorpus,
  digestMaterialRoot,
  initializeEmptyPilotOutput,
  loadVerifiedPilotArtifact,
  requireApprovedPilotOutput,
  requirePosixProcessGroups,
  requirePilotChildDirectory,
  spawnCodexChild,
} from "../scripts/pilot-local-safety.mjs";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("pilot outputs are .ua-pilot paths that are ignored inside Git or outside Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-output-guard-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside", ".ua-pilot", "run");
  try {
    await mkdir(repo, { recursive: true });
    git(repo, ["init", "--quiet"]);
    await writeFile(join(repo, ".gitignore"), ".ua-pilot/\n", "utf8");

    assert.match(
      await requireApprovedPilotOutput(join(repo, ".ua-pilot", "run"), "test output"),
      /\/repo\/\.ua-pilot\/run$/,
    );
    assert.match(
      await requireApprovedPilotOutput(outside, "test output"),
      /\/outside\/\.ua-pilot\/run$/,
    );
    await assert.rejects(
      requireApprovedPilotOutput(join(repo, "visible-output"), "test output"),
      /\.ua-pilot/,
    );
    await assert.rejects(
      requireApprovedPilotOutput(join(repo, ".ua-pilot-visible", "run"), "test output"),
      /\.ua-pilot/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new Pilot outputs reject pre-seeded content before a runner can reuse it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-output-empty-"));
  const output = join(root, ".ua-pilot", "run");
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "preseeded-answer.json"), "{}\n", "utf8");
    await assert.rejects(
      initializeEmptyPilotOutput(output, "test output"),
      /new and empty/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corpus copy rejects a pre-existing destination symlink without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-copy-symlink-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const outside = join(root, "outside.txt");
  try {
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "app.mjs"), "approved\n", "utf8");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(target, "app.mjs"));

    await assert.rejects(
      copyTrackedCorpus({
        snapshotRoot: source,
        included: [{ path: "app.mjs", category: "code" }],
        targetRoot: target,
      }),
      /already exists|symlink/,
    );
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pilot run directories reject a symlinked descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-run-symlink-"));
  const output = join(root, ".ua-pilot", "run");
  const outside = join(root, "outside");
  try {
    await mkdir(join(output, "runs"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(output, "runs", "01-question-graph"), "dir");
    await assert.rejects(
      requirePilotChildDirectory(
        output,
        "runs/01-question-graph",
        "test run",
        { create: true },
      ),
      /symlinked directories/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("material digest changes when prepared material changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-material-digest-"));
  try {
    await writeFile(join(root, "graph.json"), "one\n", "utf8");
    const before = await digestMaterialRoot(root);
    await writeFile(join(root, "graph.json"), "two\n", "utf8");
    assert.notEqual(await digestMaterialRoot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex child environment is an allowlist with no provider or secret variables", () => {
  const child = buildCodexChildEnv({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "must-not-pass",
    ANTHROPIC_API_KEY: "must-not-pass",
    GEMINI_API_KEY: "must-not-pass",
    AWS_SECRET_ACCESS_KEY: "must-not-pass",
    PILOT_SENTINEL_SECRET: "must-not-pass",
  });

  assert.deepEqual(child, {
    CODEX_HOME: "/safe/codex",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    PATH: "/safe/bin",
  });
});

test("process-group timeouts fail closed on Windows", () => {
  assert.throws(
    () => requirePosixProcessGroups("win32"),
    /requires a POSIX platform/,
  );
  assert.doesNotThrow(() => requirePosixProcessGroups("darwin"));
  assert.doesNotThrow(() => requirePosixProcessGroups("linux"));
});

test("Codex timeout kills the child process group before a descendant side effect", {
  skip: process.platform === "win32" ? "POSIX process groups are required" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-codex-timeout-"));
  const marker = join(root, "descendant-survived.txt");
  const descendantProgram = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'survived'); process.exit(0); }, 500);`,
  ].join("");
  const parentProgram = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: 'ignore' });`,
    "child.unref();",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join("");

  try {
    const result = await spawnCodexChild({
      executable: process.execPath,
      args: ["-e", parentProgram],
      prompt: "",
      timeoutMs: 100,
      killGraceMilliseconds: 50,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 550));

    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("material roots fail closed inside Git checkouts and platform temp storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-material-root-"));
  const repo = join(root, "repo");
  try {
    await mkdir(repo, { recursive: true });
    git(repo, ["init", "--quiet"]);
    await assert.rejects(assertIsolatedMaterialRoot(repo), /Git checkout|temporary/i);
    await assert.rejects(
      assertIsolatedMaterialRoot(join(tmpdir(), ".ua-pilot", "materials")),
      /temporary/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pilot Artifact validation derives checkout, manifest, inventory, and corpus digests from Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-artifact-verifier-"));
  const source = join(root, "source");
  const upstreamSource = join(root, "upstream-source");
  const artifactRoot = join(root, ".ua-pilot", "pilot-run");
  const snapshotRoot = join(artifactRoot, "analysis-snapshot");
  const upstreamRoot = join(artifactRoot, "understand-anything");
  const graphDirectory = join(snapshotRoot, ".ua");
  const manifest = {
    analysisSnapshot: "pending",
    counts: { trackedAtSnapshot: 2, included: 2, excluded: 0 },
    included: [
      { path: "src/app.mjs", category: "code" },
      { path: "test/app.test.mjs", category: "test" },
    ],
    excluded: [],
  };
  try {
    await mkdir(join(source, "src"), { recursive: true });
    await mkdir(join(source, "test"), { recursive: true });
    await writeFile(join(source, "src/app.mjs"), "export const app = true;\n", "utf8");
    await writeFile(join(source, "test/app.test.mjs"), "test('app', () => {});\n", "utf8");
    git(source, ["init", "--quiet"]);
    git(source, ["config", "user.email", "pilot@example.invalid"]);
    git(source, ["config", "user.name", "Pilot Test"]);
    git(source, ["add", "."]);
    git(source, ["commit", "--quiet", "-m", "fixture"]);
    const snapshot = git(source, ["rev-parse", "HEAD"]);
    manifest.analysisSnapshot = snapshot;

    await mkdir(upstreamSource, { recursive: true });
    git(upstreamSource, ["init", "--quiet"]);
    git(upstreamSource, ["config", "user.email", "pilot@example.invalid"]);
    git(upstreamSource, ["config", "user.name", "Pilot Test"]);
    await writeFile(join(upstreamSource, "README.md"), "upstream\n", "utf8");
    git(upstreamSource, ["add", "."]);
    git(upstreamSource, ["commit", "--quiet", "-m", "fixture"]);
    const upstream = git(upstreamSource, ["rev-parse", "HEAD"]);

    await mkdir(artifactRoot, { recursive: true });
    git(root, ["clone", "--quiet", source, snapshotRoot]);
    git(root, ["clone", "--quiet", upstreamSource, upstreamRoot]);
    await mkdir(join(graphDirectory, "intermediate"), { recursive: true });
    await writeJson(join(artifactRoot, "pilot-plan.json"), {
      analysisSnapshot: snapshot,
      sourceRepository: source,
      snapshotCheckout: snapshotRoot,
      upstream: {
        commit: upstream,
        checkout: upstreamRoot,
        installScope: "artifact-local",
      },
      provider: "current-codex-provider-only",
      artifacts: {
        root: artifactRoot,
        graphDirectory,
        commitPolicy: "local-uncommitted-only",
      },
    });
    await writeJson(join(artifactRoot, "corpus-manifest.json"), manifest);
    await writeJson(join(artifactRoot, "prepare-result.json"), {
      snapshotHead: snapshot,
      upstreamHead: upstream,
      snapshotClean: true,
      globalInstallerUsed: false,
      symlinksCreated: false,
    });
    await writeJson(join(artifactRoot, "artifact-verification.json"), {
      analysisSnapshot: snapshot,
      passed: true,
      errors: [],
    });
    await writeJson(join(artifactRoot, "inventory-verification.json"), {
      passed: true,
      expectedCount: 2,
      scannedCount: 2,
      missing: [],
      unexpected: [],
      duplicates: [],
    });
    await writeJson(join(graphDirectory, "intermediate/scan-result.json"), {
      files: manifest.included.map(({ path }) => ({ path })),
    });
    await writeJson(join(graphDirectory, "knowledge-graph.json"), {
      project: { gitCommitHash: snapshot },
      nodes: [],
      edges: [],
      layers: [],
      tour: [],
    });

    const verified = await loadVerifiedPilotArtifact({
      artifactRoot,
      analysisSnapshot: snapshot,
      upstreamCommit: upstream,
      expectedManifest: manifest,
    });
    assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(verified.corpusDigestSha256, /^[a-f0-9]{64}$/);
    assert.match(verified.graphSha256, /^[a-f0-9]{64}$/);

    await writeJson(join(artifactRoot, "corpus-manifest.json"), {
      ...manifest,
      included: manifest.included.slice(0, 1),
    });
    await assert.rejects(
      loadVerifiedPilotArtifact({
        artifactRoot,
        analysisSnapshot: snapshot,
        upstreamCommit: upstream,
        expectedManifest: manifest,
      }),
      /deterministic snapshot manifest/,
    );

    await writeJson(join(artifactRoot, "corpus-manifest.json"), manifest);
    const outsideGraph = join(root, "outside-graph.json");
    await writeJson(outsideGraph, {
      project: { gitCommitHash: snapshot },
      nodes: [], edges: [], layers: [], tour: [],
    });
    await rm(join(graphDirectory, "knowledge-graph.json"));
    await symlink(outsideGraph, join(graphDirectory, "knowledge-graph.json"));
    await assert.rejects(
      loadVerifiedPilotArtifact({
        artifactRoot,
        analysisSnapshot: snapshot,
        upstreamCommit: upstream,
        expectedManifest: manifest,
      }),
      /regular non-symlink file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex filesystem profile allows its material and denies an outside sentinel", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const available = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("codex CLI is unavailable");
    return;
  }
  const parent = await mkdtemp(join(homedir(), ".ua-pilot-sandbox-test-"));
  const material = join(parent, "material");
  const outside = join(parent, "outside.txt");
  try {
    await mkdir(material, { recursive: true });
    await writeFile(join(material, "inside.txt"), "inside\n", "utf8");
    await writeFile(outside, "outside\n", "utf8");
    await assertIsolatedMaterialRoot(material);
    const result = spawnSync("codex", [
      "sandbox",
      ...buildCodexPermissionConfig(material),
      "-P",
      CODEX_MATERIAL_PROFILE,
      "-C",
      material,
      "--",
      "/bin/sh",
      "-c",
      `test -r inside.txt && ! head -c 1 ${JSON.stringify(outside)} >/dev/null 2>&1`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
