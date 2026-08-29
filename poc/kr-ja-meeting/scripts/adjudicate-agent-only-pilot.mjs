#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { adjudicateAgentOnlyGate } from "../src/agent-only-pilot-gate.mjs";

const benchmarkPath = fileURLToPath(
  new URL("../benchmark/impact-benchmark.v1.json", import.meta.url),
);

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--raw", "--output"].includes(option) || !value) {
      throw new Error("usage: adjudicate-agent-only-pilot --raw <raw-results.json> --output <.ua-pilot/result.json>");
    }
    options[option.slice(2)] = value;
  }
  if (!options.raw || !options.output) {
    throw new Error("--raw and --output are required");
  }
  return options;
}

function requireLocalArtifactPath(path) {
  const absolute = resolve(path);
  if (!isAbsolute(absolute) || !absolute.split(sep).includes(".ua-pilot")) {
    throw new Error("--output must be inside an ignored .ua-pilot directory");
  }
  return absolute;
}

export async function runAgentOnlyAdjudicator(args) {
  const options = parseOptions(args);
  const outputPath = requireLocalArtifactPath(options.output);
  const [benchmarkText, rawText] = await Promise.all([
    readFile(benchmarkPath, "utf8"),
    readFile(resolve(options.raw), "utf8"),
  ]);
  const result = adjudicateAgentOnlyGate({ benchmarkText, rawText });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, outputPath);
  return { outputPath, result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { outputPath, result } = await runAgentOnlyAdjudicator(process.argv.slice(2));
    console.log(JSON.stringify({ outputPath, resultRouting: result.resultRouting, metrics: result.metrics }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
