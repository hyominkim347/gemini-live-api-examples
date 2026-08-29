import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const laneScript = resolve(here, "../scripts/ua-developer-lane.mjs");
const snapshot = "5bf36dd61b6355368d736479c5ffb528b656d544";
const upstreamCommit = "ba450c43425f3de6d43daf76526950ad8ca93536";
const sourcePaths = {
  browser: "poc/kr-ja-meeting/public/app.js",
  server: "poc/kr-ja-meeting/src/server.mjs",
  bridge: "poc/kr-ja-meeting/src/live-translation-bridge.mjs",
  socket: "poc/kr-ja-meeting/src/gemini-live-socket.mjs",
  gateway: "poc/kr-ja-meeting/src/livekit-audio-gateway.mjs",
  meeting: "poc/kr-ja-meeting/src/meeting-session.mjs",
  bridgeTest: "poc/kr-ja-meeting/test/live-translation-bridge.test.mjs",
  unrelatedTest: "poc/kr-ja-meeting/test/unrelated.test.mjs",
};

function runLane(args, options = {}) {
  const artifactOption = args.indexOf("--artifact-root");
  const artifactRoot = artifactOption >= 0 ? args[artifactOption + 1] : null;
  const environment = { ...process.env, ...(options.env ?? {}) };
  if (artifactRoot) {
    environment.PATH = `${join(artifactRoot, "fixture-bin")}:${environment.PATH}`;
  }
  return spawnSync(process.execPath, [laneScript, ...args], {
    encoding: "utf8",
    ...options,
    env: environment,
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makePilotArtifact() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "ua-developer-lane-"));
  const snapshotCheckout = join(artifactRoot, "analysis-snapshot");
  const upstreamCheckout = join(artifactRoot, "understand-anything");
  const graphDirectory = join(snapshotCheckout, ".ua");

  const sourceContents = new Map([
    [sourcePaths.browser, "export function renderMeeting() {}\n"],
    [sourcePaths.server, "import { LiveTranslationBridge } from './live-translation-bridge.mjs';\n"],
    [sourcePaths.bridge,
      "export class LiveTranslationBridge {\n  async phraseBoundary() { return 'drain pending audio'; }\n}\n"],
    [sourcePaths.socket, "export class GeminiLiveSocket {}\n"],
    [sourcePaths.gateway, "export class LiveKitAudioGateway {}\n"],
    [sourcePaths.meeting, "export class MeetingSession {}\n"],
    [sourcePaths.bridgeTest,
      "test('phraseBoundary drains buffered translation', async () => { /* fixture */ });\n"],
    [sourcePaths.unrelatedTest,
      "test('unrelated service behavior', async () => { /* fixture */ });\n"],
  ]);
  for (const [path, contents] of sourceContents) {
    const destination = join(snapshotCheckout, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  await mkdir(upstreamCheckout, { recursive: true });
  await Promise.all([
    writeFile(join(snapshotCheckout, ".fixture-head"), `${snapshot}\n`, "utf8"),
    writeFile(join(upstreamCheckout, ".fixture-head"), `${upstreamCommit}\n`, "utf8"),
  ]);
  const fixtureGit = join(artifactRoot, "fixture-bin/git");
  await mkdir(dirname(fixtureGit), { recursive: true });
  await writeFile(fixtureGit, `#!/bin/sh
repo="$2"
command="$3"
if [ "$command" = "rev-parse" ]; then
  /bin/cat "$repo/.fixture-head"
  exit $?
fi
if [ "$command" = "status" ]; then
  if [ -f "$repo/.fixture-dirty" ]; then
    echo " M tracked-source.mjs"
  fi
  exit 0
fi
if [ "$command" = "diff" ]; then
  if [ -f "$repo/.fixture-dashboard-dirty" ]; then
    echo "understand-anything-plugin/packages/dashboard/src/App.tsx"
  fi
  exit 0
fi
if [ "$command" = "show" ]; then
  path="\${4#*:}"
  exec /bin/cat "$repo/$path"
fi
echo "unsupported fixture git command: $*" >&2
exit 2
`, "utf8");
  await chmod(fixtureGit, 0o755);

  const nodes = [...sourceContents.keys()].map((path) => ({
    id: `file:${path}`,
    type: "file",
    filePath: path,
    name: path.split("/").at(-1),
  }));
  nodes.push({
    id: `class:${sourcePaths.bridge}:LiveTranslationBridge`,
    type: "class",
    filePath: sourcePaths.bridge,
    name: "LiveTranslationBridge",
  });

  await writeJson(join(graphDirectory, "knowledge-graph.json"), {
    project: { gitCommitHash: snapshot },
    nodes,
    edges: [
      {
        source: `file:${sourcePaths.server}`,
        target: `file:${sourcePaths.bridge}`,
        type: "imports",
      },
      {
        source: `file:${sourcePaths.server}`,
        target: `file:${sourcePaths.socket}`,
        type: "imports",
      },
      {
        source: `file:${sourcePaths.server}`,
        target: `file:${sourcePaths.gateway}`,
        type: "imports",
      },
      {
        source: `file:${sourcePaths.bridge}`,
        target: `file:${sourcePaths.bridgeTest}`,
        type: "tested_by",
      },
    ],
    layers: [
      { id: "layer:ui", nodeIds: [`file:${sourcePaths.browser}`] },
      { id: "layer:application-api", nodeIds: [`file:${sourcePaths.server}`] },
      {
        id: "layer:realtime-integration",
        nodeIds: [
          `file:${sourcePaths.bridge}`,
          `file:${sourcePaths.socket}`,
          `file:${sourcePaths.gateway}`,
        ],
      },
      { id: "layer:meeting-domain", nodeIds: [`file:${sourcePaths.meeting}`] },
    ],
    tour: [{ order: 1, nodeIds: [`file:${sourcePaths.server}`] }],
  });
  await writeJson(join(artifactRoot, "pilot-plan.json"), {
    analysisSnapshot: snapshot,
    snapshotCheckout,
    upstream: {
      commit: upstreamCommit,
      checkout: upstreamCheckout,
      pluginRoot: join(upstreamCheckout, "understand-anything-plugin"),
      installScope: "artifact-local",
    },
    provider: "current-codex-provider-only",
    artifacts: { graphDirectory },
  });
  await writeJson(join(artifactRoot, "prepare-result.json"), {
    snapshotHead: snapshot,
    upstreamHead: upstreamCommit,
    snapshotClean: true,
    globalInstallerUsed: false,
    symlinksCreated: false,
  });
  await writeJson(join(artifactRoot, "artifact-verification.json"), {
    analysisSnapshot: snapshot,
    passed: true,
  });
  await writeJson(join(artifactRoot, "corpus-manifest.json"), {
    analysisSnapshot: snapshot,
    included: [...sourceContents.keys()].map((path) => ({
      path,
      category: path.includes("/test/") ? "test" : "code",
    })),
  });
  await writeJson(join(artifactRoot, "calibration-answer.json"), {
    expectedAnswer: "MUST_NOT_BE_READ_OR_EXPOSED",
    correct: true,
  });

  return {
    artifactRoot,
    sessionRoot: join(artifactRoot, "developer-lane-calibration"),
    snapshotCheckout,
    upstreamCheckout,
  };
}

test("begin shows only one unscored calibration and major graph relationships", async () => {
  const fixture = await makePilotArtifact();

  try {
    const result = runLane([
      "begin",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const session = JSON.parse(await readFile(join(fixture.sessionRoot, "session.json"), "utf8"));
    const template = JSON.parse(
      await readFile(join(fixture.sessionRoot, "answer-template.json"), "utf8"),
    );
    const exposed = JSON.stringify({ stdout: result.stdout, session, template });

    assert.equal(session.status, "active");
    assert.equal(session.lane, "developer");
    assert.equal(session.runKind, "unscored-calibration");
    assert.equal(session.scored, false);
    assert.equal(session.analysisSnapshot, snapshot);
    assert.ok(Number.isFinite(session.startedAtMilliseconds));
    assert.match(result.stdout, /phraseBoundary\(\)/);
    assert.deepEqual(
      session.exploration.layerIds,
      ["layer:ui", "layer:application-api", "layer:realtime-integration", "layer:meeting-domain"],
    );
    assert.equal(session.exploration.relationships.length, 4);
    assert.equal(exposed.includes("MUST_NOT_BE_READ_OR_EXPOSED"), false);
    assert.equal(exposed.includes('"expectedAnswer"'), false);
    assert.equal(exposed.includes('"correct"'), false);
    assert.equal(template.unknown, false);
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("submit records an evidenced answer and tool-computed benchmark-format timing", async () => {
  const fixture = await makePilotArtifact();

  try {
    const begun = runLane([
      "begin",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.equal(begun.status, 0, begun.stderr || begun.stdout);

    const answerFile = join(fixture.sessionRoot, "developer-answer.json");
    const evidencedAnswer = {
      answer:
        "phraseBoundary()는 completion event가 없어도 남은 번역 오디오를 drain한 뒤 다음 구간을 시작하고, audible output이 없으면 실패로 닫는다.",
      unknown: false,
      evidence: {
        behavior: "completion event 없이 phrase boundary에서 pending translation audio를 drain한다.",
        code: [{ path: sourcePaths.bridge, symbol: "phraseBoundary" }],
        tests: [{
          path: sourcePaths.bridgeTest,
          test: "phraseBoundary drains buffered translation",
        }],
      },
    };
    await writeJson(answerFile, { ...evidencedAnswer, answerTimeMs: 1 });
    const clientTimed = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(clientTimed.status, 0);
    assert.match(clientTimed.stderr, /answer file must contain only/);

    await writeJson(answerFile, evidencedAnswer);
    const submitted = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);

    assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
    const result = JSON.parse(
      await readFile(join(fixture.sessionRoot, "calibration-result.json"), "utf8"),
    );
    assert.equal(result.questionId, "ain-7640-calibration");
    assert.equal(result.lane, "developer");
    assert.equal(result.runKind, "unscored-calibration");
    assert.equal(result.scored, false);
    assert.equal(result.unknown, false);
    assert.ok(result.answerTimeMs > 0);
    assert.equal(result.evidence.code[0].path, sourcePaths.bridge);
    assert.equal(result.evidence.code[0].symbol, "phraseBoundary");
    assert.equal(result.evidence.tests[0].path, sourcePaths.bridgeTest);
    assert.equal(Object.hasOwn(result, "correct"), false);
    assert.equal(Object.hasOwn(result, "expectedAnswer"), false);

    const verified = runLane([
      "verify",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const report = JSON.parse(
      await readFile(join(fixture.sessionRoot, "developer-lane-verification.json"), "utf8"),
    );
    assert.equal(report.passed, true);
    assert.equal(report.scored, false);

    const session = JSON.parse(await readFile(join(fixture.sessionRoot, "session.json"), "utf8"));
    const backwardsCompletion = session.startedAtMilliseconds - 1;
    await writeJson(join(fixture.sessionRoot, "calibration-result.json"), {
      ...result,
      answerTimeMs: 1,
      completedAtMilliseconds: backwardsCompletion,
      completedAt: new Date(backwardsCompletion).toISOString(),
    });
    const tamperedTiming = runLane([
      "verify",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.notEqual(tamperedTiming.status, 0);
    assert.match(tamperedTiming.stderr, /timing/);

    const duplicate = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /not active/);
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("submit rejects guessed unknowns and preserves an exact evidence-free unknown", async () => {
  const fixture = await makePilotArtifact();

  try {
    const begun = runLane([
      "begin",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.equal(begun.status, 0, begun.stderr || begun.stdout);

    const answerFile = join(fixture.sessionRoot, "developer-answer.json");
    await writeJson(answerFile, {
      answer: "probably drains audio",
      unknown: true,
      evidence: { behavior: "guess", code: [], tests: [] },
    });
    const guessed = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(guessed.status, 0);
    assert.match(guessed.stderr, /unknown answers must use/);

    await writeJson(answerFile, {
      answer: "unknown",
      unknown: true,
      evidence: { behavior: "unknown", code: [], tests: [] },
    });
    const submitted = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
    const result = JSON.parse(
      await readFile(join(fixture.sessionRoot, "calibration-result.json"), "utf8"),
    );
    assert.equal(result.answer, "unknown");
    assert.equal(result.unknown, true);
    assert.deepEqual(result.evidence.code, []);
    assert.deepEqual(result.evidence.tests, []);
    assert.ok(result.answerTimeMs > 0);
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("submit rejects evidence absent from the fixed corpus and graph", async () => {
  const fixture = await makePilotArtifact();

  try {
    const begun = runLane([
      "begin",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.equal(begun.status, 0, begun.stderr || begun.stdout);
    const answerFile = join(fixture.sessionRoot, "developer-answer.json");
    await writeJson(answerFile, {
      answer: "Invented relationship",
      unknown: false,
      evidence: {
        behavior: "Invented behavior",
        code: [{ path: sourcePaths.bridge, symbol: "imaginarySymbol" }],
        tests: [{ path: sourcePaths.bridgeTest, test: "phraseBoundary" }],
      },
    });
    const inventedSymbol = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(inventedSymbol.status, 0);
    assert.match(inventedSymbol.stderr, /declared symbol/);

    await writeJson(answerFile, {
      answer: "Unrelated test",
      unknown: false,
      evidence: {
        behavior: "Invented behavior",
        code: [{ path: sourcePaths.bridge, symbol: "phraseBoundary" }],
        tests: [{ path: sourcePaths.unrelatedTest, test: "unrelated service behavior" }],
      },
    });
    const unrelatedTest = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(unrelatedTest.status, 0);
    assert.match(unrelatedTest.stderr, /tested_by/);

    await writeJson(answerFile, {
      answer: "Invented relationship",
      unknown: false,
      evidence: {
        behavior: "Invented behavior",
        code: [{ path: "src/not-real.mjs", symbol: "imaginarySymbol" }],
        tests: [{ path: sourcePaths.bridgeTest, test: "phraseBoundary" }],
      },
    });
    const inventedFile = runLane([
      "submit",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
      "--answer-file", answerFile,
    ]);
    assert.notEqual(inventedFile.status, 0);
    assert.match(inventedFile.stderr, /fixed corpus/);
    await assert.rejects(readFile(join(fixture.sessionRoot, "calibration-result.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("dashboard refuses a changed upstream pin before launching anything", async () => {
  const fixture = await makePilotArtifact();

  try {
    const planPath = join(fixture.artifactRoot, "pilot-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    await writeJson(planPath, {
      ...plan,
      upstream: { ...plan.upstream, commit: "0000000000000000000000000000000000000000" },
    });
    const launched = runLane([
      "dashboard",
      "--artifact-root", fixture.artifactRoot,
      "--port", "54321",
    ]);
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /reviewed upstream commit/);
    assert.equal(launched.stdout, "");
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("commands refuse dirty snapshot or changed current checkout heads", async () => {
  const fixture = await makePilotArtifact();

  try {
    await writeFile(join(fixture.snapshotCheckout, ".fixture-dirty"), "dirty\n", "utf8");
    const dirtySnapshot = runLane([
      "begin",
      "--artifact-root", fixture.artifactRoot,
      "--session-root", fixture.sessionRoot,
    ]);
    assert.notEqual(dirtySnapshot.status, 0);
    assert.match(dirtySnapshot.stderr, /tracked changes/);
    assert.equal(dirtySnapshot.stdout, "");

    await rm(join(fixture.snapshotCheckout, ".fixture-dirty"));
    await writeFile(
      join(fixture.upstreamCheckout, ".fixture-head"),
      "0000000000000000000000000000000000000000\n",
      "utf8",
    );
    const changedHead = runLane([
      "dashboard",
      "--artifact-root", fixture.artifactRoot,
      "--port", "54321",
    ]);
    assert.notEqual(changedHead.status, 0);
    assert.match(changedHead.stderr, /current HEAD/);
    assert.equal(changedHead.stdout, "");
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("dashboard runs only the artifact-local pinned Vite surface on loopback", async () => {
  const fixture = await makePilotArtifact();

  try {
    const dashboardRoot = join(
      fixture.upstreamCheckout,
      "understand-anything-plugin/packages/dashboard",
    );
    const viteBinary = join(dashboardRoot, "node_modules/.bin/vite");
    await mkdir(dirname(viteBinary), { recursive: true });
    await writeFile(viteBinary, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  fakeDashboard: true,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  graphDir: process.env.GRAPH_DIR,
  browser: process.env.BROWSER,
  leakedProviderKey: Boolean(
    process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
  ),
}) + "\\n");
`, "utf8");
    await chmod(viteBinary, 0o755);

    const launched = runLane([
      "dashboard",
      "--artifact-root", fixture.artifactRoot,
      "--port", "54321",
    ], {
      env: {
        ...process.env,
        GEMINI_API_KEY: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
      },
    });

    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    const dashboardLine = launched.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(({ fakeDashboard }) => fakeDashboard);
    assert.ok(dashboardLine);
    assert.deepEqual(dashboardLine.argv, ["--host", "127.0.0.1", "--port", "54321", "--strictPort"]);
    assert.equal(await realpath(dashboardLine.cwd), await realpath(dashboardRoot));
    assert.equal(dashboardLine.graphDir, fixture.snapshotCheckout);
    assert.equal(dashboardLine.browser, "none");
    assert.equal(dashboardLine.leakedProviderKey, false);
  } finally {
    await rm(fixture.artifactRoot, { recursive: true, force: true });
  }
});
