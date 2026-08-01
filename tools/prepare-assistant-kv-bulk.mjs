#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const DEFAULTS = {
  input: path.join(
    path.dirname(__filename),
    "..",
    "analysis",
    "assistant-ingest",
    "chunk-lookup",
    "wa3zat.json",
  ),
  out: path.join(
    path.dirname(__filename),
    "..",
    "analysis",
    "assistant-ingest",
    "kv",
    "wa3zat-kv-bulk.json",
  ),
  lexicalKey: "lexical:domain",
  previousManifest: "",
  manifestOut: "",
  deltaOut: "",
  deletedOut: "",
};

const METADATA_FIELDS = [
  "doc_id",
  "chunk_id",
  "url",
  "title",
  "library",
  "source_library",
  "content_type",
  "section",
  "language",
  "source_ref",
  "summary",
  "categories",
  "authors",
  "keywords",
  "semanticDomain",
  "facets",
];

const LEXICAL_FIELDS = [
  "doc_id",
  "chunk_id",
  "url",
  "title",
  "library",
  "source_library",
  "content_type",
  "section",
  "language",
  "source_ref",
  "summary",
  "categories",
  "authors",
  "keywords",
  "semanticDomain",
  "facets",
  "entities",
  "events",
  "places",
  "symbols",
  "themes",
  "aliases",
  "enriched_terms",
];

function parseArgs(argv) {
  const args = { ...DEFAULTS };

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

    if (!(key in args)) {
      throw new Error(`Unknown option: --${key}`);
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readManifest(filePath) {
  if (!filePath) return null;
  const manifest = readJson(filePath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Expected manifest JSON object at ${filePath}`);
  }
  const entries = manifest.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`Expected manifest entries object at ${filePath}`);
  }
  return manifest;
}

function inputPaths(input) {
  return String(input)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function requiredString(chunk, field, key) {
  const value = chunk[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Chunk ${key} is missing required string field: ${field}`);
  }
  return value;
}

function validateChunk(key, chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    throw new Error(`Chunk ${key} must be an object`);
  }

  const chunkId = requiredString(chunk, "chunk_id", key);
  requiredString(chunk, "doc_id", key);
  requiredString(chunk, "url", key);
  requiredString(chunk, "title", key);
  requiredString(chunk, "text", key);
  requiredString(chunk, "search_text", key);

  if (chunkId !== key) {
    throw new Error(`Chunk key ${key} does not match chunk_id ${chunkId}`);
  }
}

function compactMetadataChunk(chunk) {
  return compactChunkFields(chunk, METADATA_FIELDS);
}

function compactChunkFields(chunk, fields) {
  const compact = {};
  for (const field of fields) {
    if (typeof chunk[field] === "string") {
      compact[field] = chunk[field];
    } else if (
      Array.isArray(chunk[field]) &&
      chunk[field].every((item) => typeof item === "string")
    ) {
      compact[field] = chunk[field];
    }
  }
  return compact;
}

function compactLexicalChunk(chunk, options = {}) {
  const compact = compactChunkFields(chunk, LEXICAL_FIELDS);
  if (options.includeSearchText && typeof chunk.search_text === "string") {
    compact.search_text = chunk.search_text;
  }
  if (options.includeDetailSearchText && typeof chunk.detail_search_text === "string") {
    compact.detail_search_text = chunk.detail_search_text;
  }
  return compact;
}

const OPTIONAL_LIBRARY_SHARDS = {
  aqwal: { lexical: "lexical:facet:fathers" },
  cartoon: { lexical: "lexical:facet:cartoon" },
  seneksar: { lexical: "lexical:facet:seneksar" },
  coptic: {},
  about: {},
};

function optionalLibraryShard(chunk) {
  return OPTIONAL_LIBRARY_SHARDS[chunk.source_library] ?? null;
}

function metadataKeysForChunk() {
  return ["lexical:metadata"];
}
function lexicalKeyForChunk(baseKey, chunk) {
  if (baseKey === "lexical:domain") {
    const domain = typeof chunk.semanticDomain === "string" ? chunk.semanticDomain : "ta3lim";
    return `${baseKey}:${domain}`;
  }
  return baseKey;
}

function lexicalKeysForChunk(baseKey, chunk) {
  const optionalShard = optionalLibraryShard(chunk);
  if (baseKey === "lexical:domain" && optionalShard?.lexical) {
    return [optionalShard.lexical];
  }

  if (
    baseKey === "lexical:domain" &&
    (chunk.content_type === "verse" ||
      (Array.isArray(chunk.facets) && chunk.facets.includes("verse")))
  ) {
    return ["lexical:facet:verse"];
  }

  const keys = [lexicalKeyForChunk(baseKey, chunk)];
  if (
    baseKey === "lexical:domain" &&
    Array.isArray(chunk.facets) &&
    chunk.facets.includes("sermon")
  ) {
    keys.push("lexical:facet:sermon");
  }
  if (
    baseKey === "lexical:domain" &&
    chunk.content_type === "bible_summary" &&
    typeof chunk.detail_search_text === "string" &&
    chunk.detail_search_text.trim() !== ""
  ) {
    keys.push("lexical:facet:bible-summary-detail");
  }
  return keys;
}

function addLexicalChunk(lexicalByKey, lexicalKey, chunk) {
  const lexicalChunks = lexicalByKey.get(lexicalKey) ?? [];
  lexicalChunks.push(
    compactLexicalChunk(chunk, {
      includeSearchText: lexicalKey.startsWith("lexical:domain:") || lexicalKey === "lexical:facet:verse" || lexicalKey === "lexical:facet:fathers" || lexicalKey === "lexical:facet:cartoon" || lexicalKey === "lexical:facet:seneksar",
      includeDetailSearchText: lexicalKey === "lexical:domain:taqs" || lexicalKey === "lexical:facet:bible-summary-detail",
    }),
  );
  lexicalByKey.set(lexicalKey, lexicalChunks);
}

function storedChunkRecord(chunk) {
  const { detail_search_text: _detailSearchText, ...stored } = chunk;
  return stored;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJsonFile(filePath, value) {
  if (!filePath) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function manifestForEntries(entries) {
  return {
    version: 1,
    entries: Object.fromEntries(
      entries.map((entry) => [entry.key, hashValue(entry.value)]).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function deltaEntries(entries, currentManifest, previousManifest, affectedLexicalKeys) {
  if (!previousManifest) return entries;
  const previousEntries = previousManifest.entries;
  const deltaKeySet = new Set(
    entries
      .filter((entry) => previousEntries[entry.key] !== currentManifest.entries[entry.key])
      .map((entry) => entry.key),
  );
  for (const key of affectedLexicalKeys) {
    deltaKeySet.add(key);
  }
  return entries.filter((entry) => deltaKeySet.has(entry.key));
}

function deletedKeys(currentManifest, previousManifest) {
  if (!previousManifest) return [];
  const currentKeys = new Set(Object.keys(currentManifest.entries));
  return Object.keys(previousManifest.entries)
    .filter((key) => !currentKeys.has(key))
    .sort((a, b) => a.localeCompare(b));
}

export function prepareKvBulk(options = {}) {
  const args = { ...DEFAULTS, ...options };
  const previousManifest = readManifest(args.previousManifest);
  const lookups = inputPaths(args.input).map((input) => {
    const lookup = readJson(input);
    if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) {
      throw new Error(`Expected lookup JSON object at ${input}`);
    }
    return lookup;
  });

  const entries = [];
  const lexicalByKey = new Map();
  const chunkLexicalKeysByChunkKey = new Map();
  const mergedLookup = Object.assign({}, ...lookups);
  const keys = Object.keys(mergedLookup).sort();

  for (const key of keys) {
    const chunk = mergedLookup[key];
    validateChunk(key, chunk);

    entries.push({
      key,
      value: JSON.stringify(storedChunkRecord(chunk)),
    });
    const lexicalKeys = [...lexicalKeysForChunk(args.lexicalKey, chunk), ...metadataKeysForChunk(chunk)];
    chunkLexicalKeysByChunkKey.set(key, lexicalKeys);
    for (const lexicalKey of lexicalKeys) {
      if (lexicalKey.startsWith("lexical:metadata")) {
        const lexicalChunks = lexicalByKey.get(lexicalKey) ?? [];
        lexicalChunks.push(compactMetadataChunk(chunk));
        lexicalByKey.set(lexicalKey, lexicalChunks);
      } else {
        addLexicalChunk(lexicalByKey, lexicalKey, chunk);
      }
    }
  }

  for (const [key, lexicalChunks] of [...lexicalByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({
      key,
      value: JSON.stringify(lexicalChunks),
    });
  }

  ensureDir(path.dirname(args.out));
  fs.writeFileSync(args.out, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  const currentManifest = manifestForEntries(entries);
  const affectedLexicalKeys = new Set();
  if (previousManifest) {
    for (const key of keys) {
      if (previousManifest.entries[key] !== currentManifest.entries[key]) {
        for (const lexicalKey of chunkLexicalKeysByChunkKey.get(key) ?? []) {
          affectedLexicalKeys.add(lexicalKey);
        }
      }
    }
  }
  const removedKeys = deletedKeys(currentManifest, previousManifest);
  const delta = deltaEntries(entries, currentManifest, previousManifest, affectedLexicalKeys);

  writeJsonFile(args.manifestOut, currentManifest);
  writeJsonFile(args.deltaOut, delta);
  writeJsonFile(args.deletedOut, removedKeys);

  return {
    chunks: keys.length,
    entries: entries.length,
    deltaEntries: delta.length,
    deletedKeys: removedKeys.length,
    out: args.out,
    lexicalKey: args.lexicalKey,
  };
}

function main() {
  const result = prepareKvBulk(parseArgs(process.argv.slice(2)));
  console.log(`Prepared ${result.entries} KV entries for ${result.chunks} chunks`);
  if (result.deltaEntries !== result.entries || result.deletedKeys > 0) {
    console.log(`Delta entries: ${result.deltaEntries}`);
    console.log(`Deleted keys pending approval: ${result.deletedKeys}`);
  }
  console.log(`Lexical fallback key: ${result.lexicalKey}`);
  console.log(`Wrote ${result.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
