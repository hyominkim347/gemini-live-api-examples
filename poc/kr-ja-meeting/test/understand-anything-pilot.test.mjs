import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertSealedCheckoutState,
  runtimeMaterialSha256,
  runtimeDigestBeforePhase,
  snapshotDigestBeforePhase,
  runBudgetedPilotPhase,
  stageSealedPlanCodexRuntime,
} from "../scripts/understand-anything-pilot.mjs";
import {
  buildCodexChildEnv,
  spawnTrustedCodexChild,
} from "../scripts/pilot-local-safety.mjs";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("budgeted runner kills an over-budget child before delayed side effects", {
  skip: process.platform !== "darwin" || process.arch !== "arm64"
    ? "macOS arm64 cwd supervision is required"
    : false,
}, async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-pilot-budget-kill-"));
  const marker = join(artifactRoot, "survived.txt");
  const childProgram = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 2_000);`,
    "setInterval(() => {}, 1000);",
  ].join("");

  try {
    const metric = await runBudgetedPilotPhase({
      phase: "fullAnalysis",
      budgetMilliseconds: 100,
      command: [process.execPath, "-e", childProgram],
      killGraceMilliseconds: 50,
      cwd: artifactRoot,
    });

    assert.equal(metric.status, "timed-out");
    assert.equal(metric.timedOut, true);
    assert.equal(metric.measurement, "budgeted-child-process-v1");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_050));
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("pilot commands reject output roots outside approved .ua-pilot storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-pilot-output-reject-"));
  try {
    for (const command of ["manifest", "plan"]) {
      const result = runPilot([
        command,
        "--repo", projectRoot,
        "--artifact-root", join(root, "visible-output"),
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /\.ua-pilot/);
    }
    const budgeted = runPilot([
      "run-budgeted",
      "--artifact-root", join(root, "visible-output"),
      "--phase", "fullAnalysis",
    ]);
    assert.notEqual(budgeted.status, 0);
    assert.match(budgeted.stderr, /\.ua-pilot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest fixes the Analysis Snapshot and excludes non-corpus files", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-manifest-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
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
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("plan pins isolated upstream execution and disables redirect and automation", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-plan-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");

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
    assert.equal(plan.upstream.installRoot, plan.upstream.checkout);
    assert.deepEqual(plan.upstream.localBuild, [
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
      ["corepack", "pnpm", "--filter", "@understand-anything/core", "build"],
    ]);
    assert.equal(plan.environment.UNDERSTAND_NO_WORKTREE_REDIRECT, "1");
    assert.deepEqual(plan.understandArguments, ["--full", "--language", "ko", "--no-auto-update"]);
    assert.equal(plan.provider, "current-codex-provider-only");
    assert.deepEqual(plan.budgetRunner, {
      command: "npm run pilot:run-budgeted --",
      measurement: "budgeted-child-process-v1",
      phases: ["fullAnalysis", "incrementalRefresh"],
      timeoutPolicy: "SIGTERM-then-SIGKILL",
    });
    const expectedCommand = [
      "staged-codex-runtime-v1", "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "--sandbox", "workspace-write", "-C", plan.snapshotCheckout,
      "--add-dir", plan.upstream.checkout, "-",
    ];
    assert.deepEqual(plan.phaseInvocations, {
      fullAnalysis: { command: expectedCommand, promptFile: "codex-prompt.md" },
      incrementalRefresh: {
        command: expectedCommand,
        promptFile: "incremental-codex-prompt.md",
      },
    });
    assert.deepEqual(plan.providerRuntime, {
      identityKind: "staged-codex-runtime-v1",
      packageName: "@openai/codex",
      packageVersion: "0.151.0",
      nativePackageName: "@openai/codex",
      nativePackageVersion: "0.151.0-darwin-arm64",
      codexSha256: "98491713ffb196061003ee148636e743997cc31d76144ba7c53462269896891d",
      entrypointSha256: "134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477",
      packageSha256: "350fc14f5e912071a6725c6ce00904da87e67e1145d43296c8beffb2349c1be6",
      nativePackageSha256: "6cc1c61958cf5bc9eb8130e521beef3eb8ab4db0ecb98da939a6f5994b55412b",
    });
    assert.equal(plan.artifacts.commitPolicy, "local-uncommitted-only");
    assert.ok(plan.prohibited.includes("global-installer"));
    assert.ok(plan.prohibited.includes("symlink"));
    assert.ok(plan.prohibited.includes("new-provider-credentials"));
    const seal = JSON.parse(
      await readFile(join(artifactRoot, "pilot-plan-seal.json"), "utf8"),
    );
    assert.equal(seal.analysisSnapshot, snapshot);
    assert.equal(seal.upstreamCommit, "ba450c43425f3de6d43daf76526950ad8ca93536");
    assert.equal(
      seal.providerRuntimeSha256,
      sha256(JSON.stringify(plan.providerRuntime)),
    );
    for (const digest of [
      seal.planSha256,
      seal.corpusManifestSha256,
      seal.corpusSha256,
      seal.providerRuntimeSha256,
      seal.phaseInvocations.fullAnalysis.commandSha256,
      seal.phaseInvocations.fullAnalysis.promptSha256,
      seal.phaseInvocations.incrementalRefresh.commandSha256,
      seal.phaseInvocations.incrementalRefresh.promptSha256,
    ]) {
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a sealed graph plan ignores fake PATH and stages the frozen Codex runtime", {
  skip: process.platform !== "darwin" || process.arch !== "arm64"
    ? "Frozen Codex runtime requires macOS arm64"
    : false,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-trusted-plan-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const fakeBin = join(fixtureRoot, "fake-bin");
  const marker = join(fixtureRoot, "fake-codex-ran.txt");
  try {
    const planned = runPilot([
      "plan", "--repo", projectRoot, "--artifact-root", artifactRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    await mkdir(fakeBin);
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(fakeCodex, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
    await chmod(fakeCodex, 0o755);
    const [plan, seal] = await Promise.all([
      readFile(join(artifactRoot, "pilot-plan.json"), "utf8").then(JSON.parse),
      readFile(join(artifactRoot, "pilot-plan-seal.json"), "utf8").then(JSON.parse),
    ]);

    const identity = await stageSealedPlanCodexRuntime({
      plan,
      seal,
      environment: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assert.notEqual(identity.codexExecutable, fakeCodex);
    const launched = await spawnTrustedCodexChild({
      identity,
      args: ["--version"],
      prompt: "",
      timeoutMs: 10_000,
      supervisionRoot: artifactRoot,
    });
    assert.equal(launched.status, 0);
    assert.match(launched.stdout, /codex-cli 0\.151\.0/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("operator docs provide package-cwd commands for every budgeted phase and adjudication", async () => {
  const [operatorDocs, calibrationDocs, comparisonDocs, packageText] = await Promise.all([
    readFile(join(projectRoot, "docs", "understand-anything-pilot.md"), "utf8"),
    readFile(join(projectRoot, "docs", "agent-lane-calibration.md"), "utf8"),
    readFile(join(projectRoot, "docs", "agent-lane-comparison.md"), "utf8"),
    readFile(join(projectRoot, "poc", "kr-ja-meeting", "package.json"), "utf8"),
  ]);
  const packageManifest = JSON.parse(packageText);

  assert.match(
    operatorDocs,
    /cd \/absolute\/path\/to\/repository\/poc\/kr-ja-meeting/,
  );
  assert.match(
    operatorDocs,
    /npm run pilot:run-budgeted --[\s\\]*\n[\s\S]*?--phase fullAnalysis/,
  );
  assert.match(
    operatorDocs,
    /npm run pilot:run-budgeted --[\s\\]*\n[\s\S]*?--phase incrementalRefresh/,
  );
  assert.match(
    operatorDocs,
    /npm run pilot:adjudicate-agent --[\s\\]*\n/,
  );
  assert.match(operatorDocs, /macOS arm64/);
  assert.match(operatorDocs, /Codex `?0\.151\.0`?/);
  assert.match(operatorDocs, /historical retained evidence|과거 보존 증거/);
  assert.match(operatorDocs, /새(?:로운)? artifact root[\s\S]*prepare/i);
  assert.match(operatorDocs, /agent-only-gate-v4-frozen-manual/);
  assert.match(operatorDocs, /agent-only-frozen-adjudication\.v1\.json/);
  assert.match(operatorDocs, /agent-only-manual-review-a\.v1\.json/);
  assert.match(operatorDocs, /agent-only-manual-review-b\.v1\.json/);
  assert.match(operatorDocs, /agent-only-direct-02-tiebreak\.v1\.json/);
  assert.match(operatorDocs, /01a04dff-c649-7eb2-b3d4-8c994ec4c6f7/);
  assert.match(operatorDocs, /\/root\/upstream_exploration/);
  assert.match(operatorDocs, /\/root\/remove_developer_lane\/final_security_review/);
  assert.match(operatorDocs, /recordedAt[\s\S]*원래 review가 수행된\s+시각을 증명하지 않는다/);
  assert.match(operatorDocs, /Codex agent task[\s\S]*human review가 아니다/);
  assert.doesNotMatch(operatorDocs, /reviewedAt/);
  assert.doesNotMatch(operatorDocs, /human reviewer/);
  assert.match(operatorDocs, /correct answer: 4\/12/);
  assert.match(operatorDocs, /direct-02[\s\S]*tiebreak/);
  assert.match(operatorDocs, /향후 raw[\s\S]*새 benchmark\/adjudication revision[\s\S]*fail-closed/);
  assert.doesNotMatch(operatorDocs, /expected-summary-subject-bound-claims-v2/);
  assert.match(comparisonDocs, /frozen-digest-provenance-v1/);
  assert.match(comparisonDocs, /exact frozen raw SHA|정확한\s+frozen raw SHA/i);
  assert.match(comparisonDocs, /<NEW_PILOT_ARTIFACT_ROOT>/);
  assert.doesNotMatch(comparisonDocs, /<PILOT_ARTIFACT_ROOT>/);
  assert.match(calibrationDocs, /ua_pilot_material_only/);
  assert.match(comparisonDocs, /ua_pilot_material_only/);
  assert.doesNotMatch(calibrationDocs, /AIN-7639가 생성한 고정 로컬 graph를 재사용/);
  assert.doesNotMatch(calibrationDocs, /AIN-7639 Pilot Artifact를 read-only input/);
  assert.doesNotMatch(calibrationDocs, /--sandbox read-only/);
  assert.doesNotMatch(comparisonDocs, /--sandbox read-only/);
  assert.equal(
    packageManifest.scripts["pilot:run-budgeted"],
    "node scripts/understand-anything-pilot.mjs run-budgeted",
  );
  assert.equal(
    packageManifest.scripts["pilot:adjudicate-agent"],
    "node scripts/adjudicate-agent-only-pilot.mjs",
  );
});

test("plan canonicalizes a symlinked source repository before sealing it", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-source-alias-"));
  const sourceAlias = join(fixtureRoot, "source-alias");
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  try {
    await symlink(projectRoot, sourceAlias, "dir");
    const result = runPilot([
      "plan", "--repo", sourceAlias, "--artifact-root", artifactRoot,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(await readFile(join(artifactRoot, "pilot-plan.json"), "utf8"));
    assert.equal(plan.sourceRepository, projectRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("sealed checkout state rejects ignored content outside its explicit build allowlist", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-unsealed-content-"));
  const checkout = join(fixtureRoot, "checkout");
  try {
    await mkdir(checkout);
    const git = (...args) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("config", "user.email", "pilot@example.invalid").status, 0);
    assert.equal(git("config", "user.name", "Pilot Test").status, 0);
    await writeFile(join(checkout, ".gitignore"), ".env\nallowed/\n", "utf8");
    await writeFile(join(checkout, "app.mjs"), "export const app = true;\n", "utf8");
    assert.equal(git("add", ".").status, 0);
    assert.equal(git("commit", "--quiet", "-m", "fixture").status, 0);
    const head = git("rev-parse", "HEAD").stdout.trim();
    await mkdir(join(checkout, "allowed"));
    await writeFile(join(checkout, "allowed", "build.js"), "built\n", "utf8");
    await symlink("build.js", join(checkout, "allowed", "build-link.js"));
    await writeFile(join(checkout, ".env"), "SHOULD_NOT_BE_VISIBLE=true\n", "utf8");

    await assert.rejects(
      assertSealedCheckoutState({
        checkout,
        commit: head,
        label: "fixture checkout",
        allowedIgnoredPrefixes: ["allowed/"],
        allowIgnoredSymlinks: true,
      }),
      /unsealed.*\.env|\.env.*unsealed/i,
    );
    await rm(join(checkout, ".env"));
    await assert.rejects(
      assertSealedCheckoutState({
        checkout,
        commit: head,
        label: "fixture checkout",
        allowedIgnoredPrefixes: ["allowed/"],
        requireAllowedIgnoredDigest: true,
        allowIgnoredSymlinks: true,
      }),
      /without a runner digest/i,
    );
    const runtimeDigest = await runtimeMaterialSha256(checkout, ["allowed/"]);
    await assertSealedCheckoutState({
      checkout,
      commit: head,
      label: "fixture checkout",
      allowedIgnoredPrefixes: ["allowed/"],
      allowedIgnoredDigestSha256: runtimeDigest,
      requireAllowedIgnoredDigest: true,
      allowIgnoredSymlinks: true,
    });
    const escapedRuntime = join(fixtureRoot, "escaped-runtime.js");
    await writeFile(escapedRuntime, "escaped\n", "utf8");
    await symlink(escapedRuntime, join(checkout, "allowed", "escaped-link.js"));
    await assert.rejects(
      runtimeMaterialSha256(checkout, ["allowed/"]),
      /symlink target.*boundary|material boundary/i,
    );
    await rm(join(checkout, "allowed", "escaped-link.js"));
    await symlink(join(checkout, ".git", "config"), join(checkout, "allowed", "git-link"));
    await assert.rejects(
      runtimeMaterialSha256(checkout, ["allowed/"]),
      /symlink target is not sealed/i,
    );
    await rm(join(checkout, "allowed", "git-link"));
    await writeFile(join(checkout, "allowed", "build.js"), "tampered\n", "utf8");
    await assert.rejects(
      assertSealedCheckoutState({
        checkout,
        commit: head,
        label: "fixture checkout",
        allowedIgnoredPrefixes: ["allowed/"],
        allowedIgnoredDigestSha256: runtimeDigest,
        requireAllowedIgnoredDigest: true,
        allowIgnoredSymlinks: true,
      }),
      /differs from the runner digest/i,
    );
    await rm(join(checkout, "allowed"), { recursive: true });
    await assert.rejects(
      assertSealedCheckoutState({
        checkout,
        commit: head,
        label: "fixture checkout",
        allowedIgnoredPrefixes: ["allowed/"],
        allowedIgnoredDigestSha256: runtimeDigest,
        requireAllowedIgnoredDigest: true,
        allowIgnoredSymlinks: true,
      }),
      /differs from the runner digest/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("sealed checkout state rejects a Git worktree redirected by local config", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-git-worktree-redirect-"));
  const checkout = join(fixtureRoot, "checkout");
  const redirected = join(fixtureRoot, "redirected");
  try {
    await mkdir(checkout);
    await mkdir(redirected);
    const git = (...args) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("config", "user.email", "pilot@example.invalid").status, 0);
    assert.equal(git("config", "user.name", "Pilot Test").status, 0);
    await writeFile(join(checkout, "app.mjs"), "sealed\n", "utf8");
    assert.equal(git("add", ".").status, 0);
    assert.equal(git("commit", "--quiet", "-m", "fixture").status, 0);
    const head = git("rev-parse", "HEAD").stdout.trim();
    await writeFile(join(redirected, "app.mjs"), "sealed\n", "utf8");
    assert.equal(git("config", "core.worktree", redirected).status, 0);

    await assert.rejects(
      assertSealedCheckoutState({ checkout, commit: head, label: "fixture checkout" }),
      /worktree.*redirect|canonical checkout/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("sealed snapshot rejects a symlink nested below an ignored output directory", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-ignored-symlink-"));
  const checkout = join(fixtureRoot, "checkout");
  const escaped = join(fixtureRoot, "escaped");
  try {
    await mkdir(checkout);
    await mkdir(escaped);
    const git = (...args) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("config", "user.email", "pilot@example.invalid").status, 0);
    assert.equal(git("config", "user.name", "Pilot Test").status, 0);
    await writeFile(join(checkout, ".gitignore"), ".ua/\n", "utf8");
    await writeFile(join(checkout, "app.mjs"), "sealed\n", "utf8");
    assert.equal(git("add", ".").status, 0);
    assert.equal(git("commit", "--quiet", "-m", "fixture").status, 0);
    const head = git("rev-parse", "HEAD").stdout.trim();
    await mkdir(join(checkout, ".ua"));
    await symlink(escaped, join(checkout, ".ua", "intermediate"), "dir");
    await assert.rejects(
      assertSealedCheckoutState({
        checkout,
        commit: head,
        label: "snapshot fixture",
        allowedIgnoredPrefixes: [".ua/"],
      }),
      /ignored.*symlink|symlink.*ignored/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("phase retries bind to the latest runner-issued runtime digest", () => {
  const metrics = {
    fullAnalysis: { runtimeMaterialSha256: "full-latest" },
    incrementalRefresh: { runtimeMaterialSha256: "incremental-latest" },
  };
  assert.equal(runtimeDigestBeforePhase(metrics, "fullAnalysis"), "full-latest");
  assert.equal(runtimeDigestBeforePhase(metrics, "incrementalRefresh"), "incremental-latest");
  delete metrics.incrementalRefresh.runtimeMaterialSha256;
  assert.equal(runtimeDigestBeforePhase(metrics, "incrementalRefresh"), "full-latest");
  metrics.fullAnalysis.snapshotOutputSha256 = "full-snapshot";
  metrics.incrementalRefresh.snapshotOutputSha256 = "incremental-snapshot";
  assert.equal(snapshotDigestBeforePhase(metrics, "fullAnalysis"), "full-snapshot");
  assert.equal(snapshotDigestBeforePhase(metrics, "incrementalRefresh"), "incremental-snapshot");
  delete metrics.incrementalRefresh.snapshotOutputSha256;
  assert.equal(snapshotDigestBeforePhase(metrics, "incrementalRefresh"), "full-snapshot");
});

test("sealed checkout state hashes tracked bytes hidden by assume-unchanged", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-assume-unchanged-"));
  const checkout = join(fixtureRoot, "checkout");
  try {
    await mkdir(checkout);
    const git = (...args) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("config", "user.email", "pilot@example.invalid").status, 0);
    assert.equal(git("config", "user.name", "Pilot Test").status, 0);
    await writeFile(join(checkout, "app.mjs"), "sealed\n", "utf8");
    assert.equal(git("add", ".").status, 0);
    assert.equal(git("commit", "--quiet", "-m", "fixture").status, 0);
    const head = git("rev-parse", "HEAD").stdout.trim();
    assert.equal(git("update-index", "--assume-unchanged", "app.mjs").status, 0);
    await writeFile(join(checkout, "app.mjs"), "tampered\n", "utf8");
    assert.equal(git("status", "--porcelain").stdout, "");

    await assert.rejects(
      assertSealedCheckoutState({ checkout, commit: head, label: "fixture checkout" }),
      /tracked bytes.*app\.mjs|app\.mjs.*pinned tree/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("run-budgeted rejects an injected child command before execution", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-budget-run-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const snapshotCheckout = join(artifactRoot, "analysis-snapshot");

  try {
    await mkdir(snapshotCheckout, { recursive: true });
    const planned = runPilot([
      "plan",
      "--repo", projectRoot,
      "--artifact-root", artifactRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const result = runPilot([
      "run-budgeted",
      "--artifact-root", artifactRoot,
      "--phase", "incrementalRefresh",
      "--", "true",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected argument/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("run-budgeted rejects a self-consistent tampered plan before spawning Codex", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-plan-tamper-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const escapedSnapshot = join(fixtureRoot, "escaped-snapshot");
  const escapedUpstream = join(fixtureRoot, "escaped-upstream");
  const fakeBin = join(fixtureRoot, "fake-bin");
  const marker = join(fixtureRoot, "spawned.txt");

  try {
    const planned = runPilot([
      "plan", "--repo", projectRoot, "--artifact-root", artifactRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    await Promise.all([
      mkdir(escapedSnapshot),
      mkdir(escapedUpstream),
      mkdir(fakeBin),
    ]);
    const planPath = join(artifactRoot, "pilot-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const originalSnapshot = plan.snapshotCheckout;
    const originalUpstream = plan.upstream.checkout;
    plan.snapshotCheckout = escapedSnapshot;
    plan.upstream.checkout = escapedUpstream;
    plan.upstream.pluginRoot = join(escapedUpstream, "understand-anything-plugin");
    plan.artifacts.graphDirectory = join(escapedSnapshot, ".ua");
    for (const invocation of Object.values(plan.phaseInvocations)) {
      invocation.command[invocation.command.indexOf("-C") + 1] = escapedSnapshot;
      invocation.command[invocation.command.indexOf("--add-dir") + 1] = escapedUpstream;
    }
    const tamperedPlanText = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(planPath, tamperedPlanText, "utf8");
    const promptTexts = {};
    for (const promptFile of ["codex-prompt.md", "incremental-codex-prompt.md"]) {
      const promptPath = join(artifactRoot, promptFile);
      const prompt = (await readFile(promptPath, "utf8"))
        .replaceAll(originalSnapshot, escapedSnapshot)
        .replaceAll(originalUpstream, escapedUpstream);
      await writeFile(promptPath, prompt, "utf8");
      promptTexts[promptFile] = prompt;
    }
    const sealPath = join(artifactRoot, "pilot-plan-seal.json");
    const seal = JSON.parse(await readFile(sealPath, "utf8"));
    seal.planSha256 = sha256(tamperedPlanText);
    for (const [phase, invocation] of Object.entries(plan.phaseInvocations)) {
      seal.phaseInvocations[phase].commandSha256 = sha256(JSON.stringify(invocation.command));
      seal.phaseInvocations[phase].promptSha256 = sha256(
        promptTexts[invocation.promptFile],
      );
    }
    await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, "utf8");
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
      "process.stdin.resume();",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeCodex, 0o755);

    const result = runPilot([
      "run-budgeted", "--artifact-root", artifactRoot, "--phase", "fullAnalysis",
    ], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /seal|digest|prepared plan|material boundary/i);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("run-budgeted rejects a snapshot symlink swap before spawning Codex", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-symlink-swap-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const escapedSnapshot = join(fixtureRoot, "escaped-snapshot");
  const fakeBin = join(fixtureRoot, "fake-bin");
  const marker = join(fixtureRoot, "spawned.txt");

  try {
    const planned = runPilot([
      "plan", "--repo", projectRoot, "--artifact-root", artifactRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const plan = JSON.parse(await readFile(join(artifactRoot, "pilot-plan.json"), "utf8"));
    await Promise.all([
      mkdir(escapedSnapshot),
      mkdir(plan.upstream.checkout, { recursive: true }),
      mkdir(fakeBin),
    ]);
    await symlink(escapedSnapshot, plan.snapshotCheckout, "dir");
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
      "process.stdin.resume();",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeCodex, 0o755);

    const result = runPilot([
      "run-budgeted", "--artifact-root", artifactRoot, "--phase", "fullAnalysis",
    ], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink|material boundary/i);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("prepare refuses an upstream source that lacks the reviewed commit", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-prepare-reject-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");

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
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("prepare refuses an existing artifact before touching retained evidence", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-prepare-existing-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot", "pilot-run");
  const metricsPath = join(artifactRoot, "run-metrics.json");
  const retainedEvidence = '{"fullAnalysis":{"status":"completed","elapsedMilliseconds":123}}\n';

  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(metricsPath, retainedEvidence, "utf8");

    const result = runPilot([
      "prepare",
      "--repo", projectRoot,
      "--artifact-root", artifactRoot,
      "--upstream-source", projectRoot,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing Pilot Artifact|new and empty|retained evidence/i);
    assert.equal(await readFile(metricsPath, "utf8"), retainedEvidence);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("verify-scan rejects any inventory outside the tracked Analysis Corpus", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-verify-scan-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const scanResult = join(artifactRoot, "scan-result.json");

  try {
    await mkdir(artifactRoot, { recursive: true });
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
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("verify-artifact rejects self-reports and preserves runner-issued provenance", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ua-pilot-verify-artifact-"));
  const artifactRoot = join(fixtureRoot, ".ua-pilot");
  const snapshotCheckout = join(artifactRoot, "analysis-snapshot");
  const uaDirectory = join(snapshotCheckout, ".ua");
  const intermediate = join(uaDirectory, "intermediate");
  const fakeBin = join(artifactRoot, "fake-bin");
  const environmentCapture = join(artifactRoot, "child-environment.json");

  try {
    const planned = runPilot([
      "plan", "--repo", projectRoot, "--artifact-root", artifactRoot,
    ]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const plan = JSON.parse(await readFile(join(artifactRoot, "pilot-plan.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(artifactRoot, "corpus-manifest.json"), "utf8"));
    const codePath = manifest.included.find(({ category }) => category === "code").path;
    const testPath = manifest.included.find(({ category }) => category === "test").path;
    const cloned = spawnSync(
      "git", ["clone", "--quiet", "--no-checkout", projectRoot, snapshotCheckout],
      { encoding: "utf8" },
    );
    assert.equal(cloned.status, 0, cloned.stderr);
    const snapshotGit = (...args) => spawnSync(
      "git", ["-C", snapshotCheckout, ...args], { encoding: "utf8" },
    );
    assert.equal(snapshotGit("checkout", "--quiet", "--detach", snapshot).status, 0);
    const excludePath = snapshotGit("rev-parse", "--git-path", "info/exclude").stdout.trim();
    await writeFile(resolve(snapshotCheckout, excludePath), "/.ua/\n/.understand-anything/\n", "utf8");
    await Promise.all([
      mkdir(intermediate, { recursive: true }),
      mkdir(plan.upstream.checkout, { recursive: true }),
    ]);
    await writeFile(join(artifactRoot, "prepare-result.json"), JSON.stringify({
      snapshotHead: snapshot,
      upstreamHead: "ba450c43425f3de6d43daf76526950ad8ca93536",
      snapshotClean: true,
      globalInstallerUsed: false,
      symlinksCreated: false,
    }), "utf8");
    await writeFile(join(uaDirectory, "knowledge-graph.json"), JSON.stringify({
      project: { gitCommitHash: snapshot },
      nodes: [
        { id: `file:${codePath}`, filePath: codePath },
        { id: `file:${testPath}`, filePath: testPath },
      ],
      edges: [], layers: [], tour: [],
    }), "utf8");
    await writeFile(join(uaDirectory, "meta.json"), JSON.stringify({ gitCommitHash: snapshot }), "utf8");
    await writeFile(join(uaDirectory, "fingerprints.json"), JSON.stringify({
      files: { [codePath]: { hash: "fixture" } },
    }), "utf8");
    await writeFile(join(uaDirectory, "config.json"), JSON.stringify({
      autoUpdate: false,
      outputLanguage: "ko",
    }), "utf8");
    await writeFile(join(intermediate, "scan-result.json"), JSON.stringify({
      files: manifest.included.map(({ path }) => ({ path })),
    }), "utf8");
    await writeFile(join(artifactRoot, "calibration-answer.json"), JSON.stringify({
      status: "completed",
      question: "How does phrase boundary drain translated audio?",
      affectedBehavior: "phrase boundary drains translated audio",
      codeEvidence: [{ path: codePath, symbol: "fixtureSymbol" }],
      testEvidence: [{ path: testPath, test: "fixture test" }],
      graphNodeIds: [`file:${codePath}`, `file:${testPath}`],
    }), "utf8");
    await writeFile(join(artifactRoot, "run-metrics.json"), JSON.stringify({
      fullAnalysis: { status: "completed", elapsedMilliseconds: 1_800_001 },
      incrementalRefresh: { status: "completed", elapsedMilliseconds: 1 },
    }), "utf8");

    const result = runPilot(["verify-artifact", "--artifact-root", artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runner digest|not issued by the budgeted child runner/);

    await mkdir(fakeBin, { recursive: true });
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(environmentCapture)}, JSON.stringify(process.env));`,
      "process.stdin.resume();",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeCodex, 0o755);
    await writeFile(join(artifactRoot, "run-metrics.json"), JSON.stringify({
      fullAnalysis: { status: "not-run" },
      incrementalRefresh: { status: "not-run" },
    }), "utf8");
    const runnerEnvironment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      UA_FORBIDDEN_SECRET: "must-not-reach-codex",
    };
    const metrics = {};
    const snapshotOutputSha256 = await runtimeMaterialSha256(
      snapshotCheckout,
      [".ua/", ".understand-anything/"],
    );
    for (const phase of ["fullAnalysis", "incrementalRefresh"]) {
      metrics[phase] = await runBudgetedPilotPhase({
        phase,
        budgetMilliseconds: plan.budgetsMilliseconds[phase],
        command: [fakeCodex],
        cwd: snapshotCheckout,
        env: {
          ...buildCodexChildEnv(runnerEnvironment),
          ...plan.environment,
        },
        stdinText: "fixture prompt",
      });
      metrics[phase].runtimeMaterialSha256 = sha256("");
      metrics[phase].snapshotOutputSha256 = snapshotOutputSha256;
      metrics[phase].commandSha256 = sha256(
        JSON.stringify(plan.phaseInvocations[phase].command),
      );
      metrics[phase].providerRuntime = plan.providerRuntime;
      assert.equal(metrics[phase].status, "completed");
    }
    await writeFile(join(artifactRoot, "run-metrics.json"), JSON.stringify(metrics), "utf8");
    const childEnvironment = JSON.parse(await readFile(environmentCapture, "utf8"));
    assert.equal(childEnvironment.UA_FORBIDDEN_SECRET, undefined);
    assert.equal(childEnvironment.UNDERSTAND_NO_WORKTREE_REDIRECT, "1");
    const accepted = runPilot(["verify-artifact", "--artifact-root", artifactRoot]);
    assert.notEqual(accepted.status, 0);
    assert.match(accepted.stderr, /Understand-Anything|\.git|checkout/i);

    const changedManifest = { ...manifest, included: manifest.included.slice(1) };
    await writeFile(
      join(artifactRoot, "corpus-manifest.json"),
      `${JSON.stringify(changedManifest, null, 2)}\n`,
      "utf8",
    );
    const tampered = runPilot(["verify-artifact", "--artifact-root", artifactRoot]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /manifest|seal|corpus/i);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
