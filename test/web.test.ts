import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { openTrainer } from "../src/trainer.ts";
import { startWeb } from "../src/web.ts";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-web-"));
  directories.push(directory);
  return directory;
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("веб слушает только этот компьютер, без пароля, и сохраняет ключи через ядро", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    assert.equal(address.address, "127.0.0.1");

    const base = `http://127.0.0.1:${address.port}`;
    const home = await fetch(base);
    assert.equal(home.status, 200);

    const firstSecret = "sk-ant-api03-secret-WXYZ";
    const secondSecret = "sk-deepseek-secret-9876";
    const posted = await fetch(`${base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude<script>",
        secret: firstSecret,
      }),
    });
    assert.equal(posted.status, 200);
    await fetch(`${base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secret: secondSecret,
      }),
    });

    const page = await (await fetch(base)).text();
    assert.equal(page.includes(firstSecret), false);
    assert.equal(page.includes(secondSecret), false);
    assert.equal(page.includes("••••WXYZ"), true);
    assert.equal(page.includes("••••9876"), true);
    assert.equal(page.includes("claude&lt;script&gt;"), true);
    assert.equal(page.includes("claude<script>"), false);
    assert.equal(page.includes("совместимый с OpenAI"), true);
  } finally {
    await close(server);
  }

  const keys = openTrainer(directory).listKeys();
  assert.deepEqual(
    keys.map((key) => ({
      protocol: key.protocol,
      baseAddress: key.baseAddress,
      modelName: key.modelName,
      secretPreview: key.secretPreview,
    })),
    [
      {
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude<script>",
        secretPreview: "••••WXYZ",
      },
      {
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secretPreview: "••••9876",
      },
    ],
  );
  assert.equal(JSON.stringify(keys).includes("sk-ant-api03-secret-WXYZ"), false);
  assert.equal(JSON.stringify(keys).includes("sk-deepseek-secret-9876"), false);
});

test("ошибка записи не останавливает веб", async () => {
  const server = await startWeb({
    saveKey() {
      throw new Error("disk full");
    },
    listKeys() {
      return [];
    },
  });

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const failed = await fetch(`${base}/keys`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret: "sk-ant-api03-secret-WXYZ",
      }),
    });
    assert.equal(failed.status, 500);
    assert.equal((await fetch(base)).status, 200);
  } finally {
    await close(server);
  }
});

test("чужая страница не сохраняет ключ, своя сохраняет", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const body = new URLSearchParams({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    });
    const foreign = await fetch(`${base}/keys`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body,
    });
    assert.equal(foreign.status, 403);
    assert.equal(trainer.listKeys().length, 0);

    const own = await fetch(`${base}/keys`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body,
    });
    assert.equal(own.status, 200);
    assert.equal(trainer.listKeys().length, 1);
  } finally {
    await close(server);
  }
});

test("каталог данных владельца не входит в git", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /(^|\n)data\/\r?\n/);
});
