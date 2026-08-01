import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const generatorPath = path.join(repoRoot, "tools", "generate-rag-jsonl.mjs");

test("generator builds the tracked sample corpus without private paths", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-zico-sample-"));

  execFileSync(process.execPath, [generatorPath, "--outDir", outDir], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const chunks = JSON.parse(fs.readFileSync(path.join(outDir, "sample.json"), "utf8"));
  const lookup = JSON.parse(
    fs.readFileSync(path.join(outDir, "chunk-lookup", "sample.json"), "utf8"),
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_id, "sample:welcome:0");
  assert.equal(chunks[0].title, "مرحبًا بك في المكتبة التجريبية");
  assert.equal(lookup["sample:welcome:0"].text, chunks[0].text);
});