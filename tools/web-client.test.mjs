import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const clientUrl = new URL("../examples/web-client/index.html", import.meta.url);

test("example client blocks junk and clears localized validation for valid short replies", async () => {
  const html = await readFile(clientUrl, "utf8");
  const listeners = {};
  const input = { value: "", validityMessage: "", setCustomValidity(value) { this.validityMessage = value; } };
  const form = { addEventListener(name, callback) { listeners[name] = callback; } };
  input.addEventListener = (name, callback) => { listeners[name] = callback; };
  const document = {
    documentElement: {}, querySelectorAll: () => [],
    querySelector: (selector) => selector === "form" ? form : input,
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, navigator: { languages: ["en"] }, localStorage: { getItem: () => null },
  });
  for (const value of ["b", " ب ", "b?", "بَ", "😀", "?!"]) {
    input.value = value;
    listeners.input();
    assert.match(input.validityMessage, /at least two letters or digits/i, value);
  }
  for (const value of ["hi", "لا", "نعم"]) {
    input.value = value;
    listeners.input();
    assert.equal(input.validityMessage, "", value);
  }
});

test("example client demonstrates persistent accessible AR/EN locale switching", async () => {
  const html = await readFile(clientUrl, "utf8");

  assert.match(html, /navigator\.languages/);
  assert.match(html, /localStorage/);
  assert.match(html, /document\.documentElement\.lang/);
  assert.match(html, /document\.documentElement\.dir/);
  assert.match(html, /aria-label/);
  assert.match(html, /data-locale="ar"/);
  assert.match(html, /data-locale="en"/);
});

test("example client keeps canonical Arabic citation metadata in both locales", async () => {
  const html = await readFile(clientUrl, "utf8");

  assert.match(html, /الطريق الداخلي/u);
  assert.match(html, /data-canonical-citation/);
  assert.doesNotMatch(html, /data-translated-citation/);
});
