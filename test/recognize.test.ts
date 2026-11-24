import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { liveRecognizer } from "../src/recognize.ts";

const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withFetchForbidden<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("сеть запрещена");
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("без файла распознавателя надписи нет и сеть не вызывается", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trainer-recognize-"));
  directories.push(directory);
  await withFetchForbidden(async (calls) => {
    const text = await liveRecognizer(directory).recognize(Uint8Array.of(1, 2, 3));
    assert.equal(calls.length, 0);
    assert.equal(text, "");
  });
});
