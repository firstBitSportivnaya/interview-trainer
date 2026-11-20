import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ModelFailure, type ModelCall, type ModelPort } from "../src/model.ts";
import { openTrainer, type OpenSessionResult, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-"));
  directories.push(directory);
  return directory;
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

test("пустое дело не создаётся", () => {
  const trainer = start();
  assert.deepEqual(trainer.saveCase({ customerName: "  ", title: "Склад" }), {
    ok: false,
    reason: "incomplete",
  });
  assert.deepEqual(trainer.saveCase({ customerName: "Север", title: " " }), {
    ok: false,
    reason: "incomplete",
  });
  assert.equal(trainer.readCase("нет-такого-дела"), undefined);
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
  const again = start(directory).listKeys();
  assert.equal(again.length, 1);
  assert.equal(again[0]?.id, "key-1");
  assert.equal(again[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(again).includes(secret), false);
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

test("дело, досье, сессия, ход подготовки и ключ читаются после перезапуска", () => {
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

test("сессия не открывается по досье другого дела", () => {
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
  assert.deepEqual(calls[0], {
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: keyDraft.secret,
    messages: [{ role: "user", text: "Какой срок поставки?" }],
  });

  await take(trainer.reply(other.session.id, "Где расчёт?"));
  assert.deepEqual(calls[1], {
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
    messages: [{ role: "user", text: "Где расчёт?" }],
  });

  trainer.close();
  const restartedCalls: ModelCall[] = [];
  const restarted = start(directory, remember(restartedCalls));
  assert.deepEqual(await take(restarted.reply(openedSession.session.id, "Какой срок поставки?")), [
    { kind: "speech", text: "Срок " },
    { kind: "speech", text: "— июнь." },
  ]);
  assert.deepEqual(restartedCalls[0], {
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: keyDraft.secret,
    messages: [{ role: "user", text: "Какой срок поставки?" }],
  });
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

test("таймаут и ошибка модели не становятся речью", async () => {
  const calls: string[] = [];
  const trainer = start(tempDirectory(), {
    async *complete(call) {
      const line = call.messages[0]?.text ?? "";
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
