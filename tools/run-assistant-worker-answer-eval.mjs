#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_ENDPOINT = "http://localhost:8787/api/assistant/message";
const HANDOFF_PREFIX = "مش لاقي في المصادر المتاحة إجابة مؤكدة";

export function parseArgs(argv, env = process.env) {
  const args = {
    endpoint: env.ASSISTANT_WORKER_ENDPOINT || DEFAULT_ENDPOINT,
    token: env.ASSISTANT_EVAL_TOKEN || "",
    eval: path.join(repoRoot, "scripts", "evals", "wa3zat-retrieval-eval.jsonl"),
    out: path.join(
      repoRoot,
      "analysis",
      "assistant-ingest",
      "wa3zat-assistant-worker-answer-eval-results.md",
    ),
    rawOut: path.join(
      repoRoot,
      "analysis",
      "assistant-ingest",
      "wa3zat-assistant-worker-answer-eval-responses.json",
    ),
    tier: "core",
    top: 5,
    delayMs: 250,
    limit: 0,
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

    if (key === "top" || key === "delayMs" || key === "limit") {
      args[key] = Number(next);
      if (!Number.isFinite(args[key]) || args[key] < 0) {
        throw new Error(`--${key} must be a non-negative number`);
      }
    } else if (Object.hasOwn(args, key)) {
      args[key] = next;
    } else {
      throw new Error(`Unknown argument: --${key}`);
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

export async function callAssistantWorker({ endpoint, token, item, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-assistant-eval-token": token,
    },
    body: JSON.stringify({
      conversation_id: `answer-eval-${item.id}`,
      message: item.query,
      locale: "ar",
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  return body;
}

export function evaluateAnswerResponse({ item, response, top }) {
  const answer = typeof response?.answer === "string" ? response.answer.trim() : "";
  const citations = Array.isArray(response?.citations) ? response.citations : [];
  const retrievedChunks = Array.isArray(response?.retrieved_chunks)
    ? response.retrieved_chunks
    : [];
  const expected = normalizeId(sourceSlug(item.expected_source_ref));

  const answerDebug = response?.debug?.answer ?? null;
  const inputChunkChars = numberValue(answerDebug?.input_chunk_chars);
  const modelContextChars = numberValue(answerDebug?.model_context_chars);

  return {
    item,
    response,
    error: null,
    answer,
    confidence: response?.confidence ?? null,
    has_answer: answer.length > 0,
    is_handoff: answer.startsWith(HANDOFF_PREFIX),
    has_citations: citations.length > 0,
    cited_urls: citations
      .map((citation) => citation?.url)
      .filter((url) => typeof url === "string" && url.trim().length > 0),
    suggested_action_urls: Array.isArray(response?.suggested_actions)
      ? response.suggested_actions
        .map((action) => action?.url)
        .filter((url) => typeof url === "string" && url.trim().length > 0)
      : [],
    expected_source_in_retrieved_top_k: retrievedChunks
      .slice(0, top)
      .some((chunk) => chunkMatchesExpected(chunk, expected)),
    expected_source_cited: citations.some((citation) =>
      normalizeId(citation?.url).includes(expected),
    ),
    answer_debug: answerDebug,
    response_debug: response?.debug ?? null,
    compact_context: answerDebug?.compact_context === true,
    context_chunks: numberValue(answerDebug?.context_chunks),
    context_excerpt_chars: numberValue(answerDebug?.context_excerpt_chars),
    input_chunk_chars: inputChunkChars,
    model_context_chars: modelContextChars,
    context_reduction_percent: reductionPercent(inputChunkChars, modelContextChars),
  };
}

export function renderReport({ args, items, results }) {
  const successfulRequests = results.filter((result) => !result.error).length;
  const answered = results.filter((result) => result.has_answer).length;
  const handoffs = results.filter((result) => result.is_handoff).length;
  const cited = results.filter((result) => result.has_citations).length;
  const expectedRetrieved = results.filter(
    (result) => result.expected_source_in_retrieved_top_k,
  ).length;
  const expectedCited = results.filter((result) => result.expected_source_cited).length;
  const compactResponses = results.filter((result) => result.compact_context).length;
  const avgInputChars = average(results.map((result) => result.input_chunk_chars));
  const avgModelContextChars = average(results.map((result) => result.model_context_chars));
  const avgReductionPercent = reductionPercent(avgInputChars, avgModelContextChars);

  const lines = [
    "# Wa3zat Assistant Worker Answer Eval Results",
    "",
    `> Generated: ${new Date().toISOString()} | Endpoint: ${args.endpoint}`,
    "",
    "## Summary",
    "",
    `- Tier: ${args.tier}`,
    `- Questions: ${items.length}`,
    `- Successful requests: ${successfulRequests}/${items.length}`,
    `- Non-empty answers: ${answered}/${items.length}`,
    `- Handoff answers: ${handoffs}/${items.length}`,
    `- Responses with citations: ${cited}/${items.length}`,
    `- Expected source in retrieved top ${args.top}: ${expectedRetrieved}/${items.length}`,
    `- Expected source cited: ${expectedCited}/${items.length}`,
    `- Compact-context responses: ${compactResponses}/${items.length}`,
    `- Average input chunk chars: ${avgInputChars}`,
    `- Average model context chars: ${avgModelContextChars}`,
    `- Average context reduction: ${avgReductionPercent}%`,
    `- Raw responses: ${args.rawOut}`,
    "",
    "## Results",
    "",
    "| ID | Expected | Answer | Confidence | Citations | Expected Retrieved | Expected Cited | Context | Notes |",
    "|---|---|---|---|---:|---|---|---|---|",
  ];

  for (const result of results) {
    const notes = [
      result.error ? result.error : "",
      result.answer_debug?.reason ? `answer:${result.answer_debug.reason}` : "",
      result.is_handoff ? "handoff" : "",
      !result.has_answer ? "empty answer" : "",
      !result.has_citations ? "no citations" : "",
    ]
      .filter(Boolean)
      .join("; ");

    lines.push(
      `| ${escapeCell(result.item.id)} | ${escapeCell(
        result.item.expected_title,
      )} | ${escapeCell(truncate(result.answer, 160))} | ${escapeCell(
        result.confidence ?? "",
      )} | ${result.cited_urls.length} | ${result.expected_source_in_retrieved_top_k ? "yes" : "no"
      } | ${result.expected_source_cited ? "yes" : "no"} | ${formatContext(result)} | ${escapeCell(notes)} |`,
    );
  }

  const failures = results.filter((result) => result.error);
  lines.push("", "## Request Failures", "");
  if (!failures.length) {
    lines.push("None.");
  } else {
    for (const result of failures) {
      lines.push(`- ${result.item.id}: ${result.error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeRawResponses(filePath, results) {
  if (!filePath) return;

  const raw = results.map((result) => ({
    id: result.item.id,
    tier: result.item.tier,
    query: result.item.query,
    expected_title: result.item.expected_title,
    expected_source_ref: result.item.expected_source_ref,
    tests: result.item.tests,
    error: result.error,
    has_answer: result.has_answer,
    is_handoff: result.is_handoff,
    has_citations: result.has_citations,
    expected_source_in_retrieved_top_k: result.expected_source_in_retrieved_top_k,
    expected_source_cited: result.expected_source_cited,
    cited_urls: result.cited_urls,
    suggested_action_urls: result.suggested_action_urls,
    response_debug: result.response_debug,
    answer_debug: result.answer_debug,
    compact_context: result.compact_context,
    context_chunks: result.context_chunks,
    context_excerpt_chars: result.context_excerpt_chars,
    input_chunk_chars: result.input_chunk_chars,
    model_context_chars: result.model_context_chars,
    context_reduction_percent: result.context_reduction_percent,
    response: result.response,
  }));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export async function runEval(args, { fetchImpl = fetch } = {}) {
  let items = loadJsonl(args.eval).filter((item) => item.tier === args.tier);
  if (args.limit > 0) {
    items = items.slice(0, args.limit);
  }
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
        fetchImpl,
      });
      results.push(evaluateAnswerResponse({ item, response, top: args.top }));
    } catch (error) {
      results.push({
        item,
        response: null,
        error: error instanceof Error ? error.message : String(error),
        answer: "",
        confidence: null,
        has_answer: false,
        is_handoff: false,
        has_citations: false,
        cited_urls: [],
        suggested_action_urls: [],
        expected_source_in_retrieved_top_k: false,
        expected_source_cited: false,
        answer_debug: null,
        response_debug: null,
        compact_context: false,
        context_chunks: 0,
        context_excerpt_chars: 0,
        input_chunk_chars: 0,
        model_context_chars: 0,
        context_reduction_percent: 0,
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

function sourceSlug(sourceRef) {
  return String(sourceRef || "").replace(/\.mdx?$/i, "");
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

function formatContext(result) {
  if (!result.compact_context) return "full";
  return `${result.model_context_chars}/${result.input_chunk_chars} chars (${result.context_reduction_percent}% less)`;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function average(values) {
  const realValues = values.filter((value) => value > 0);
  if (!realValues.length) return 0;
  return Math.round(realValues.reduce((sum, value) => sum + value, 0) / realValues.length);
}

function reductionPercent(inputChars, modelChars) {
  if (!inputChars || !modelChars || modelChars >= inputChars) return 0;
  return Math.round(((inputChars - modelChars) / inputChars) * 100);
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { items, results } = await runEval(args);
  const successfulRequests = results.filter((result) => !result.error).length;
  const answered = results.filter((result) => result.has_answer).length;
  const handoffs = results.filter((result) => result.is_handoff).length;
  const cited = results.filter((result) => result.has_citations).length;

  console.log(`Tier: ${args.tier}`);
  console.log(`Questions: ${items.length}`);
  console.log(`Successful requests: ${successfulRequests}/${items.length}`);
  console.log(`Non-empty answers: ${answered}/${items.length}`);
  console.log(`Handoff answers: ${handoffs}/${items.length}`);
  console.log(`Responses with citations: ${cited}/${items.length}`);
  console.log(`Report: ${args.out}`);
  console.log(`Raw responses: ${args.rawOut}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
