import assert from "node:assert/strict";

import { chromium } from "playwright";

const meetingUrl = process.env.MEETING_URL ?? "http://127.0.0.1:4173";
const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const displayName = `Canary ${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();

try {
  await page.goto(meetingUrl, { waitUntil: "networkidle" });
  await page.getByLabel("표시 이름").fill(displayName);
  await page.getByLabel("日本語").check();
  await page.getByRole("button", { name: "회의 입장" }).click();
  await page.getByText("회의에 연결되었습니다", { exact: false }).waitFor();

  await page.getByRole("button", { name: "마이크 켜기" }).click();
  await page.getByRole("button", { name: "마이크 끄기" }).waitFor();
  const state = await page.evaluate(async () => (await fetch("/api/meeting")).json());
  const local = state.participants.find((participant) => participant.name === displayName);

  assert.ok(local?.id?.startsWith("participant-"));
  assert.equal(local.language, "ja");
  assert.equal(local.microphone, "unmuted");
  assert.equal(await page.getByRole("button", { name: /^(말하기|발화 종료|문장 경계)$/ }).count(), 0);
  console.log(JSON.stringify({
    participantGenerated: true,
    microphone: local.microphone,
    speech: local.speech,
    manualSpeechControls: 0,
  }));
} finally {
  await page.getByRole("button", { name: "나가기" }).click().catch(() => {});
  await browser.close();
}
