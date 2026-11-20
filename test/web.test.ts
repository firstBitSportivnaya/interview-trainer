import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";

import { DRAFT_LIMIT, openTrainer } from "../src/trainer.ts";
import { startWeb, TEXT_BODY_LIMIT } from "../src/web.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-web-"));
  directories.push(directory);
  return directory;
}

function start(directory: string) {
  const trainer = openTrainer(directory);
  opened.push(trainer);
  return trainer;
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function statusWithHost(url: string, host: string, method: string, body?: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: {
          host,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("веб слушает только этот компьютер, без пароля, и сохраняет ключи через ядро", async () => {
  const directory = tempDirectory();
  const trainer = start(directory);
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

  const keys = start(directory).listKeys();
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
    saveCase() {
      return { ok: false, reason: "incomplete" };
    },
    addCase() {
      return { ok: false, reason: "incomplete" };
    },
    listCustomers() {
      return [];
    },
    listCases() {
      return [];
    },
    readCase() {
      return undefined;
    },
    saveProfile() {},
    readProfile() {
      return { resume: "", portfolio: "", cases: "" };
    },
    async draftDossier() {
      return { ok: false, reason: "missing" };
    },
    approveDossier() {
      return { ok: false, reason: "missing" };
    },
    readApprovedDossier() {
      return undefined;
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
  const trainer = start(directory);
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

test("чужой Host не открывает страницу и не сохраняет ключ", async () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const body = new URLSearchParams({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }).toString();

    assert.equal(await statusWithHost(base, `evil.example:${address.port}`, "GET"), 403);
    assert.equal(await statusWithHost(`${base}/keys`, `evil.example:${address.port}`, "POST", body), 403);
    assert.equal(await statusWithHost(base, `127.0.0.1:1`, "GET"), 403);
    assert.equal(trainer.listKeys().length, 0);

    assert.equal(await statusWithHost(base, `127.0.0.1:${address.port}`, "GET"), 200);
    assert.equal(await statusWithHost(`${base}/keys`, `localhost:${address.port}`, "POST", body), 303);
    assert.equal(trainer.listKeys().length, 1);
  } finally {
    await close(server);
  }
});

test("веб заводит заказчика, проект и утверждённое досье тем же ядром", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete() {
      yield JSON.stringify({
        material: "ЧЕРНОВИК-МАТЕРИАЛ",
        serviceLayer: "ЧЕРНОВИК-СЛУЖЕБНЫЙ",
        crib: "ЧЕРНОВИК-ШПАРГАЛКА",
      });
    },
  });
  opened.push(trainer);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const secret = "sk-ant-api03-secret-WXYZ";

    await fetch(`${base}/keys`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret,
      }),
    });
    const keyId = trainer.listKeys()[0]?.id;
    assert.ok(keyId);

    await fetch(`${base}/profile`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ resume: "Резюме", portfolio: "Портфолио", cases: "Кейс склада" }),
    });
    const created = await fetch(`${base}/customers`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ customerName: "Север", title: "Внедрение склада", characters: "" }),
    });
    assert.equal(created.status, 200);
    const first = trainer.listCases()[0];
    assert.ok(first);
    assert.equal(new URL(created.url).pathname, `/cases/${first.id}`);

    const foreign = await fetch(`${base}/customers`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: new URLSearchParams({ customerName: "Чужой", title: "Чужой проект" }),
    });
    assert.equal(foreign.status, 403);

    await fetch(`${base}/cases`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        customerId: first.customerId,
        title: "Касса",
        characters: "Анна\nБорис",
      }),
    });

    assert.deepEqual(trainer.listCustomers(), [{ id: first.customerId, name: "Север" }]);
    assert.deepEqual(
      trainer.listCases().map((item) => ({
        title: item.title,
        customerId: item.customerId,
        characters: item.characters,
        portfolioSent: item.portfolioSent,
      })),
      [
        { title: "Внедрение склада", customerId: first.customerId, characters: [], portfolioSent: false },
        { title: "Касса", customerId: first.customerId, characters: ["Анна", "Борис"], portfolioSent: false },
      ],
    );
    assert.deepEqual(trainer.readProfile(), { resume: "Резюме", portfolio: "Портфолио", cases: "Кейс склада" });

    const firstPage = await (await fetch(`${base}/cases/${first.id}`)).text();
    assert.equal(firstPage.includes("Голоса заказчика: заказчик"), true);
    assert.equal(firstPage.includes("Отметка «портфолио уже отправлено» снята."), true);
    assert.equal(firstPage.includes("Сессия не открывается."), true);
    assert.equal(firstPage.includes(secret), false);

    const drafted = await fetch(`${base}/cases/${first.id}/draft`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        material: "СЫРЬЁ-МАТЕРИАЛ",
        serviceLayer: "СЫРЬЁ-СЛУЖЕБНЫЙ",
        crib: "СЫРЬЁ-ШПАРГАЛКА",
        keyId,
      }),
    });
    const draftPage = await drafted.text();
    assert.equal(drafted.status, 200);
    assert.equal(draftPage.includes("ЧЕРНОВИК-МАТЕРИАЛ"), true);
    assert.equal(draftPage.includes("СЫРЬЁ-МАТЕРИАЛ"), false);
    assert.equal(draftPage.includes(secret), false);
    assert.equal(trainer.readApprovedDossier(first.id), undefined);

    const approved = await fetch(`${base}/cases/${first.id}/approve`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        material: "УТВЕРЖДЕНО<script>",
        serviceLayer: "УТВЕРЖДЕНО-СЛУЖЕБНЫЙ",
        crib: "УТВЕРЖДЕНО-ШПАРГАЛКА",
      }),
    });
    const approvedPage = await approved.text();
    assert.equal(approved.status, 200);
    assert.equal(approvedPage.includes("УТВЕРЖДЕНО&lt;script&gt;"), true);
    assert.equal(approvedPage.includes("УТВЕРЖДЕНО<script>"), false);
    assert.equal(approvedPage.includes("Сессия ещё не открывается."), true);
    assert.equal(approvedPage.includes("СЫРЬЁ-МАТЕРИАЛ"), false);
    assert.equal(approvedPage.includes("ЧЕРНОВИК-МАТЕРИАЛ"), false);
    assert.deepEqual(trainer.readApprovedDossier(first.id), {
      id: trainer.readApprovedDossier(first.id)?.id,
      caseId: first.id,
      material: "УТВЕРЖДЕНО<script>",
      serviceLayer: "УТВЕРЖДЕНО-СЛУЖЕБНЫЙ",
      crib: "УТВЕРЖДЕНО-ШПАРГАЛКА",
    });
  } finally {
    await close(server);
  }
});

test("утверждение принимает показанный черновик с кириллицей", async () => {
  const widest = new URLSearchParams({
    material: "€".repeat(DRAFT_LIMIT),
    serviceLayer: "",
    crib: "",
  }).toString();
  assert.ok(Buffer.byteLength(widest) <= TEXT_BODY_LIMIT);

  const draft = {
    material: `Пример: \`\`\`sql SELECT 1; \`\`\` ${"Я".repeat(4000)}`,
    serviceLayer: "Служебный слой €",
    crib: "Спросить про срок",
  };
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete() {
      yield JSON.stringify(draft);
    },
  });
  opened.push(trainer);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    await fetch(`${base}/keys`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret: "sk-ant-api03-secret-WXYZ",
      }),
    });
    const keyId = trainer.listKeys()[0]?.id;
    assert.ok(keyId);
    await fetch(`${base}/customers`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ customerName: "Север", title: "Касса" }),
    });
    const caseId = trainer.listCases()[0]?.id;
    assert.ok(caseId);

    const drafted = await fetch(`${base}/cases/${caseId}/draft`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        material: "сырьё",
        serviceLayer: "сырьё",
        crib: "сырьё",
        keyId,
      }),
    });
    const draftPage = await drafted.text();
    assert.equal(drafted.status, 200);
    assert.equal(draftPage.includes("Я".repeat(4000)), true);
    assert.equal(draftPage.includes("```sql SELECT 1;"), true);
    assert.equal(draftPage.includes("сырьё"), false);
    assert.equal(trainer.readApprovedDossier(caseId), undefined);

    const body = new URLSearchParams(draft).toString();
    assert.ok(Buffer.byteLength(body) <= TEXT_BODY_LIMIT);
    const approved = await fetch(`${base}/cases/${caseId}/approve`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(trainer.readApprovedDossier(caseId), {
      id: trainer.readApprovedDossier(caseId)?.id,
      caseId,
      ...draft,
    });
  } finally {
    await close(server);
  }
});

test("каталог данных владельца не входит в git", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /(^|\n)data\/\r?\n/);
});
