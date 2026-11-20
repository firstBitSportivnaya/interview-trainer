import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ModelFailure, type ModelCall, type ModelPort } from "../src/model.ts";
import { customerVoices, DRAFT_LIMIT, openTrainer, type OpenSessionResult, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-"));
  directories.push(directory);
  return directory;
}

/** Свой вызов DPAPI, отдельно от ядра: ожидаемый секрет берётся из средств ОС, не из реализации. */
function openDpapi(blob: string): string {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$protected = [Convert]::FromBase64String($env:DPAPI_BLOB)
$clear = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($clear))
`;
  const result = spawnSync(
    `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, DPAPI_BLOB: blob } },
  );
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
}

/** Ищет секрет в любом файле каталога: и в хранилище, и во временном файле, который SQLite ещё не стёр. */
function storeHasSecret(directory: string, secret: string): boolean {
  const needle = Buffer.from(secret, "utf8");
  return readdirSync(directory).some((name) => {
    const path = join(directory, name);
    return statSync(path).isFile() && readFileSync(path).includes(needle);
  });
}

function start(directory = tempDirectory(), model?: ModelPort) {
  const trainer = openTrainer(directory, model);
  opened.push(trainer);
  return trainer;
}

async function take(events: AsyncIterable<SpeechEvent>): Promise<SpeechEvent[]> {
  const list: SpeechEvent[] = [];
  for await (const event of events) {
    list.push(event);
  }
  return list;
}

function remember(calls: ModelCall[]): ModelPort {
  return {
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      yield "Срок ";
      yield "— июнь.";
    },
  };
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const keyDraft = {
  protocol: "anthropic",
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

function prepare(trainer: ReturnType<typeof openTrainer>) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);

  const savedCase = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
  });
  assert.ok(savedCase.ok);

  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);

  return {
    keyId,
    caseId: savedCase.caseRecord.id,
    customerId: savedCase.caseRecord.customerId,
    dossierId: approved.dossier.id,
  };
}

function openAnalyst(
  trainer: ReturnType<typeof openTrainer>,
  prepared: ReturnType<typeof prepare>,
  executorId = "владелец",
): OpenSessionResult {
  return trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId,
    keyId: prepared.keyId,
  });
}

test("владелец сохраняет ключ, и список не показывает секрет целиком", () => {
  const trainer = start();
  const secret = "sk-ant-api03-secret-WXYZ";

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret,
  });

  const keys = trainer.listKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.protocol, "anthropic");
  assert.equal(keys[0]?.baseAddress, "https://api.anthropic.com");
  assert.equal(keys[0]?.modelName, "claude-sonnet");
  assert.equal(keys[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(keys).includes(secret), false);
});

test("второй ключ сохраняется отдельно от первого", () => {
  const trainer = start();

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });
  trainer.saveKey({
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
  });

  const keys = trainer.listKeys();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0]?.id, keys[1]?.id);
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
        modelName: "claude-sonnet",
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

test("после перезапуска список ключей на месте, секрет не раскрыт", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });
  trainer.saveKey({
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
  });

  trainer.close();
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
        modelName: "claude-sonnet",
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

test("ключ принимается только когда заполнены все четыре поля", () => {
  const trainer = start();
  const complete = {
    protocol: "anthropic" as const,
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  };

  for (const field of ["protocol", "baseAddress", "modelName", "secret"] as const) {
    const saved = trainer.saveKey({ ...complete, [field]: "  " });
    assert.deepEqual(saved, { ok: false, reason: "incomplete" });
  }

  assert.deepEqual(trainer.listKeys(), []);
});

test("протокол ключа — Anthropic или совместимый с OpenAI", () => {
  const trainer = start();
  const saved = trainer.saveKey({
    protocol: "grpc",
    baseAddress: "https://example.test",
    modelName: "other",
    secret: "sk-other-secret-1234",
  });

  assert.deepEqual(saved, { ok: false, reason: "protocol" });
  assert.deepEqual(trainer.listKeys(), []);
});

test("короткий секрет в списке не раскрыт целиком", () => {
  const trainer = start();
  const secret = "ab12";

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret,
  });

  const keys = trainer.listKeys();
  assert.equal(keys[0]?.secretPreview, "••••");
  assert.equal(JSON.stringify(keys).includes(secret), false);
});

test("после сохранения ключа в хранилище нет открытого секрета", async () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-WXYZ";
  const calls: ModelCall[] = [];
  const trainer = start(directory, remember(calls));

  assert.deepEqual(
    trainer.saveKey({
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret,
    }),
    { ok: true },
  );
  trainer.close();

  assert.equal(storeHasSecret(directory, secret), false);
  assert.equal(existsSync(join(directory, "keys.json")), false);

  const again = start(directory, remember(calls));
  const keys = again.listKeys();
  const keyId = keys[0]?.id;
  assert.ok(keyId);
  assert.equal(keys[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(keys).includes(secret), false);

  const savedCase = again.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(savedCase.ok);
  const approved = again.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const openedSession = again.openSession({
    caseId: savedCase.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);

  await take(again.reply(openedSession.session.id, "Какой срок поставки?"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.secret, secret);
  again.close();
  assert.equal(storeHasSecret(directory, secret), false);
});

test("повреждённый список ключей не затирается", () => {
  const directory = tempDirectory();
  const file = join(directory, "keys.json");
  writeFileSync(file, "{");

  assert.throws(() => openTrainer(directory));
  assert.equal(readFileSync(file, "utf8"), "{");
});

test("файл хранилища доступен только владельцу", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  trainer.saveKey(keyDraft);

  assert.equal(trainer.listKeys().length, 1);
  if (process.platform === "win32") {
    return;
  }
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, "store.sqlite")).mode & 0o777, 0o600);
});

test("пустой проект не создаётся", () => {
  const trainer = start();
  assert.deepEqual(trainer.saveCase({ customerName: "  ", title: "Склад" }), {
    ok: false,
    reason: "incomplete",
  });
  assert.deepEqual(trainer.saveCase({ customerName: "Север", title: " " }), {
    ok: false,
    reason: "incomplete",
  });
  assert.equal(trainer.readCase("нет-такого-проекта"), undefined);
});

test("создание заказчика создаёт первый проект", () => {
  const trainer = start();
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);
  assert.equal(saved.caseRecord.customerName, "Север");
  assert.equal(saved.caseRecord.title, "Внедрение склада");
  assert.equal(saved.caseRecord.portfolioSent, false);
  assert.deepEqual(trainer.listCustomers(), [{ id: saved.caseRecord.customerId, name: "Север" }]);
  assert.deepEqual(trainer.listCases().map((item) => item.id), [saved.caseRecord.id]);
  assert.deepEqual(trainer.readCase(saved.caseRecord.id), saved.caseRecord);
});

test("второй проект принадлежит тому же заказчику и не создаёт вторую компанию", () => {
  const trainer = start();
  const first = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(first.ok);
  assert.deepEqual(trainer.addCase({ customerId: " ", title: "Касса" }), { ok: false, reason: "incomplete" });
  assert.deepEqual(trainer.addCase({ customerId: "нет-такого-заказчика", title: "Касса" }), {
    ok: false,
    reason: "missing",
  });

  const second = trainer.addCase({ customerId: first.caseRecord.customerId, title: "Касса" });
  assert.ok(second.ok);
  assert.equal(second.caseRecord.customerId, first.caseRecord.customerId);
  assert.equal(second.caseRecord.customerName, "Север");
  assert.notEqual(second.caseRecord.id, first.caseRecord.id);
  assert.deepEqual(trainer.listCustomers(), [{ id: first.caseRecord.customerId, name: "Север" }]);
  assert.deepEqual(
    trainer.listCases().map((item) => item.title),
    ["Внедрение склада", "Касса"],
  );
});

test("пустой список персонажей даёт голос заказчик, названные хранятся на проекте", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const saved = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["  ", ""],
  });
  assert.ok(saved.ok);
  assert.deepEqual(saved.caseRecord.characters, []);
  assert.deepEqual(customerVoices(saved.caseRecord.characters), ["заказчик"]);

  const named = trainer.addCase({
    customerId: saved.caseRecord.customerId,
    title: "Касса",
    characters: [" Анна ", "", "Борис"],
  });
  assert.ok(named.ok);
  assert.deepEqual(named.caseRecord.characters, ["Анна", "Борис"]);
  assert.deepEqual(customerVoices(named.caseRecord.characters), ["Анна", "Борис"]);

  trainer.close();
  const again = start(directory);
  const empty = again.readCase(saved.caseRecord.id);
  assert.ok(empty);
  assert.deepEqual(empty.characters, []);
  assert.deepEqual(customerVoices(empty.characters), ["заказчик"]);
  assert.deepEqual(again.readCase(named.caseRecord.id)?.characters, ["Анна", "Борис"]);
});

test("профиль один на владельца, отметка портфолио у нового проекта снята", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  assert.deepEqual(trainer.readProfile(), { resume: "", portfolio: "", cases: "" });
  trainer.saveProfile({ resume: "Резюме", portfolio: "Портфолио", cases: "Кейс склада" });
  trainer.saveProfile({ resume: "  Резюме 2  ", portfolio: "Портфолио 2", cases: "Кейс кассы" });

  const first = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(first.ok);
  const second = trainer.addCase({ customerId: first.caseRecord.customerId, title: "Касса" });
  assert.ok(second.ok);
  assert.equal(first.caseRecord.portfolioSent, false);
  assert.equal(second.caseRecord.portfolioSent, false);
  assert.deepEqual(trainer.readProfile(), { resume: "Резюме 2", portfolio: "Портфолио 2", cases: "Кейс кассы" });

  trainer.close();
  const again = start(directory);
  assert.deepEqual(again.readProfile(), { resume: "Резюме 2", portfolio: "Портфолио 2", cases: "Кейс кассы" });
  assert.equal(again.readCase(first.caseRecord.id)?.portfolioSent, false);
  assert.equal(again.readCase(second.caseRecord.id)?.portfolioSent, false);
  assert.deepEqual(again.listCustomers(), [{ id: first.caseRecord.customerId, name: "Север" }]);
});

test("проект прежнего хранилища читается без отметки портфолио и без персонажей", () => {
  const directory = tempDirectory();
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE cases (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      title TEXT NOT NULL
    ) STRICT;
    INSERT INTO customers (id, name) VALUES ('c1', 'Север');
    INSERT INTO cases (id, customer_id, title) VALUES ('case-1', 'c1', 'Склад');
  `);
  database.close();

  const trainer = start(directory);
  assert.deepEqual(trainer.readCase("case-1"), {
    id: "case-1",
    customerId: "c1",
    customerName: "Север",
    title: "Склад",
    characters: [],
    portfolioSent: false,
  });
  assert.deepEqual(customerVoices([]), ["заказчик"]);
});

test("черновик собирается из вставленных текстов выбранным ключом", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(tempDirectory(), {
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      const raw = JSON.stringify({
        material: "Паллеты принимают.",
        serviceLayer: "Маржа 12%.",
        crib: "Спросить срок.",
      });
      yield raw.slice(0, 12);
      yield raw.slice(12);
    },
  });
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  assert.deepEqual(
    trainer.saveKey({
      protocol: "openai-compatible",
      baseAddress: "https://api.deepseek.com",
      modelName: "deepseek-chat",
      secret: "sk-deepseek-secret-9876",
    }),
    { ok: true },
  );
  const selectedId = trainer.listKeys()[1]?.id;
  assert.ok(selectedId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);

  const drafted = await trainer.draftDossier({
    caseId: saved.caseRecord.id,
    keyId: selectedId,
    material: "ПАЛЛЕТЫ-СЫРЬЁ",
    serviceLayer: "МАРЖА-СЫРЬЁ",
    crib: "СРОКИ-СЫРЬЁ",
  });
  assert.deepEqual(drafted, {
    ok: true,
    draft: { material: "Паллеты принимают.", serviceLayer: "Маржа 12%.", crib: "Спросить срок." },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.protocol, "openai-compatible");
  assert.equal(calls[0]?.baseAddress, "https://api.deepseek.com");
  assert.equal(calls[0]?.modelName, "deepseek-chat");
  assert.equal(calls[0]?.secret, "sk-deepseek-secret-9876");
  assert.equal(calls[0]?.messages[0]?.text.includes("ПАЛЛЕТЫ-СЫРЬЁ"), true);
  assert.equal(calls[0]?.messages[0]?.text.includes("МАРЖА-СЫРЬЁ"), true);
  assert.equal(calls[0]?.messages[0]?.text.includes("СРОКИ-СЫРЬЁ"), true);
  assert.equal(calls[0]?.secret === keyDraft.secret, false);
  assert.equal(trainer.readApprovedDossier(saved.caseRecord.id), undefined);
});

test("черновик с блоком кода внутри слоя читается и в ограде, и без неё", async () => {
  const layers = {
    material: "Пример: ```sql SELECT 1; ```",
    serviceLayer: "Слой €",
    crib: "Шпаргалка",
  };
  const json = JSON.stringify(layers);
  const trainer = start(tempDirectory(), {
    async *complete(call) {
      const line = call.messages[0]?.text ?? "";
      yield line.includes("ограда") ? `\`\`\`json\n${json}\n\`\`\`` : json;
    },
  });
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);

  const plain = await trainer.draftDossier({
    caseId: saved.caseRecord.id,
    keyId,
    material: "сырьё",
    serviceLayer: "",
    crib: "",
  });
  assert.deepEqual(plain, { ok: true, draft: layers });

  const fenced = await trainer.draftDossier({
    caseId: saved.caseRecord.id,
    keyId,
    material: "ограда",
    serviceLayer: "",
    crib: "",
  });
  assert.deepEqual(fenced, { ok: true, draft: layers });
  assert.equal(trainer.readApprovedDossier(saved.caseRecord.id), undefined);
});

test("черновик длиннее предела не становится досье", async () => {
  const trainer = start(tempDirectory(), {
    async *complete() {
      yield "Я".repeat(DRAFT_LIMIT + 1);
    },
  });
  const prepared = prepare(trainer);
  const drafted = await trainer.draftDossier({
    caseId: prepared.caseId,
    keyId: prepared.keyId,
    material: "текст",
    serviceLayer: "",
    crib: "",
  });
  assert.deepEqual(drafted, { ok: false, reason: "model" });
  assert.equal(JSON.stringify(drafted).includes("Я"), false);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.material, "Склад принимает паллеты.");
});

test("сбой черновика не создаёт досье и не становится его текстом", async () => {
  const trainer = start(tempDirectory(), {
    async *complete(call) {
      const line = call.messages[0]?.text ?? "";
      if (line.includes("таймаут")) {
        throw new ModelFailure("timeout");
      }
      if (line.includes("поставщик")) {
        throw new Error("секрет поставщика не для досье");
      }
      yield "это не досье";
    },
  });
  const prepared = prepare(trainer);
  const layers = { material: "таймаут", serviceLayer: "", crib: "" };

  assert.deepEqual(
    await trainer.draftDossier({ caseId: prepared.caseId, keyId: prepared.keyId, ...layers }),
    { ok: false, reason: "timeout" },
  );
  assert.deepEqual(
    await trainer.draftDossier({
      caseId: prepared.caseId,
      keyId: prepared.keyId,
      material: "поставщик",
      serviceLayer: "",
      crib: "",
    }),
    { ok: false, reason: "model" },
  );
  const rejected = await trainer.draftDossier({
    caseId: prepared.caseId,
    keyId: prepared.keyId,
    material: "просто текст",
    serviceLayer: "",
    crib: "",
  });
  assert.deepEqual(rejected, { ok: false, reason: "model" });
  assert.equal(JSON.stringify(rejected).includes("это не досье"), false);
  assert.equal(JSON.stringify(rejected).includes("секрет поставщика"), false);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.material, "Склад принимает паллеты.");
});

test("в диалог попадает только досье после правки и утверждения", async () => {
  const trainer = start(tempDirectory(), {
    async *complete() {
      yield JSON.stringify({
        material: "Паллеты принимают.",
        serviceLayer: "Маржа 12%.",
        crib: "Спросить срок.",
      });
    },
  });
  const prepared = prepare(trainer);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.material, "Склад принимает паллеты.");

  const drafted = await trainer.draftDossier({
    caseId: prepared.caseId,
    keyId: prepared.keyId,
    material: "ПАЛЛЕТЫ-СЫРЬЁ",
    serviceLayer: "МАРЖА-СЫРЬЁ",
    crib: "СРОКИ-СЫРЬЁ",
  });
  assert.ok(drafted.ok);
  assert.equal(
    trainer.openSession({
      caseId: prepared.caseId,
      dossierId: "черновик-без-утверждения",
      side: "заказчик",
      character: "заказчик",
      role: "аналитик",
      executorId: "владелец",
      keyId: prepared.keyId,
    }).ok,
    false,
  );

  const approved = trainer.approveDossier({
    caseId: prepared.caseId,
    material: "Паллеты принимают поштучно.",
    serviceLayer: drafted.draft.serviceLayer,
    crib: drafted.draft.crib,
  });
  assert.ok(approved.ok);
  assert.deepEqual(trainer.readApprovedDossier(prepared.caseId), {
    id: approved.dossier.id,
    caseId: prepared.caseId,
    material: "Паллеты принимают поштучно.",
    serviceLayer: "Маржа 12%.",
    crib: "Спросить срок.",
  });
  assert.equal(trainer.readDossier(prepared.dossierId)?.material, "Склад принимает паллеты.");
  assert.equal(JSON.stringify(trainer.readApprovedDossier(prepared.caseId)).includes("ПАЛЛЕТЫ-СЫРЬЁ"), false);

  const opened = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "заказчик",
    role: "разработчик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(opened.ok);
  assert.equal(opened.session.dossierId, approved.dossier.id);
  assert.equal(trainer.readDossier(opened.session.dossierId)?.material, "Паллеты принимают поштучно.");
});

test("ключи из keys.json переносятся в хранилище и читаются после перезапуска", () => {
  const directory = tempDirectory();
  const secret = "sk-ant-api03-secret-WXYZ";
  writeFileSync(
    join(directory, "keys.json"),
    JSON.stringify([
      {
        id: "key-1",
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret,
      },
    ]),
  );

  const trainer = start(directory);
  const keys = trainer.listKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.id, "key-1");
  assert.equal(keys[0]?.protocol, "anthropic");
  assert.equal(keys[0]?.baseAddress, "https://api.anthropic.com");
  assert.equal(keys[0]?.modelName, "claude-sonnet");
  assert.equal(keys[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(keys).includes(secret), false);
  assert.equal(existsSync(join(directory, "keys.json")), false);

  trainer.close();
  assert.equal(storeHasSecret(directory, secret), false);
  const again = start(directory).listKeys();
  assert.equal(again.length, 1);
  assert.equal(again[0]?.id, "key-1");
  assert.equal(again[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(again).includes(secret), false);
});

test("открытый секрет прошлого хранилища сворачивается при открытии", () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-PAST";
  start(directory).close();

  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database
    .prepare("INSERT INTO keys (id, protocol, base_address, model_name, secret) VALUES (?, ?, ?, ?, ?)")
    .run("key-past", "anthropic", "https://api.anthropic.com", "claude-sonnet", secret);
  database.close();

  const trainer = start(directory);
  assert.equal(trainer.listKeys()[0]?.secretPreview, "••••PAST");
  trainer.close();
  assert.equal(storeHasSecret(directory, secret), false);
});

test("незавершённая очистка хранилища повторяется при открытии", () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-LEFT";
  start(directory).close();

  const database = new DatabaseSync(join(directory, "store.sqlite"));
  const insert = database.prepare(
    "INSERT INTO keys (id, protocol, base_address, model_name, secret) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("key-left", "anthropic", "https://api.anthropic.com", "claude-sonnet", "sealed:dpapi:already-sealed");
  insert.run("key-gone", "anthropic", "https://api.anthropic.com", "claude-sonnet", secret);
  database.prepare("DELETE FROM keys WHERE id = ?").run("key-gone");
  database.prepare("INSERT INTO store_flags (name, value) VALUES ('plaintext-vacuum', 'pending')").run();
  database.close();
  assert.equal(storeHasSecret(directory, secret), true);

  const trainer = start(directory);
  assert.equal(trainer.listKeys()[0]?.secretPreview, "••••");
  trainer.close();
  assert.equal(storeHasSecret(directory, secret), false);

  const again = new DatabaseSync(join(directory, "store.sqlite"));
  const flag = again.prepare("SELECT value FROM store_flags WHERE name = 'plaintext-vacuum'").get();
  again.close();
  assert.equal(flag, undefined);
});

test("текст, зашифрованный другой учётной записью, секретом не становится", async () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-WXYZ";
  const calls: ModelCall[] = [];
  const trainer = start(directory, remember(calls));
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
  trainer.close();

  const database = new DatabaseSync(join(directory, "store.sqlite"));
  const row = database.prepare("SELECT secret FROM keys WHERE id = ?").get(keyId) as { secret: string };
  const stored = row.secret;
  const at = stored.length - 5;
  const flipped = `${stored.slice(0, at)}${stored[at] === "A" ? "B" : "A"}${stored.slice(at + 1)}`;
  database.prepare("UPDATE keys SET secret = ? WHERE id = ?").run(flipped, keyId);
  database.close();

  const again = start(directory, remember(calls));
  const keys = again.listKeys();
  assert.equal(keys[0]?.id, keyId);
  assert.equal(keys[0]?.secretPreview, "••••");
  assert.equal(JSON.stringify(keys).includes(secret), false);
  assert.equal(JSON.stringify(keys).includes(flipped), false);

  const savedCase = again.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(savedCase.ok);
  const approved = again.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const openedSession = again.openSession({
    caseId: savedCase.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);

  const events = await take(again.reply(openedSession.session.id, "Какой срок поставки?"));
  assert.deepEqual(events, [{ kind: "failure", reason: "secret", message: "Секрет ключа не читается." }]);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes(flipped), false);
  again.close();
  assert.equal(storeHasSecret(directory, secret), false);
});

test("на Windows секрет читается через DPAPI той же учётной записи", { skip: process.platform !== "win32" }, () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-WXYZ";
  const trainer = start(directory);
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
  trainer.close();

  assert.equal(storeHasSecret(directory, secret), false);
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  const row = database.prepare("SELECT secret FROM keys WHERE id = ?").get(keyId) as { secret: string };
  database.close();
  const magic = "AQAAANCMnd8BFdERjHoAw";
  const at = row.secret.indexOf(magic);
  assert.ok(at >= 0);
  const blob = row.secret.slice(at).match(/^[A-Za-z0-9+/=]+/)?.[0];
  assert.ok(blob);
  assert.equal(openDpapi(blob), secret);
});

test("на macOS секрет читается через keychain той же учётной записи", { skip: process.platform !== "darwin" }, () => {
  const directory = tempDirectory();
  const secret = "sk-test-not-a-live-key-WXYZ";
  const trainer = start(directory);
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
  trainer.close();

  assert.equal(storeHasSecret(directory, secret), false);
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  const row = database.prepare("SELECT secret FROM keys WHERE id = ?").get(keyId) as { secret: string };
  database.close();
  const prefix = "sealed:keychain:";
  assert.equal(row.secret.startsWith(prefix), true);
  const account = row.secret.slice(prefix.length);
  assert.notEqual(account, keyId);
  const result = spawnSync("security", ["find-generic-password", "-s", "interview-trainer", "-a", account, "-w"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), secret);
});

test("повторный перенос того же ключа не заводит вторую запись", () => {
  const directory = tempDirectory();
  const file = join(directory, "keys.json");
  const raw = JSON.stringify([
    {
      id: "key-1",
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-WXYZ",
    },
  ]);
  writeFileSync(file, raw);
  start(directory).close();

  writeFileSync(file, raw);
  const keys = start(directory).listKeys();
  assert.deepEqual(
    keys.map((key) => key.id),
    ["key-1"],
  );
  assert.equal(existsSync(file), false);
});

test("ключ с тем же id и другим секретом не затирает список", () => {
  const directory = tempDirectory();
  const file = join(directory, "keys.json");
  const raw = JSON.stringify([
    {
      id: "key-1",
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-AAAA",
    },
    {
      id: "key-1",
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude-sonnet",
      secret: "sk-ant-api03-secret-BBBB",
    },
  ]);
  writeFileSync(file, raw);

  assert.throws(() => openTrainer(directory));
  assert.equal(readFileSync(file, "utf8"), raw);

  writeFileSync(
    file,
    JSON.stringify([
      {
        id: "key-2",
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secret: "sk-deepseek-secret-CCCC",
      },
    ]),
  );
  assert.deepEqual(
    start(directory).listKeys().map((key) => key.id),
    ["key-2"],
  );
});

test("новый keys.json, появившийся после снимка, тоже переносится", () => {
  const directory = tempDirectory();
  const legacy = join(directory, "keys.json");
  writeFileSync(
    legacy,
    JSON.stringify([
      {
        id: "key-old",
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret: "sk-ant-api03-secret-WXYZ",
      },
    ]),
  );
  renameSync(legacy, join(directory, "keys.json.migrating"));
  writeFileSync(
    legacy,
    JSON.stringify([
      {
        id: "key-new",
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secret: "sk-deepseek-secret-9876",
      },
    ]),
  );

  const keys = start(directory).listKeys();
  assert.deepEqual(
    keys.map((key) => key.id),
    ["key-old", "key-new"],
  );
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(join(directory, "keys.json.migrating")), false);
});

test("сессия открывается ключом с тем id, который вернул список", () => {
  const directory = tempDirectory();
  writeFileSync(
    join(directory, "keys.json"),
    JSON.stringify([
      {
        id: " key-1 ",
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secret: "sk-ant-api03-secret-WXYZ",
      },
    ]),
  );
  const trainer = start(directory);
  const keyId = trainer.listKeys()[0]?.id;
  assert.equal(keyId, " key-1 ");

  const savedCase = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);

  const opened = trainer.openSession({
    caseId: savedCase.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: keyId ?? "",
  });
  assert.ok(opened.ok);
  assert.equal(opened.session.keyId, " key-1 ");
  assert.deepEqual(
    trainer.openSession({
      caseId: savedCase.caseRecord.id,
      dossierId: approved.dossier.id,
      side: "заказчик",
      character: "заказчик",
      role: "разработчик",
      executorId: "владелец",
      keyId: "key-1",
    }),
    { ok: false, reason: "missing" },
  );
  assert.deepEqual(
    trainer.openSession({
      caseId: savedCase.caseRecord.id,
      dossierId: approved.dossier.id,
      side: "заказчик",
      character: "заказчик",
      role: "разработчик",
      executorId: "владелец",
      keyId: "   ",
    }),
    { ok: false, reason: "incomplete" },
  );
});

test("проект, досье, сессия, ход подготовки и ключ читаются после перезапуска", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);
  assert.deepEqual(
    trainer.writePreparation({
      caseId: prepared.caseId,
      role: "аналитик",
      executorId: "владелец",
      note: "Не назвал срок поставки.",
    }),
    {
      ok: true,
      preparation: {
        caseId: prepared.caseId,
        role: "аналитик",
        executorId: "владелец",
        notes: ["Не назвал срок поставки."],
      },
    },
  );
  assert.ok(
    trainer.writePreparation({
      caseId: prepared.caseId,
      role: "аналитик",
      executorId: "владелец",
      note: "Путает материал и служебный слой.",
    }).ok,
  );

  trainer.close();
  const restarted = start(directory);
  assert.deepEqual(restarted.readCase(prepared.caseId), {
    id: prepared.caseId,
    customerId: prepared.customerId,
    customerName: "Север",
    title: "Внедрение склада",
    characters: [],
    portfolioSent: false,
  });
  assert.deepEqual(restarted.readDossier(prepared.dossierId), {
    id: prepared.dossierId,
    caseId: prepared.caseId,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.deepEqual(restarted.readSession(openedSession.session.id), {
    id: openedSession.session.id,
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
    status: "open",
  });
  assert.deepEqual(restarted.readPreparation(prepared.caseId, "аналитик", "владелец"), {
    caseId: prepared.caseId,
    role: "аналитик",
    executorId: "владелец",
    notes: ["Не назвал срок поставки.", "Путает материал и служебный слой."],
  });
  const keys = restarted.listKeys();
  assert.deepEqual(
    keys.map((key) => ({
      id: key.id,
      protocol: key.protocol,
      baseAddress: key.baseAddress,
      modelName: key.modelName,
      secretPreview: key.secretPreview,
    })),
    [
      {
        id: prepared.keyId,
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secretPreview: "••••WXYZ",
      },
    ],
  );
  assert.equal(JSON.stringify(keys).includes(keyDraft.secret), false);
});

test("сессия не открывается по досье другого проекта", () => {
  const trainer = start();
  const prepared = prepare(trainer);
  const other = trainer.saveCase({ customerName: "Юг", title: "Касса" });
  assert.ok(other.ok);

  assert.deepEqual(
    trainer.openSession({
      caseId: other.caseRecord.id,
      dossierId: prepared.dossierId,
      side: "заказчик",
      character: "заказчик",
      role: "аналитик",
      executorId: "владелец",
      keyId: prepared.keyId,
    }),
    { ok: false, reason: "missing" },
  );
  assert.deepEqual(trainer.listOpenSessions(), []);
});

test("вторая открытая сессия той же тройки не создаётся", () => {
  const directory = tempDirectory();
  const trainer = start(directory);
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);

  assert.deepEqual(openAnalyst(trainer, prepared), { ok: false, reason: "open" });

  trainer.close();
  const sessions = start(directory).listOpenSessions();
  assert.deepEqual(
    sessions.map((session) => session.id),
    [openedSession.session.id],
  );
});

test("сессия другой тройки создаётся", () => {
  const trainer = start();
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);

  const otherExecutor = openAnalyst(trainer, prepared, "другой-исполнитель");
  assert.ok(otherExecutor.ok);

  const otherRole = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "разработчик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(otherRole.ok);

  const otherCase = trainer.saveCase({ customerName: "Юг", title: "Касса" });
  assert.ok(otherCase.ok);
  const otherDossier = trainer.approveDossier({
    caseId: otherCase.caseRecord.id,
    material: "Касса бьёт чек.",
    serviceLayer: "Смена закрывается вручную.",
    crib: "Спросить про возвраты.",
  });
  assert.ok(otherDossier.ok);
  const otherCaseSession = trainer.openSession({
    caseId: otherCase.caseRecord.id,
    dossierId: otherDossier.dossier.id,
    side: "внутренняя команда",
    character: "руководитель проекта",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(otherCaseSession.ok);

  assert.deepEqual(
    trainer.listOpenSessions().map((session) => ({
      id: session.id,
      caseId: session.caseId,
      role: session.role,
      executorId: session.executorId,
      side: session.side,
      character: session.character,
    })),
    [
      {
        id: openedSession.session.id,
        caseId: prepared.caseId,
        role: "аналитик",
        executorId: "владелец",
        side: "заказчик",
        character: "заказчик",
      },
      {
        id: otherExecutor.session.id,
        caseId: prepared.caseId,
        role: "аналитик",
        executorId: "другой-исполнитель",
        side: "заказчик",
        character: "заказчик",
      },
      {
        id: otherRole.session.id,
        caseId: prepared.caseId,
        role: "разработчик",
        executorId: "владелец",
        side: "заказчик",
        character: "заказчик",
      },
      {
        id: otherCaseSession.session.id,
        caseId: otherCase.caseRecord.id,
        role: "аналитик",
        executorId: "владелец",
        side: "внутренняя команда",
        character: "руководитель проекта",
      },
    ],
  );
});

test("сессия зовёт модель тем ключом, которым её открыли", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const trainer = start(directory, remember(calls));
  const prepared = prepare(trainer);
  assert.deepEqual(
    trainer.saveKey({
      protocol: "openai-compatible",
      baseAddress: "https://api.deepseek.com",
      modelName: "deepseek-chat",
      secret: "sk-deepseek-secret-9876",
    }),
    { ok: true },
  );
  const openaiId = trainer.listKeys()[1]?.id;
  assert.ok(openaiId);

  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);
  const other = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "разработчик",
    executorId: "владелец",
    keyId: openaiId,
  });
  assert.ok(other.ok);

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какой срок поставки?")), [
    { kind: "speech", text: "Срок " },
    { kind: "speech", text: "— июнь." },
  ]);
  assert.equal(calls[0]?.protocol, "anthropic");
  assert.equal(calls[0]?.baseAddress, "https://api.anthropic.com");
  assert.equal(calls[0]?.modelName, "claude-sonnet");
  assert.equal(calls[0]?.secret, keyDraft.secret);
  assert.equal(calls[0]?.messages[0]?.text.endsWith("Какой срок поставки?"), true);
  assert.equal(calls[0]?.messages[0]?.text.includes("Срок — июнь."), false);

  await take(trainer.reply(other.session.id, "Где расчёт?"));
  assert.equal(calls[1]?.protocol, "openai-compatible");
  assert.equal(calls[1]?.baseAddress, "https://api.deepseek.com");
  assert.equal(calls[1]?.modelName, "deepseek-chat");
  assert.equal(calls[1]?.secret, "sk-deepseek-secret-9876");
  assert.equal(calls[1]?.messages[0]?.text.endsWith("Где расчёт?"), true);

  trainer.close();
  const restartedCalls: ModelCall[] = [];
  const restarted = start(directory, remember(restartedCalls));
  assert.deepEqual(await take(restarted.reply(openedSession.session.id, "Какой срок поставки?")), [
    { kind: "speech", text: "Срок " },
    { kind: "speech", text: "— июнь." },
  ]);
  assert.equal(restartedCalls[0]?.protocol, "anthropic");
  assert.equal(restartedCalls[0]?.baseAddress, "https://api.anthropic.com");
  assert.equal(restartedCalls[0]?.modelName, "claude-sonnet");
  assert.equal(restartedCalls[0]?.secret, keyDraft.secret);
  assert.equal(restartedCalls[0]?.messages[0]?.text.endsWith("Какой срок поставки?"), true);
  assert.equal(restartedCalls[0]?.messages[0]?.text.includes("Срок — июнь."), true);
});

test("речь модели приходит потоком, не дожидаясь конца ответа", async () => {
  let finished = false;
  const trainer = start(tempDirectory(), {
    async *complete() {
      yield "Срок ";
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
      yield "— июнь.";
    },
  });
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);

  const iterator = trainer.reply(openedSession.session.id, "Какой срок поставки?")[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(finished, false);
  assert.deepEqual(first.value, { kind: "speech", text: "Срок " });
  const second = await iterator.next();
  assert.equal(finished, true);
  assert.deepEqual(second.value, { kind: "speech", text: "— июнь." });
  await iterator.return?.();
});

test("обрыв чтения отменяет вызов модели", async () => {
  let signal: AbortSignal | undefined;
  const trainer = start(tempDirectory(), {
    async *complete(_call, incoming) {
      signal = incoming;
      yield "Срок ";
      await new Promise<void>((resolve) => {
        if (incoming.aborted) {
          resolve();
          return;
        }
        incoming.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);

  const iterator = trainer.reply(openedSession.session.id, "Какой срок поставки?")[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { kind: "speech", text: "Срок " });
  await iterator.return?.();
  assert.equal(signal?.aborted, true);
});

test("таймаут и ошибка модели не становятся речью", async () => {
  const calls: string[] = [];
  const trainer = start(tempDirectory(), {
    async *complete(call) {
      const line = (call.messages[0]?.text ?? "").split("\n\n").at(-1) ?? "";
      calls.push(line);
      if (line === "таймаут") {
        throw new ModelFailure("timeout");
      }
      if (line === "сбой") {
        yield "Срок ";
        throw new Error("внутренний сбой поставщика");
      }
      yield "речь";
    },
  });
  const prepared = prepare(trainer);
  const openedSession = openAnalyst(trainer, prepared);
  assert.ok(openedSession.ok);

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "таймаут")), [
    { kind: "failure", reason: "timeout", message: "Модель не ответила вовремя." },
  ]);
  const failed = await take(trainer.reply(openedSession.session.id, "сбой"));
  assert.deepEqual(failed, [
    { kind: "speech", text: "Срок " },
    { kind: "failure", reason: "model", message: "Модель вернула ошибку." },
  ]);
  assert.equal(JSON.stringify(failed).includes("внутренний сбой поставщика"), false);
  assert.deepEqual(await take(trainer.reply("нет-такой-сессии", "вопрос")), [
    { kind: "failure", reason: "missing", message: "Сессия не найдена." },
  ]);
  assert.deepEqual(calls, ["таймаут", "сбой"]);
});
