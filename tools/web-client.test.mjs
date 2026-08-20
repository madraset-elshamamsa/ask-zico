import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientUrl = new URL("../examples/web-client/index.html", import.meta.url);

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
