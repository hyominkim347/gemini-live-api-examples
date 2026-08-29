const REQUIRED_CANARIES = [
  { category: "service", command: "npm run check" },
  { category: "browser", command: "npm run canary:natural-conversation" },
];

export async function runFinalCanaries({
  run,
  includePlayout = false,
  includeProvider = false,
} = {}) {
  if (typeof run !== "function") throw new Error("final canary command runner is required");

  const evidence = [];
  for (const canary of REQUIRED_CANARIES) {
    evidence.push(await runCanary(canary, run));
  }

  evidence.push(includePlayout
    ? await runCanary({
      category: "playout",
      command: "npm run canary:playout-continuity",
    }, run)
    : {
      category: "playout",
      status: "local-livekit-gated",
      command: "npm run canary:playout-continuity",
      detail: "Run with --include-playout while a local LiveKit server is available.",
    });

  evidence.push(includeProvider
    ? await runCanary({
      category: "provider",
      command: "npm run canary:provider-browser",
    }, run)
    : {
      category: "provider",
      status: "credential-gated",
      command: "npm run canary:provider-browser",
      detail: "Run with --include-provider only in an authorized credential environment.",
    });

  evidence.push({
    category: "human",
    status: "not-claimed",
    detail: "Automated canaries do not establish human comprehension, fatigue, preference, or an exact gain.",
  });

  return {
    ok: evidence.every(({ status }) => !["failed"].includes(status)),
    evidence,
  };
}

async function runCanary({ category, command }, run) {
  const result = await run(command);
  if (result?.status === 0) {
    return {
      category,
      status: "passed",
      command,
      ...(compact(result.stdout) ? { detail: compact(result.stdout) } : {}),
    };
  }
  return {
    category,
    status: "failed",
    command,
    detail: compact(result?.stderr) || compact(result?.stdout) || "command failed without output",
  };
}

function compact(value) {
  if (typeof value !== "string") return "";
  const lines = value.trim().split("\n").filter(Boolean);
  return lines.at(-1)?.slice(0, 500) ?? "";
}
