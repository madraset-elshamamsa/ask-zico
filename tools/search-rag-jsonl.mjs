#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    corpus: path.join(repoRoot, "analysis", "assistant-ingest", "wa3zat.jsonl"),
    query: "",
    top: 5,
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
    if (key === "top") {
      args.top = Number(next);
    } else {
      args[key] = next;
    }
    i += 1;
  }
  if (!args.query) {
    throw new Error("Usage: node scripts/search-rag-jsonl.mjs --query \"...\" [--top 5]");
  }
  return args;
}

function normalizeArabicForSearch(input) {
  return input
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function loadJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tokenize(input) {
  return normalizeArabicForSearch(input)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function scoreChunk(chunk, queryTokens, normalizedQuery) {
  let score = 0;
  const title = normalizeArabicForSearch(chunk.title || "");
  const section = normalizeArabicForSearch(chunk.section || "");
  const summary = normalizeArabicForSearch(chunk.summary || "");
  const text = chunk.search_text || "";

  if (text.includes(normalizedQuery)) score += 12;
  if (title.includes(normalizedQuery)) score += 20;
  if (section.includes(normalizedQuery)) score += 10;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 8;
    if (section.includes(token)) score += 4;
    if (summary.includes(token)) score += 3;
    score += Math.min(countOccurrences(text, token), 8);
  }
  return score;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadJsonl(args.corpus);
  const normalizedQuery = normalizeArabicForSearch(args.query);
  const queryTokens = tokenize(args.query);

  const hits = rows
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, queryTokens, normalizedQuery),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.top);

  console.log(`Query: ${args.query}`);
  console.log(`Normalized: ${normalizedQuery}`);
  console.log("");
  for (const [index, hit] of hits.entries()) {
    const { chunk, score } = hit;
    console.log(`${index + 1}. ${chunk.title} / ${chunk.section} (${score})`);
    console.log(`   ${chunk.url}`);
    console.log(`   ${chunk.chunk_id}`);
    console.log(`   ${chunk.text.slice(0, 240).replace(/\s+/g, " ")}...`);
    console.log("");
  }
  if (!hits.length) {
    console.log("No hits.");
  }
}

main();
