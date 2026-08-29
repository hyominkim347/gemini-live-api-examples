import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { GeminiLiveTranslateSocket } from "../src/gemini-live-socket.mjs";
import { ProviderSemanticEvidence } from "../src/provider-canary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_RATE = 16_000;
const CHUNK_BYTES = SAMPLE_RATE / 10 * 2;
const temporaryDirectories = [];
const fixtures = [
  fixture("ko-to-ja", "Yuna", "사과로 시작합니다. 오늘 안건을 검토합니다. 기차로 마칩니다.", ["사과"], ["기차"], ["りんご", "リンゴ"], ["電車"]),
  fixture("ko-to-ja", "Yuna", "바다로 시작합니다. 예산을 확인합니다. 별로 마칩니다.", ["바다"], ["별"], ["海"], ["星"]),
  fixture("ko-to-ja", "Yuna", "봄으로 시작합니다. 다음 일정을 논의합니다. 약속으로 마칩니다.", ["봄"], ["약속"], ["春"], ["約束"]),
  fixture("ja-to-ko", "Kyoko", "りんごから始めます。今日の議題を確認します。電車で終わります。", ["りんご", "リンゴ"], ["電車"], ["사과"], ["기차"]),
  fixture("ja-to-ko", "Kyoko", "海から始めます。予算を確認します。星で終わります。", ["海"], ["星"], ["바다"], ["별"]),
  fixture("ja-to-ko", "Kyoko", "春から始めます。次の日程を話します。約束で終わります。", ["春"], ["約束"], ["봄"], ["약속"]),
];

let apiKey = "";
try {
  apiKey = readApiKey();
  const evidence = new ProviderSemanticEvidence();
  for (const [index, item] of fixtures.entries()) {
    const result = await runTrial(item, index + 1);
    evidence.record({ direction: item.direction, trialId: `${item.direction}-${index + 1}`, ...result });
  }
  const snapshot = evidence.snapshot();
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  if (!snapshot.ok) process.exitCode = 1;
} catch {
  process.stderr.write("provider semantic canary failed\n");
  process.exitCode = 1;
} finally {
  apiKey = "";
  await Promise.allSettled(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
}

async function runTrial(item, trial) {
  const inputParts = [];
  const outputParts = [];
  const setup = deferred();
  const completed = deferred();
  const client = new GeminiLiveTranslateSocket({
    apiKey,
    meetingId: `semantic-canary-${trial}`,
    targetLanguage: item.direction === "ko-to-ja" ? "ja" : "ko",
    canaryTranscription: true,
    automaticActivityDetection: false,
    socketFactory: (url) => new WebSocket(url),
    openState: WebSocket.OPEN,
    onSetupComplete: setup.resolve,
    onInputTranscription: (value) => inputParts.push(value),
    onOutputTranscription: (value) => outputParts.push(value),
    onGenerationComplete: completed.resolve,
    onTurnComplete: completed.resolve,
    onError: setup.reject,
    onClose: () => completed.reject(new Error("provider closed")),
  });
  try {
    client.connect();
    await withTimeout(setup.promise, 30_000);
    if (!client.sendActivityStart()) throw new Error("activity start failed");
    const pcm = synthesize(item.voice, item.spoken);
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      if (!client.sendPcm16(pcm.subarray(offset, offset + CHUNK_BYTES), SAMPLE_RATE)) {
        throw new Error("input failed");
      }
      await delay(100);
    }
    if (!client.sendActivityEnd()) throw new Error("activity end failed");
    await withTimeout(completed.promise, 45_000);
    await delay(250);
    const input = inputParts.join(" ");
    const output = outputParts.join(" ");
    return {
      firstMeaning: containsOne(input, item.sourceFirst) && containsOne(output, item.targetFirst),
      lastMeaning: containsOne(input, item.sourceLast) && containsOne(output, item.targetLast),
    };
  } finally {
    client.close();
  }
}

function fixture(direction, voice, spoken, sourceFirst, sourceLast, targetFirst, targetLast) {
  return { direction, voice, spoken, sourceFirst, sourceLast, targetFirst, targetLast };
}

function synthesize(voice, spoken) {
  const directory = mkdtempSync(join(tmpdir(), "provider-semantic-input-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.aiff");
  execFileSync("/usr/bin/say", ["-v", voice, "-o", sourcePath, spoken]);
  return execFileSync("/opt/homebrew/bin/ffmpeg", [
    "-v", "error", "-i", sourcePath, "-f", "s16le", "-acodec", "pcm_s16le",
    "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function readApiKey() {
  const fromEnvironment = process.env.GEMINI_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const match = readFileSync(join(root, ".env.local"), "utf8").match(/^GEMINI_API_KEY=(.+)$/m);
  if (!match?.[1]?.trim()) throw new Error("missing credential");
  return match[1].trim();
}

function containsOne(value, terms) {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  return terms.some((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase()));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
