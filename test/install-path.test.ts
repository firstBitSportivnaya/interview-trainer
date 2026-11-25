import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("README называет запуск, адрес, каталоги и выключенный поиск", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /npm ci/);
  assert.match(readme, /npm start/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(readme, /data\/models\/multilingual-e5-small/);
  assert.match(readme, /data\/models\/tesseract/);
  assert.match(readme, /поиск фрагментов выключен/);
});

test("скрипт загрузки не входит в npm run verify", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["fetch-models"] ?? "", /scripts\/fetch-models\.mjs/);
  assert.equal(pkg.scripts.verify.includes("fetch-models"), false);
  assert.equal(pkg.scripts.test.includes("fetch-models"), false);
});

test("веса модели и данные tesseract не входят в git", () => {
  const listed = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.includes("rus.traineddata"), false);
  assert.equal(listed.stdout.includes("multilingual-e5-small/"), false);
  assert.equal(listed.stdout.includes("data/models/"), false);
});
