import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";

import { ABSENT_FACT, DRAFT_LIMIT, openTrainer } from "../src/trainer.ts";
import { ModelFailure } from "../src/model.ts";
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
    addSourceFile() {
      return { ok: false, reason: "missing" };
    },
    listSourceFiles() {
      return [];
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
    openSession() {
      return { ok: false, reason: "missing" };
    },
    readSession() {
      return undefined;
    },
    readTranscript() {
      return undefined;
    },
    readReview() {
      return undefined;
    },
    async finishSession() {
      return { ok: false, reason: "missing" };
    },
    listSessions() {
      return [];
    },
    async *openingQuestion() {},
    async *reply() {},
    listOpenSessions() {
      return [];
    },
    setPortfolioSent() {
      return { ok: false, reason: "missing" };
    },
    readPreparationEntries() {
      return [];
    },
    readPreparationEntry() {
      return undefined;
    },
    dismissPreparation() {
      return { ok: false, reason: "missing" };
    },
    acceptProposal() {
      return { ok: false, reason: "missing" };
    },
    assignExecutor() {
      return { ok: false, reason: "missing" };
    },
    revokeAssignment() {
      return { ok: false, reason: "missing" };
    },
    listUnreadFiles() {
      return [];
    },
    listAssignments() {
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
    assert.equal(approvedPage.includes("Открыть сессию"), true);
    assert.equal(approvedPage.includes("Сессия ещё не открывается."), false);
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

test("веб открывает сессию заказчика, и стенограмма читается на странице", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      const task = text.split("\n\n").at(-1) ?? "";
      if (task.startsWith("Задай один вопрос")) {
        yield "Как ";
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield "принимаете паллеты?";
        return;
      }
      const marker = "Материал проекта:\n";
      const start = text.indexOf(marker);
      const end = text.indexOf("\n\nСтенограмма:");
      const material = start < 0 || end < 0 ? "" : text.slice(start + marker.length, end);
      if (material.includes("паллеты") && task.includes("паллет")) {
        yield "Склад принимает паллеты.";
        return;
      }
      yield ABSENT_FACT;
    },
  });
  opened.push(trainer);
  const server = await startWeb(trainer);

  try {
    const secret = "sk-ant-api03-secret-WXYZ";
    assert.deepEqual(
      trainer.saveKey({
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret,
      }),
      { ok: true },
    );
    const keyId = trainer.listKeys()[0]?.id;
    assert.ok(keyId);
    const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
    assert.ok(saved.ok);
    const approved = trainer.approveDossier({
      caseId: saved.caseRecord.id,
      material: "Склад принимает паллеты.",
      serviceLayer: "Маржа подрядчика 12%.",
      crib: "Спросить про сроки.",
    });
    assert.ok(approved.ok);

    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const casePage = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(casePage.includes("Открыть сессию"), true);
    assert.equal(casePage.includes("Анна"), true);
    assert.equal(casePage.includes(">аналитик<"), true);

    const foreign = await fetch(`${base}/cases/${saved.caseRecord.id}/session`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: new URLSearchParams({ side: "заказчик", character: "Анна", role: "аналитик", keyId }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(trainer.listOpenSessions().length, 0);

    const wrongCharacter = await fetch(`${base}/cases/${saved.caseRecord.id}/session`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ side: "заказчик", character: "Чужой", role: "аналитик", keyId }),
    });
    const wrongPage = await wrongCharacter.text();
    assert.equal(wrongPage.includes("Выберите персонажа заказчика."), true);
    assert.equal(trainer.listOpenSessions().length, 0);

    const created = await fetch(`${base}/cases/${saved.caseRecord.id}/session`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ side: "заказчик", character: "Анна", role: "аналитик", keyId }),
    });
    assert.equal(created.status, 200);
    const open = trainer.listOpenSessions()[0];
    assert.ok(open);
    assert.equal(open.executorId, "владелец");
    assert.equal(open.keyId, keyId);
    assert.equal(open.side, "заказчик");
    assert.equal(new URL(created.url).pathname, `/sessions/${open.id}`);
    const empty = await created.text();
    assert.equal(empty.includes("Стенограмма пока пуста."), true);
    assert.equal(empty.includes("Сессия помнит ключ: Anthropic — claude-sonnet"), true);
    assert.equal(empty.includes(secret), false);
    assert.equal(empty.includes("Маржа подрядчика 12%."), false);

    const stream = await fetch(`${base}/sessions/${open.id}/opening`);
    assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buffered = "";
    let sawGap = false;
    let finished = false;
    while (!finished) {
      const read = await reader.read();
      if (read.value) {
        buffered += decoder.decode(read.value, { stream: true });
      }
      if (buffered.includes("data: Как") && !buffered.includes("принимаете паллеты?")) {
        sawGap = true;
      }
      finished = read.done || buffered.includes("event: done");
    }
    assert.equal(sawGap, true);
    assert.equal(buffered.includes("принимаете паллеты?"), true);

    const filled = await (await fetch(`${base}/sessions/${open.id}`)).text();
    assert.equal(filled.includes("Как принимаете паллеты?"), true);
    assert.equal(filled.includes(secret), false);

    const again = await fetch(`${base}/sessions/${open.id}/opening`);
    const second = await again.text();
    assert.equal(second.includes("принимаете паллеты?"), false);
    assert.equal(second.includes("event: done"), true);
    assert.equal(trainer.readTranscript(open.id)?.filter((line) => line.kind === "вопрос").length, 1);

    const answer = await fetch(`${base}/sessions/${open.id}/ask`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ line: "Какие паллеты принимает склад?" }),
    });
    const answerPage = await answer.text();
    assert.equal(answerPage.includes("Склад принимает паллеты."), true);
    assert.equal(answerPage.includes(secret), false);

    const absent = await fetch(`${base}/sessions/${open.id}/ask`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ line: "Какая маржа?" }),
    });
    const absentPage = await absent.text();
    assert.equal(absentPage.includes(ABSENT_FACT), true);
    assert.equal(absentPage.includes("12%"), false);
    assert.equal(trainer.readSession(open.id)?.keyId, keyId);
  } finally {
    await close(server);
  }
});

test("закрытие потока первого вопроса останавливает модель", async () => {
  let signal: AbortSignal | undefined;
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete(_call, incoming) {
      signal = incoming;
      yield "Как ";
      await new Promise<void>((resolve) => {
        if (incoming.aborted) {
          resolve();
          return;
        }
        incoming.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  opened.push(trainer);
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const openedSession = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: `/sessions/${openedSession.session.id}/opening`,
          method: "GET",
        },
        (res) => {
          res.on("data", () => req.destroy());
          res.on("error", () => resolve());
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(signal?.aborted === true), 1000);
      const mark = (): void => {
        if (signal?.aborted) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      if (signal) {
        signal.addEventListener("abort", mark, { once: true });
      }
      mark();
    });
    assert.equal(stopped, true);
    assert.equal(
      trainer.readTranscript(openedSession.session.id)?.some((line) => line.kind === "вопрос"),
      false,
    );
  } finally {
    await close(server);
  }
});

test("веб записывает файл в названный слой и не меняет утверждённое досье", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete() {
      yield JSON.stringify({ material: "черновик", serviceLayer: "", crib: "" });
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
    await fetch(`${base}/customers`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ customerName: "Север", title: "Внедрение склада", characters: "" }),
    });
    const item = trainer.listCases()[0];
    assert.ok(item);

    const bare = await (await fetch(`${base}/cases/${item.id}`)).text();
    assert.equal(bare.includes('<option value="">Выберите слой</option>'), true);
    assert.equal(bare.includes('value="material" selected'), false);
    assert.equal(bare.includes('value="serviceLayer" selected'), false);
    assert.equal(bare.includes('value="crib" selected'), false);

    await fetch(`${base}/cases/${item.id}/approve`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        material: "УТВЕРЖДЁННЫЙ-МАТЕРИАЛ",
        serviceLayer: "УТВЕРЖДЁННЫЙ-СЛУЖЕБНЫЙ",
        crib: "УТВЕРЖДЁННАЯ-ШПАРГАЛКА",
      }),
    });
    const approved = trainer.readApprovedDossier(item.id);
    assert.ok(approved);

    const refused = await fetch(`${base}/cases/${item.id}/file`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        name: "служебный-слой.xlsx",
        layer: "",
        extractedText: "НЕ-УГАДЫВАТЬ",
      }),
    });
    const refusedPage = await refused.text();
    assert.equal(refused.status, 200);
    assert.equal(refusedPage.includes("Выберите слой. Тренажёр слой не назначает сам."), true);
    assert.equal(refusedPage.includes("Файлов проекта пока нет."), true);
    assert.equal(refusedPage.includes("НЕ-УГАДЫВАТЬ"), false);
    assert.deepEqual(trainer.listSourceFiles(item.id), []);
    assert.deepEqual(trainer.readApprovedDossier(item.id), approved);

    const raw = "СЫРОЙ-ТЕКСТ-ФАЙЛА";
    const saved = await fetch(`${base}/cases/${item.id}/file`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        name: "протокол.xlsx",
        layer: "serviceLayer",
        extractedText: raw,
      }),
    });
    const page = await saved.text();
    assert.equal(saved.status, 200);
    assert.equal(page.includes("протокол.xlsx — Служебный слой"), true);
    const approvedHtml = page.split("<h2>Утверждённое досье</h2>")[1] ?? "";
    assert.equal(approvedHtml.includes(raw), false);
    assert.equal(approvedHtml.includes("УТВЕРЖДЁННЫЙ-МАТЕРИАЛ"), true);
    assert.deepEqual(trainer.readApprovedDossier(item.id), approved);
    assert.equal(trainer.listSourceFiles(item.id)[0]?.layer, "serviceLayer");
    assert.equal(trainer.listSourceFiles(item.id)[0]?.extractedText, raw);
  } finally {
    await close(server);
  }
});

test("страница проекта ставит и снимает отметку «портфолио уже отправлено»", async () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const server = await startWeb(trainer);

  try {
    const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
    assert.ok(saved.ok);
    const approved = trainer.approveDossier({
      caseId: saved.caseRecord.id,
      material: "Склад принимает паллеты.",
      serviceLayer: "Маржа подрядчика 12%.",
      crib: "Спросить про сроки.",
    });
    assert.ok(approved.ok);

    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const before = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(before.includes("Отметка «портфолио уже отправлено» снята."), true);
    assert.equal(before.includes("Поставить отметку «портфолио уже отправлено»"), true);

    const foreign = await fetch(`${base}/cases/${saved.caseRecord.id}/portfolio`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: new URLSearchParams({ sent: "1" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(trainer.readCase(saved.caseRecord.id)?.portfolioSent, false);

    const unknown = await fetch(`${base}/cases/нет-такого-проекта/portfolio`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ sent: "1" }),
    });
    assert.equal(unknown.status, 404);

    const noise = await fetch(`${base}/cases/${saved.caseRecord.id}/portfolio`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ sent: "позже" }),
    });
    const noisePage = await noise.text();
    assert.equal(noise.status, 200);
    assert.equal(noisePage.includes("Отметка «портфолио уже отправлено» снята."), true);
    assert.equal(trainer.readCase(saved.caseRecord.id)?.portfolioSent, false);
    assert.deepEqual(trainer.readApprovedDossier(saved.caseRecord.id), approved.dossier);

    const marked = await fetch(`${base}/cases/${saved.caseRecord.id}/portfolio`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ sent: "1" }),
    });
    const markedPage = await marked.text();
    assert.equal(marked.status, 200);
    assert.equal(markedPage.includes("Отметка «портфолио уже отправлено» стоит."), true);
    assert.equal(trainer.readCase(saved.caseRecord.id)?.portfolioSent, true);
    assert.deepEqual(trainer.readApprovedDossier(saved.caseRecord.id), approved.dossier);

    const cleared = await fetch(`${base}/cases/${saved.caseRecord.id}/portfolio`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ sent: "0" }),
    });
    const clearedPage = await cleared.text();
    assert.equal(cleared.status, 200);
    assert.equal(clearedPage.includes("Отметка «портфолио уже отправлено» снята."), true);
    assert.equal(trainer.readCase(saved.caseRecord.id)?.portfolioSent, false);
  } finally {
    await close(server);
  }
});

test("каталог данных владельца не входит в git", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /(^|\n)data\/\r?\n/);
});

const REVIEW =
  "Прозвучало служебное: маржа подрядчика. Речь разошлась с досье: склад закрыт. Речь разошлась с текстом файла проекта: вес паллеты. Не прозвучал вопрос шпаргалки проекта: Спросить про сроки.";

test("веб заканчивает сессию, открывает разбор и оставляет стенограмму", async () => {
  const calls: { secret: string; text: string }[] = [];
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      calls.push({ secret: call.secret, text });
      if (!text.includes("Разбери законченную сессию")) {
        yield "Склад принимает паллеты.";
        return;
      }
      const ready =
        text.includes("Числовой оценки не ставь.") &&
        text.includes("Маржа подрядчика 12%.") &&
        text.includes("маржа двенадцать") &&
        text.includes("Склад принимает паллеты.") &&
        text.includes("Склад закрыт") &&
        text.includes("Спросить про сроки.") &&
        text.includes("ФАЙЛ-ВЕС-ПАЛЛЕТЫ") &&
        text.includes("ФАЙЛ-ШПАРГАЛКИ") &&
        !text.includes("ПОЗДНИЙ-ФАЙЛ") &&
        !text.includes("ПОЗДНЯЯ-ШПАРГАЛКА");
      yield ready ? REVIEW : "разбор неполный";
    },
  });
  opened.push(trainer);
  const secret = "sk-ant-api03-secret-WXYZ";
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret,
    }),
    { ok: true },
  );
  assert.deepEqual(
    trainer.saveKey({
      protocol: "openai-compatible",
      baseAddress: "https://api.openai.com/v1",
      modelName: "other-model",
      secret: "sk-other-secret-ABCD",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  assert.ok(
    trainer.addSourceFile({
      caseId: saved.caseRecord.id,
      name: "протокол.xlsx",
      layer: "material",
      extractedText: "ФАЙЛ-ВЕС-ПАЛЛЕТЫ",
    }).ok,
  );
  assert.ok(
    trainer.addSourceFile({
      caseId: saved.caseRecord.id,
      name: "вопросы.txt",
      layer: "crib",
      extractedText: "ФАЙЛ-ШПАРГАЛКИ",
    }).ok,
  );
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  assert.ok(
    trainer.writePreparation({
      caseId: saved.caseRecord.id,
      role: "аналитик",
      executorId: "владелец",
      note: "НЕ-ПИСАТЬ-В-РАЗБОР",
    }).ok,
  );
  const notes = trainer.readPreparation(saved.caseRecord.id, "аналитик", "владелец");
  const openedSession = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);
  for await (const _event of trainer.reply(openedSession.session.id, "У нас маржа двенадцать.")) {
    // реплика нужна стенограмме до разбора
  }
  for await (const _event of trainer.reply(openedSession.session.id, "Склад закрыт.")) {
    // вторая реплика расходится с досье
  }
  assert.ok(
    trainer.addSourceFile({
      caseId: saved.caseRecord.id,
      name: "позже.txt",
      layer: "material",
      extractedText: "ПОЗДНИЙ-ФАЙЛ",
    }).ok,
  );
  assert.ok(
    trainer.addSourceFile({
      caseId: saved.caseRecord.id,
      name: "позже-шпаргалка.txt",
      layer: "crib",
      extractedText: "ПОЗДНЯЯ-ШПАРГАЛКА",
    }).ok,
  );
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const before = await (await fetch(`${base}/sessions/${openedSession.session.id}`)).text();
    assert.equal(before.includes("Закончить сессию"), true);
    assert.equal(before.includes("У нас маржа двенадцать."), true);
    assert.equal(before.includes("<h2>Разбор</h2>"), false);
    assert.equal(before.includes(secret), false);

    const foreign = await fetch(`${base}/sessions/${openedSession.session.id}/finish`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: "",
    });
    assert.equal(foreign.status, 403);
    assert.equal(trainer.readSession(openedSession.session.id)?.status, "open");

    const missing = await fetch(`${base}/sessions/${encodeURIComponent("нет-такой-сессии")}/finish`, {
      method: "POST",
      headers,
      body: "",
    });
    assert.equal(missing.status, 404);

    const finished = await fetch(`${base}/sessions/${openedSession.session.id}/finish`, {
      method: "POST",
      headers,
      body: "",
    });
    assert.equal(finished.status, 200);
    assert.equal(new URL(finished.url).pathname, `/sessions/${openedSession.session.id}`);
    const page = await finished.text();
    assert.equal(page.includes(REVIEW), true);
    assert.equal(page.includes('id="review"'), true);
    assert.equal(page.includes("У нас маржа двенадцать."), true);
    assert.equal(page.includes("Склад закрыт."), true);
    assert.equal(page.includes('id="ask"'), false);
    assert.equal(page.includes('name="score"'), false);
    assert.equal(page.includes("Закончить сессию"), false);
    assert.equal(page.includes(secret), false);
    assert.equal(page.includes("12%"), false);
    assert.equal(trainer.readSession(openedSession.session.id)?.status, "finished");
    assert.deepEqual(trainer.readPreparation(saved.caseRecord.id, "аналитик", "владелец"), notes);

    const reviewCall = calls.find((call) => call.text.includes("Разбери законченную сессию"));
    assert.ok(reviewCall);
    assert.equal(reviewCall.secret, secret);
    assert.notEqual(reviewCall.secret, "sk-other-secret-ABCD");

    const again = await (await fetch(`${base}/sessions/${openedSession.session.id}`)).text();
    assert.equal(again.includes(REVIEW), true);
    assert.equal(again.includes("У нас маржа двенадцать."), true);
    const casePage = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(casePage.includes(`Разбор: Анна, аналитик`), true);

    const asked = await fetch(`${base}/sessions/${openedSession.session.id}/ask`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ line: "Ещё вопрос" }),
    });
    const afterAsk = await asked.text();
    assert.equal(afterAsk.includes("Ещё вопрос"), false);
    assert.equal(
      trainer.readTranscript(openedSession.session.id)?.some((line) => line.text === "Ещё вопрос"),
      false,
    );
  } finally {
    await close(server);
  }
});

test("сбой разбора на вебе оставляет стенограмму и не пишет ход подготовки", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        throw new ModelFailure("model");
      }
      yield "Склад принимает паллеты.";
    },
  });
  opened.push(trainer);
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  assert.ok(
    trainer.writePreparation({
      caseId: saved.caseRecord.id,
      role: "аналитик",
      executorId: "владелец",
      note: "НЕ-ПИСАТЬ-В-РАЗБОР",
    }).ok,
  );
  const notes = trainer.readPreparation(saved.caseRecord.id, "аналитик", "владелец");
  const openedSession = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);
  for await (const _event of trainer.reply(openedSession.session.id, "У нас маржа двенадцать.")) {
    // реплика остаётся, даже если разбор сорвался
  }
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const failed = await fetch(`${base}/sessions/${openedSession.session.id}/finish`, {
      method: "POST",
      headers,
      body: "",
    });
    const page = await failed.text();
    assert.equal(failed.status, 200);
    assert.equal(page.includes("Модель вернула ошибку."), true);
    assert.equal(page.includes("У нас маржа двенадцать."), true);
    assert.equal(page.includes("<h2>Разбор</h2>"), false);
    assert.equal(page.includes("Закончить сессию"), true);
    assert.equal(trainer.readSession(openedSession.session.id)?.status, "open");
    assert.equal(trainer.readReview(openedSession.session.id), undefined);
    assert.deepEqual(trainer.readPreparation(saved.caseRecord.id, "аналитик", "владелец"), notes);
  } finally {
    await close(server);
  }
});

test("веб снимает сигнал и расхождение и принимает правку, не трогая открытую сессию", async () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory, {
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        yield `Разбор без оценки.\nХОД\n${JSON.stringify({
          gaps: ["Спросить про сроки."],
          covered: [],
          watch: ["СИГНАЛ-СЛЕДИТЬ"],
          divergence: ["Склад назван закрытым."],
          line: "Давить на срок.",
          proposals: [{ layer: "material", text: "Склад принимает европаллеты." }],
        })}`;
        return;
      }
      yield "Склад принимает паллеты.";
    },
  });
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id ?? "";
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const first = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(first.ok);
  assert.ok((await trainer.finishSession(first.session.id)).ok);
  const open = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(open.ok);
  const entries = trainer.readPreparationEntries(saved.caseRecord.id, "аналитик", "владелец");
  const watch = entries.find((entry) => entry.kind === "watch");
  const divergence = entries.find((entry) => entry.kind === "divergence");
  const proposal = entries.find((entry) => entry.kind === "proposal");
  const gap = entries.find((entry) => entry.kind === "gap");
  assert.ok(watch && divergence && proposal && gap);

  const server = await startWeb(trainer);
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const before = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(before.includes("СИГНАЛ-СЛЕДИТЬ"), true);
    assert.equal(before.includes("Склад назван закрытым."), true);
    assert.equal(before.includes("Спросить про сроки."), true);
    assert.equal(before.includes("Склад принимает европаллеты."), true);
    assert.equal(before.includes(">Снять<"), true);
    assert.equal(before.includes(">Принять правку<"), true);

    const dismissed = await fetch(`${base}/cases/${saved.caseRecord.id}/preparation`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ entryId: watch.id, act: "dismiss" }),
    });
    assert.equal(dismissed.status, 200);
    await fetch(`${base}/cases/${saved.caseRecord.id}/preparation`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ entryId: divergence.id, act: "dismiss" }),
    });
    await fetch(`${base}/cases/${saved.caseRecord.id}/preparation`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ entryId: gap.id, act: "dismiss" }),
    });
    const accepted = await fetch(`${base}/cases/${saved.caseRecord.id}/preparation`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ entryId: proposal.id, act: "accept" }),
    });
    const page = await accepted.text();
    assert.equal(page.includes("СИГНАЛ-СЛЕДИТЬ"), false);
    assert.equal(page.includes("Склад назван закрытым."), false);
    assert.equal(page.includes("Спросить про сроки."), true);
    assert.equal(page.includes("Склад принимает европаллеты."), true);
    assert.equal(trainer.readPreparationEntry(watch.id)?.status, "closed");
    assert.equal(trainer.readPreparationEntry(divergence.id)?.status, "closed");
    assert.equal(trainer.readPreparationEntry(gap.id)?.status, "open");
    assert.equal(trainer.readPreparationEntry(proposal.id)?.status, "accepted");
    assert.equal(trainer.readSession(open.session.id)?.dossierId, approved.dossier.id);
    assert.equal(trainer.readDossier(approved.dossier.id)?.material, "Склад принимает паллеты.");
    assert.equal(trainer.readApprovedDossier(saved.caseRecord.id)?.material.includes("Склад принимает европаллеты."), true);
  } finally {
    await close(server);
    trainer.close();
  }
});

test("страница записывает назначение, и то же ядро его видит", async () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const dossier = approved.dossier;
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const server = await startWeb(trainer);

  const executorId = "другой<script>";
  const openAs = (role: string) =>
    trainer.openSession({
      caseId: saved.caseRecord.id,
      dossierId: dossier.id,
      side: "заказчик",
      character: "Анна",
      role,
      executorId,
      keyId,
    });

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };
    const before = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(before.includes("Записать назначение"), true);
    assert.equal(before.includes("Назначений пока нет."), true);
    assert.equal(before.includes('type="password"'), false);
    assert.deepEqual(openAs("аналитик"), { ok: false, reason: "assignment" });

    const empty = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId: "  ", act: "assign" }),
    });
    const emptyPage = await empty.text();
    assert.equal(empty.status, 200);
    assert.equal(emptyPage.includes("Укажите исполнителя."), true);
    assert.deepEqual(openAs("аналитик"), { ok: false, reason: "assignment" });

    const foreign = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: new URLSearchParams({ executorId: "другой-исполнитель", act: "assign" }),
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(openAs("аналитик"), { ok: false, reason: "assignment" });

    const missing = await fetch(`${base}/cases/${encodeURIComponent("нет-такого-проекта")}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId: "другой-исполнитель", act: "assign" }),
    });
    assert.equal(missing.status, 404);

    const assigned = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId, act: "assign" }),
    });
    assert.equal(assigned.status, 200);
    const assignedPage = await assigned.text();
    assert.equal(assignedPage.includes("другой&lt;script&gt;"), true);
    assert.equal(assignedPage.includes("другой<script>"), false);
    assert.equal(assignedPage.includes("Назначений пока нет."), false);
    assert.deepEqual(trainer.listAssignments(saved.caseRecord.id), [
      { executorId, caseId: saved.caseRecord.id },
    ]);
    const seen = openAs("разработчик");
    assert.ok(seen.ok);
    assert.equal(seen.session.executorId, executorId);
    assert.equal(seen.session.caseId, saved.caseRecord.id);
    assert.deepEqual(trainer.readApprovedDossier(saved.caseRecord.id), dossier);
  } finally {
    await close(server);
  }

  const again = start(directory);
  const stored = again.listCases().find((item) => item.title === "Внедрение склада");
  assert.ok(stored);
  const storedDossier = again.readApprovedDossier(stored.id);
  const storedKey = again.listKeys()[0]?.id;
  assert.ok(storedDossier && storedKey);
  const reopened = again.openSession({
    caseId: stored.id,
    dossierId: storedDossier.id,
    side: "заказчик",
    character: "Анна",
      role: "функциональный архитектор",
      executorId: "другой<script>",
      keyId: storedKey,
    });
    assert.ok(reopened.ok);
    assert.equal(reopened.session.executorId, "другой<script>");
    assert.deepEqual(again.listAssignments(stored.id), [{ executorId: "другой<script>", caseId: stored.id }]);
  });

test("страница отзывает назначение, и то же ядро его не видит", async () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    }),
    { ok: true },
  );
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  assert.deepEqual(trainer.assignExecutor({ executorId: "другой-исполнитель", caseId: saved.caseRecord.id }), {
    ok: true,
  });
  const held = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "другой-исполнитель",
    keyId,
  });
  assert.ok(held.ok);
  const server = await startWeb(trainer);

  const openAs = (role: string) =>
    trainer.openSession({
      caseId: saved.caseRecord.id,
      dossierId: approved.dossier.id,
      side: "заказчик",
      character: "Анна",
      role,
      executorId: "другой-исполнитель",
      keyId,
    });

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base };

    const empty = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId: "", act: "revoke" }),
    });
    const emptyPage = await empty.text();
    assert.equal(emptyPage.includes("Укажите исполнителя."), true);
    assert.equal(emptyPage.includes("другой-исполнитель"), true);
    assert.ok(openAs("разработчик").ok);

    const other = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId: "никто", act: "revoke" }),
    });
    const otherPage = await other.text();
    assert.equal(otherPage.includes("Назначения на этот проект нет."), true);
    assert.equal(trainer.readSession(held.session.id)?.status, "open");

    const foreign = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: new URLSearchParams({ executorId: "другой-исполнитель", act: "revoke" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(trainer.readSession(held.session.id)?.dossierId, approved.dossier.id);

    const revoked = await fetch(`${base}/cases/${saved.caseRecord.id}/assignment`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ executorId: "другой-исполнитель", act: "revoke" }),
    });
    const page = await revoked.text();
    assert.equal(revoked.status, 200);
    assert.equal(page.includes("Назначения на этот проект нет."), false);
    assert.equal(page.includes("другой-исполнитель"), false);
    assert.equal(page.includes("Назначений пока нет."), true);
    assert.deepEqual(trainer.listAssignments(saved.caseRecord.id), []);
    assert.equal(trainer.readSession(held.session.id)?.status, "open");
    assert.equal(trainer.readSession(held.session.id)?.dossierId, approved.dossier.id);
    assert.deepEqual(openAs("функциональный архитектор"), { ok: false, reason: "assignment" });
  } finally {
    await close(server);
  }

  const again = start(directory);
  const stored = again.listCases().find((item) => item.title === "Внедрение склада");
  assert.ok(stored);
  const storedDossier = again.readApprovedDossier(stored.id);
  const storedKey = again.listKeys()[0]?.id;
  assert.ok(storedDossier && storedKey);
  assert.deepEqual(
    again.openSession({
      caseId: stored.id,
      dossierId: storedDossier.id,
      side: "заказчик",
      character: "Анна",
      role: "технический архитектор",
      executorId: "другой-исполнитель",
      keyId: storedKey,
    }),
    { ok: false, reason: "assignment" },
  );
  assert.equal(again.readSession(held.session.id)?.status, "open");
});

test("страница показывает непрочитанный файл и не помечает файл в названном слое", async () => {
  const trainer = start(tempDirectory());
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const other = trainer.saveCase({ customerName: "Юг", title: "Касса", characters: [] });
  assert.ok(other.ok);
  assert.ok(trainer.noteUnreadFile({ caseId: saved.caseRecord.id, name: "скан.pdf" }).ok);
  assert.ok(trainer.noteUnreadFile({ caseId: other.caseRecord.id, name: "чужой.pdf" }).ok);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const unread = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(unread.includes("скан.pdf — не прочитан"), true);
    assert.equal(unread.includes("чужой.pdf"), false);
    assert.equal(unread.includes("скан.pdf — Материал проекта"), false);

    assert.ok(
      trainer.addSourceFile({
        caseId: saved.caseRecord.id,
        name: "скан.pdf",
        layer: "material",
        extractedText: "Склад принимает паллеты.",
      }).ok,
    );
    const read = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(read.includes("скан.pdf — не прочитан"), false);
    assert.equal(read.includes("скан.pdf — Материал проекта"), true);
    assert.equal(read.includes("чужой.pdf"), false);
    assert.equal(read.includes("Склад принимает паллеты."), false);
  } finally {
    await close(server);
  }
});

test("у веба первой версии нет отдельного входа для исполнителя, который не владелец", async () => {
  const trainer = start(tempDirectory());
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(saved.ok);
  const server = await startWeb(trainer);

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const home = await (await fetch(base)).text();
    const cases = await (await fetch(`${base}/cases`)).text();
    const project = await (await fetch(`${base}/cases/${saved.caseRecord.id}`)).text();
    assert.equal(home.includes("не спрашивает пароль"), true);
    assert.equal(home.includes("Войти"), false);
    assert.equal(cases.includes("Войти"), false);
    assert.equal(project.includes("Войти"), false);
    assert.equal(project.includes('type="password"'), false);
    assert.equal(project.includes('<select name="executorId"'), false);
    assert.equal(project.includes("Отдельного входа для исполнителя, который не владелец, нет."), true);
    assert.equal((await fetch(`${base}/login`)).status, 404);
    assert.equal((await fetch(`${base}/executor`)).status, 404);
    assert.equal((await fetch(`${base}/enter`)).status, 404);
  } finally {
    await close(server);
  }
});
