#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_ENDPOINT = "http://localhost:8787/api/assistant/message";

export function parseArgs(argv, env = process.env) {
  const args = {
    endpoint: env.ASSISTANT_WORKER_ENDPOINT || DEFAULT_ENDPOINT,
    token: env.ASSISTANT_EVAL_TOKEN || "",
    eval: path.join(repoRoot, "scripts", "evals", "wa3zat-retrieval-eval.jsonl"),
    out: path.join(
      repoRoot,
      "analysis",
      "assistant-ingest",
      "wa3zat-assistant-worker-retrieval-eval-results.md",
    ),
    tier: "core",
    top: 5,
    delayMs: 100,
    rawOut: "",
    includeDebug: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    if (key === "top" || key === "delayMs") {
      args[key] = Number(next);
      if (!Number.isFinite(args[key]) || args[key] < 0) {
        throw new Error(`--${key} must be a non-negative number`);
      }
    } else if (key === "includeDebug") {
      args.includeDebug = next !== "false";
    } else {
      args[key] = next;
    }
    i += 1;
  }

  if (!args.endpoint) {
    throw new Error("Missing assistant Worker endpoint.");
  }
  if (!args.token) {
    throw new Error(
      "Missing evaluation token. Pass --token <token> or set ASSISTANT_EVAL_TOKEN.",
    );
  }

  return args;
}

export function loadJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function callAssistantWorker({ endpoint, token, item, includeDebug = true, fetchImpl = fetch }) {
  const startedAt = performance.now();
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-assistant-eval-token": token,
    },
    body: JSON.stringify({
      conversation_id: `eval-${item.id}`,
      message: item.query,
      locale: "ar",
      retrieval_only: true,
      debug: includeDebug,
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  const durationMs = roundMs(performance.now() - startedAt);

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
    error.duration_ms = durationMs;
    error.status = response.status;
    throw error;
  }

  return { body, duration_ms: durationMs, status: response.status };
}

export function evaluateResponseForItem({ item, response, top, durationMs, status }) {
  const chunks = Array.isArray(response?.retrieved_chunks)
    ? response.retrieved_chunks.slice(0, top)
    : [];
  const expectedRefs = expectedSourceRefs(item).map((sourceRef) =>
    normalizeId(sourceSlug(sourceRef)),
  );
  const rankIndex = chunks.findIndex((chunk) =>
    expectedRefs.some((expected) => chunkMatchesExpected(chunk, expected)),
  );
  const invariantFailures = checkInvariants(chunks);

  if (!chunks.length) {
    invariantFailures.push("empty retrieval");
  }

  return {
    item,
    pass: rankIndex !== -1,
    rank: rankIndex === -1 ? null : rankIndex + 1,
    chunks,
    invariant_failures: invariantFailures,
    response_debug: response?.debug ?? null,
    duration_ms: durationMs,
    status,
  };
}

export function checkInvariants(chunks) {
  const failures = [];

  chunks.forEach((chunk, index) => {
    const rank = index + 1;
    if (!isNonEmptyString(chunk?.chunk_id)) failures.push(`rank ${rank} missing chunk_id`);
    if (!isNonEmptyString(chunk?.doc_id)) failures.push(`rank ${rank} missing doc_id`);
    if (!isNonEmptyString(chunk?.url)) failures.push(`rank ${rank} missing url`);
    if (!isNonEmptyString(chunk?.text)) failures.push(`rank ${rank} missing original text`);
    if (Object.hasOwn(chunk ?? {}, "search_text")) {
      failures.push(`rank ${rank} leaked search_text`);
    }
  });

  return failures;
}

export function renderReport({ args, items, results }) {
  const passed = results.filter((result) => result.pass).length;
  const top1 = results.filter((result) => result.rank === 1).length;
  const invariantFailures = results.reduce(
    (sum, result) => sum + result.invariant_failures.length,
    0,
  );
  const thresholdPass = items.length > 0 && passed / items.length >= 0.8;

  const cpuSummaries = summarizeCpu(results);

  const lines = [
    "# Wa3zat Assistant Worker Retrieval Eval Results",
    "",
    `> Generated: ${new Date().toISOString()} | Retriever: Assistant Worker controlled retrieval`,
    "",
    "## Summary",
    "",
    `- Endpoint: ${args.endpoint}`,
    `- Tier: ${args.tier}`,
    `- Questions: ${items.length}`,
    `- Expected source in top ${args.top}: ${passed}/${items.length} (${percent(
      passed,
      items.length,
    )}%)`,
    `- Expected source at rank 1: ${top1}/${items.length} (${percent(
      top1,
      items.length,
    )}%)`,
    `- Invariant failures: ${invariantFailures}`,
    `- HTTP/request failures: ${results.filter((result) => result.error).length}`,
    `- Median request wall time: ${cpuSummaries.request.median_ms} ms`,
    `- P95 request wall time: ${cpuSummaries.request.p95_ms} ms`,
    `- Median Worker CPU time: ${cpuSummaries.workerCpu.median_ms} ms`,
    `- P95 Worker CPU time: ${cpuSummaries.workerCpu.p95_ms} ms`,
    `- Median Worker profiled wall time: ${cpuSummaries.workerProfile.median_ms} ms`,
    `- P95 Worker profiled wall time: ${cpuSummaries.workerProfile.p95_ms} ms`,
    `- Slowest profiled phase: ${cpuSummaries.slowest_phase.name} (${cpuSummaries.slowest_phase.total_ms} ms total)`,
    "- P0.3 threshold: 80% top-5",
    `- Status: ${thresholdPass && invariantFailures === 0 ? "PASS" : "FAIL"}`,
    "",
    "## Results",
    "",
    "| ID | Expected | Rank | Top Results | Notes |",
    "|---|---|---:|---|---|",
  ];

  for (const result of results) {
    const topResults = formatTopResults(result.chunks);
    const notes = [
      result.pass ? "pass" : "expected source not in top results",
      ...result.invariant_failures,
    ].join("; ");
    lines.push(
      `| ${escapeCell(result.item.id)} | ${escapeCell(
        result.item.expected_title,
      )} | ${result.rank ?? "MISS"} | ${topResults} | ${escapeCell(notes)} |`,
    );
  }

  const misses = results.filter((result) => !result.pass);
  lines.push("", "## Misses", "");
  if (!misses.length) {
    lines.push("None.");
  } else {
    for (const result of misses) {
      lines.push(
        `- ${result.item.id}: ${result.item.query} -> expected ${result.item.expected_title} (${result.item.expected_source_ref})`,
      );
    }
  }

  const invariantResults = results.filter((result) => result.invariant_failures.length);
  lines.push("", "## Invariant Failures", "");
  if (!invariantResults.length) {
    lines.push("None.");
  } else {
    for (const result of invariantResults) {
      lines.push(`- ${result.item.id}: ${result.invariant_failures.join("; ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeRawResponses(filePath, results) {
  if (!filePath) return;

  const raw = results.map((result) => ({
    id: result.item.id,
    query: result.item.query,
    expected_source_ref: result.item.expected_source_ref,
    pass: result.pass,
    rank: result.rank,
    invariant_failures: result.invariant_failures,
    chunks: result.chunks,
    response_debug: result.response_debug,
    error: result.error || null,
    status: result.status || null,
    duration_ms: result.duration_ms ?? null,
  }));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function runEval(args) {
  const items = loadJsonl(args.eval).filter((item) => item.tier === args.tier);
  if (!items.length) {
    throw new Error(`No eval items found for tier: ${args.tier}`);
  }

  const results = [];
  for (const item of items) {
    try {
      const response = await callAssistantWorker({
        endpoint: args.endpoint,
        token: args.token,
        item,
        includeDebug: args.includeDebug,
      });
      results.push(evaluateResponseForItem({ item, response: response.body, top: args.top, durationMs: response.duration_ms, status: response.status }));
    } catch (error) {
      results.push({
        item,
        pass: false,
        rank: null,
        chunks: [],
        invariant_failures: ["request failed"],
        response_debug: null,
        duration_ms: typeof error?.duration_ms === "number" ? error.duration_ms : null,
        status: typeof error?.status === "number" ? error.status : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  const report = renderReport({ args, items, results });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, report, "utf8");
  writeRawResponses(args.rawOut, results);

  return { items, results, report };
}

function summarizeCpu(results) {
  const requestDurations = results
    .map((result) => result.duration_ms)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const workerCpuDurations = results
    .map((result) => result.response_debug?.worker_cpu?.cpu_ms)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const workerProfileDurations = results
    .map((result) => result.response_debug?.worker_profile?.wall_ms)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const phaseTotals = new Map();
  for (const result of results) {
    const phases = result.response_debug?.worker_profile?.phases ?? {};
    for (const [name, value] of Object.entries(phases)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        phaseTotals.set(name, roundMs((phaseTotals.get(name) ?? 0) + value));
      }
    }
  }
  const slowestPhase = [...phaseTotals.entries()]
    .sort((a, b) => b[1] - a[1])[0] ?? ["n/a", 0];
  return {
    request: percentileSummary(requestDurations),
    workerCpu: percentileSummary(workerCpuDurations),
    workerProfile: percentileSummary(workerProfileDurations),
    slowest_phase: { name: slowestPhase[0], total_ms: slowestPhase[1] },
  };
}

function percentileSummary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) {
    return { median_ms: "n/a", p95_ms: "n/a" };
  }
  return {
    median_ms: roundMs(sorted[Math.floor((sorted.length - 1) * 0.5)]),
    p95_ms: roundMs(sorted[Math.floor((sorted.length - 1) * 0.95)]),
  };
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}
function sourceSlug(sourceRef) {
  return String(sourceRef || "").replace(/\.mdx?$/i, "");
}

function expectedSourceRefs(item) {
  if (Array.isArray(item.expected_source_refs) && item.expected_source_refs.length) {
    return item.expected_source_refs;
  }
  return [item.expected_source_ref];
}

function normalizeId(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/\.(mdx?|php|json)$/i, "")
    .toLowerCase();
}

function chunkMatchesExpected(chunk, expected) {
  const fields = [
    chunk?.chunk_id,
    chunk?.doc_id,
    chunk?.url,
    chunk?.source_ref,
    chunk?.title,
  ].map(normalizeId);

  return fields.some((field) => field.includes(expected));
}

function formatTopResults(chunks) {
  if (!chunks.length) return "None";

  return chunks
    .map((chunk, index) => {
      const label = [chunk.title, chunk.section].filter(Boolean).join(" / ");
      const id = chunk.chunk_id || "missing chunk_id";
      const url = chunk.url || "missing url";
      return `${index + 1}. ${label || id} (${id}) ${url}`;
    })
    .join("<br>")
    .replace(/\|/g, "\\|");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { items, results } = await runEval(args);
  const passed = results.filter((result) => result.pass).length;
  const top1 = results.filter((result) => result.rank === 1).length;
  const invariantFailures = results.reduce(
    (sum, result) => sum + result.invariant_failures.length,
    0,
  );

  console.log(`Tier: ${args.tier}`);
  console.log(`Questions: ${items.length}`);
  console.log(`Top-${args.top}: ${passed}/${items.length}`);
  console.log(`Rank-1: ${top1}/${items.length}`);
  console.log(`Invariant failures: ${invariantFailures}`);
  console.log(
    `Status: ${passed / items.length >= 0.8 && invariantFailures === 0 ? "PASS" : "FAIL"}`,
  );
  console.log(`Report: ${args.out}`);
  if (args.rawOut) {
    console.log(`Raw responses: ${args.rawOut}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
