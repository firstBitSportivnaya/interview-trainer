import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { liveEncoder, localEmbeddings, type LocalEncoder } from "../src/embeddings.ts";

const FILE_TEXT = "приёмку паллет ведут по местам хранения";
const TURN_TEXT = "Как принимаете паллеты?";

function norm(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

/** Два токена со скрытым размером 384. Среднее — [1.5, 2, 0, …], норма 2.5, единичный вектор — [0.6, 0.8, 0, …]. */
function encoder(seen: string[]): LocalEncoder {
  return {
    async encode(prefixedText) {
      seen.push(prefixedText);
      const first = Array.from({ length: 384 }, () => 0);
      const second = Array.from({ length: 384 }, () => 0);
      first[0] = 3;
      second[1] = 4;
      return [first, second];
    },
  };
}

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

test("установка считает вектор файла и хода локально", async () => {
  const seen: string[] = [];
  await withFetchForbidden(async (calls) => {
    const port = localEmbeddings(encoder(seen));
    const passage = await port.embed(FILE_TEXT, "passage");
    const query = await port.embed(TURN_TEXT, "query");

    assert.equal(calls.length, 0);
    assert.deepEqual(seen, [`passage: ${FILE_TEXT}`, `query: ${TURN_TEXT}`]);
    assert.equal(passage.length, 384);
    assert.equal(query.length, 384);
    assert.ok(Math.abs(norm(passage) - 1) < 1e-12);
    assert.ok(Math.abs(norm(query) - 1) < 1e-12);
    assert.ok(Math.abs(passage[0] - 0.6) < 1e-12);
    assert.ok(Math.abs(passage[1] - 0.8) < 1e-12);
    assert.equal(passage[2], 0);
  });
});

test("ряд скрытых состояний другой длины не становится вектором 384", async () => {
  const port = localEmbeddings({
    async encode() {
      return [[1, 0]];
    },
  });
  await withFetchForbidden(async (calls) => {
    const vector = await port.embed(FILE_TEXT, "passage");
    assert.equal(calls.length, 0);
    assert.deepEqual(vector, []);
  });
});

const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("без файла модели локальный расчёт сеть не вызывает", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trainer-embeddings-"));
  directories.push(directory);
  await withFetchForbidden(async (calls) => {
    const rows = await liveEncoder(directory).encode(`passage: ${FILE_TEXT}`);
    assert.equal(calls.length, 0);
    assert.deepEqual(rows, []);
  });
});
