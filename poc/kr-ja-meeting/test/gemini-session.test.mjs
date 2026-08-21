import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryResumptionHandleStore,
  buildGeminiSetup,
} from "../src/gemini-session.mjs";

test("Gemini setup enables directional audio translation and session resumption only", () => {
  assert.deepEqual(buildGeminiSetup({ targetLanguage: "ko" }), {
    setup: {
      model: "models/gemini-3.5-live-translate-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: "ko",
          echoTargetLanguage: true,
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false },
      },
      sessionResumption: {},
    },
  });

  const resumed = buildGeminiSetup({
    targetLanguage: "ja",
    resumptionHandle: "opaque-handle",
  });
  assert.deepEqual(resumed.setup.sessionResumption, { handle: "opaque-handle" });
  assert.equal("tools" in resumed.setup, false);
  assert.equal("inputAudioTranscription" in resumed.setup, false);
  assert.equal("outputAudioTranscription" in resumed.setup, false);

  const manualActivity = buildGeminiSetup({
    targetLanguage: "ko",
    automaticActivityDetection: false,
  });
  assert.deepEqual(
    manualActivity.setup.realtimeInputConfig.automaticActivityDetection,
    { disabled: true },
  );
});

test("resumption handles exist only in memory and are cleared with the meeting", () => {
  const handles = new MemoryResumptionHandleStore();

  handles.set("meeting-1", "ko", "ko-handle");
  handles.set("meeting-1", "ja", "ja-handle");
  assert.equal(handles.get("meeting-1", "ko"), "ko-handle");
  assert.equal(handles.size, 2);

  handles.clearMeeting("meeting-1");
  assert.equal(handles.get("meeting-1", "ko"), null);
  assert.equal(handles.get("meeting-1", "ja"), null);
  assert.equal(handles.size, 0);
});
