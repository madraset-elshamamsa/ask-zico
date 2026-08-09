import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".local", "node_modules"]);
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".sql", ".ts", ".yaml", ".yml",
]);
const suspiciousText = new RegExp(
  "\\uFFFD|[\\u0080-\\u009F]|\\u00D8|\\u00D9|\\u00C3|\\u00C2|\\u00EF\\u00BF\\u00BD",
  "u",
);

async function textFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(absolutePath));
    else if (textExtensions.has(path.extname(entry.name))) files.push(absolutePath);
  }
  return files;
}

test("public text files contain valid readable UTF-8", async () => {
  const failures = [];
  for (const file of await textFiles(repositoryRoot)) {
    const contents = await readFile(file, "utf8");
    if (suspiciousText.test(contents)) {
      failures.push(path.relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(failures, [], `Suspicious encoding in:\n${failures.join("\n")}`);
});
