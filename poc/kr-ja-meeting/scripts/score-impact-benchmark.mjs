#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  loadImpactBenchmark,
  scoreImpactBenchmark,
} from "../src/impact-benchmark-contract.mjs";

const resultPath = process.argv[2];
if (!resultPath) {
  console.error("usage: npm run benchmark:score -- <paired-comparison-result.json>");
  process.exitCode = 2;
} else {
  try {
    const [benchmark, result] = await Promise.all([
      loadImpactBenchmark(),
      readFile(resultPath, "utf8").then(JSON.parse),
    ]);
    const score = scoreImpactBenchmark(benchmark, result);
    console.log(JSON.stringify(score, null, 2));
    if (!score.pass) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
