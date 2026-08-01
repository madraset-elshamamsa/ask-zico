#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const DEFAULTS = {
  input: path.join(repoRoot, "analysis", "assistant-ingest", "chunk-lookup", "wa3zat.json"),
  out: path.join(
    repoRoot,
    "analysis",
    "assistant-ingest",
    "vectorize",
    "wa3zat-embeddings.ndjson",
  ),
  model: "@cf/baai/bge-m3",
  batchSize: 2,
  maxRetries: 4,
  retryDelayMs: 1000,
};

const METADATA_FIELDS = [
  "doc_id",
  "content_type",
  "library",
  "source_library",
  "language",
  "source_ref",
  "semanticDomain",
];

function parseArgs(argv) {
  const args = {
    ...DEFAULTS,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || "",
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

    if (!(key in args)) {
      throw new Error(`Unknown option: --${key}`);
    }

    args[key] =
      key === "batchSize" || key === "maxRetries" || key === "retryDelayMs"
        ? Number(next)
        : next;
    i += 1;
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
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

function validateOptions(options) {
  if (!options.accountId) {
    throw new Error("Missing Cloudflare account ID. Set CLOUDFLARE_ACCOUNT_ID.");
  }
  if (!options.apiToken) {
    throw new Error(
      "Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_AUTH_TOKEN.",
    );
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw new Error("--batchSize must be an integer from 1 to 100");
  }
  if (
    !Number.isInteger(options.maxRetries) ||
    options.maxRetries < 0 ||
    options.maxRetries > 10
  ) {
    throw new Error("--maxRetries must be an integer from 0 to 10");
  }
  if (
    !Number.isInteger(options.retryDelayMs) ||
    options.retryDelayMs < 0 ||
    options.retryDelayMs > 60000
  ) {
    throw new Error("--retryDelayMs must be an integer from 0 to 60000");
  }
}

function validateChunk(key, chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    throw new Error(`Chunk ${key} must be an object`);
  }

  const chunkId = requiredString(chunk, "chunk_id", key);
  requiredString(chunk, "doc_id", key);
  requiredString(chunk, "search_text", key);

  if (chunkId !== key) {
    throw new Error(`Chunk key ${key} does not match chunk_id ${chunkId}`);
  }
}

function chunkBatches(items, batchSize) {
  const batches = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

function metadataFor(chunk) {
  const metadata = {};
  for (const field of METADATA_FIELDS) {
    if (typeof chunk[field] === "string") {
      metadata[field] = chunk[field];
    }
  }
  if (Array.isArray(chunk.facets) && chunk.facets.every((facet) => typeof facet === "string")) {
    metadata.facets = chunk.facets.join(",");
  }
  return metadata;
}

function extractEmbeddings(body, expectedCount) {
  const data = body?.result?.data ?? body?.data;
  if (!Array.isArray(data)) {
    throw new Error("Workers AI response did not include result.data");
  }
  if (data.length !== expectedCount) {
    throw new Error(`Workers AI returned ${data.length} embeddings for ${expectedCount} inputs`);
  }

  return data.map((vector, index) => {
    if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) {
      throw new Error(`Embedding at index ${index} is not a number array`);
    }
    return vector;
  });
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestEmbeddingBatch(options, texts) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${options.model}`;
  const response = await options.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok || body?.success === false) {
    const error = new Error(
      `Workers AI embedding request failed: HTTP ${response.status} ${bodyText}`,
    );
    error.status = response.status;
    throw error;
  }

  return extractEmbeddings(body, texts.length);
}

async function embedSearchTextBatch(options, texts) {
  let attempt = 0;

  while (true) {
    try {
      return await requestEmbeddingBatch(options, texts);
    } catch (error) {
      const status = error && typeof error === "object" ? error.status : undefined;
      const canRetry = typeof status === "number" && isTransientStatus(status);
      if (!canRetry || attempt >= options.maxRetries) {
        throw error;
      }

      attempt += 1;
      const delay = options.retryDelayMs * attempt;
      console.warn(
        `Workers AI embedding batch failed with HTTP ${status}; retrying attempt ${attempt}/${options.maxRetries} after ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

export async function prepareVectorizeEmbeddings(options = {}) {
  const args = {
    ...DEFAULTS,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN || "",
    fetchImpl: globalThis.fetch,
    ...options,
  };

  validateOptions(args);

  const lookup = readJson(args.input);
  if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) {
    throw new Error(`Expected lookup JSON object at ${args.input}`);
  }

  const keys = Object.keys(lookup).sort();
  const chunks = keys.map((key) => {
    const chunk = lookup[key];
    validateChunk(key, chunk);
    return chunk;
  });

  const lines = [];
  for (const batch of chunkBatches(chunks, args.batchSize)) {
    const embeddings = await embedSearchTextBatch(
      args,
      batch.map((chunk) => chunk.search_text),
    );

    for (let index = 0; index < batch.length; index += 1) {
      lines.push(
        JSON.stringify({
          id: batch[index].chunk_id,
          values: embeddings[index],
          metadata: metadataFor(batch[index]),
        }),
      );
    }
  }

  ensureDir(path.dirname(args.out));
  fs.writeFileSync(args.out, `${lines.join("\n")}\n`, "utf8");

  return {
    chunks: chunks.length,
    out: args.out,
    model: args.model,
  };
}

async function main() {
  const result = await prepareVectorizeEmbeddings(parseArgs(process.argv.slice(2)));
  console.log(`Prepared ${result.chunks} Vectorize embeddings`);
  console.log(`Model: ${result.model}`);
  console.log(`Wrote ${result.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
