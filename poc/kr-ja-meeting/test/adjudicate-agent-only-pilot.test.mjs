import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runAgentOnlyAdjudicator } from "../scripts/adjudicate-agent-only-pilot.mjs";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("adjudication rejects a .ua-pilot output that Git does not ignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-adjudication-output-"));
  const repo = join(root, "repo");
  try {
    await mkdir(repo);
    git(repo, ["init", "--quiet"]);

    await assert.rejects(
      runAgentOnlyAdjudicator([
        "--raw", join(root, "missing-raw.json"),
        "--output", join(repo, ".ua-pilot", "adjudication.json"),
      ]),
      /ignored local \.ua-pilot storage/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adjudication rejects a pre-existing tracked .ua-pilot output file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-adjudication-tracked-output-"));
  const repo = join(root, "repo");
  const output = join(repo, ".ua-pilot", "adjudication.json");
  try {
    await mkdir(join(repo, ".ua-pilot"), { recursive: true });
    git(repo, ["init", "--quiet"]);
    await writeFile(output, "{}\n", "utf8");
    git(repo, ["add", "--force", ".ua-pilot/adjudication.json"]);

    await assert.rejects(
      runAgentOnlyAdjudicator([
        "--raw", join(root, "missing-raw.json"),
        "--output", output,
      ]),
      /ignored local \.ua-pilot storage/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adjudication rejects a symlinked .ua-pilot output parent", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ua-adjudication-symlink-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside", ".ua-pilot");
  try {
    await mkdir(repo);
    await mkdir(outside, { recursive: true });
    git(repo, ["init", "--quiet"]);
    await writeFile(join(repo, ".gitignore"), ".ua-pilot/\n", "utf8");
    await symlink(outside, join(repo, ".ua-pilot"), "dir");

    await assert.rejects(
      runAgentOnlyAdjudicator([
        "--raw", join(root, "missing-raw.json"),
        "--output", join(repo, ".ua-pilot", "adjudication.json"),
      ]),
      /must not use a symlinked parent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
