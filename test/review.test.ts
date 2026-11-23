import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { type ModelCall, ModelFailure, type ModelPort } from "../src/model.ts";
import { openTrainer, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

const REVIEW =
  "Прозвучало служебное: маржа подрядчика. Речь разошлась с досье: склад закрыт. Речь разошлась с текстом файла проекта: вес паллеты. Не прозвучал вопрос шпаргалки проекта: Спросить про сроки.";

const keyDraft = {
  protocol: "anthropic" as const,
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

const otherKey = {
  protocol: "openai-compatible" as const,
  baseAddress: "https://api.openai.com/v1",
  modelName: "other-model",
  secret: "sk-other-secret-ABCD",
};

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-review-"));
  directories.push(directory);
  return directory;
}

function start(model?: ModelPort, directory = tempDirectory()) {
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

/** Записанная модель: полный разбор только если во входе есть все источники сессии. */
function recorded(calls: ModelCall[]): ModelPort {
  return {
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      const text = call.messages[0]?.text ?? "";
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
        !text.includes("ПОЗДНЯЯ-ШПАРГАЛКА") &&
        !text.includes("НОВОЕ-ДОСЬЕ") &&
        !text.includes("НЕ-ПИСАТЬ-В-РАЗБОР");
      yield ready ? REVIEW : "разбор неполный";
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

function prepare(trainer: ReturnType<typeof openTrainer>) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  assert.deepEqual(trainer.saveKey(otherKey), { ok: true });
  const keys = trainer.listKeys();
  const keyId = keys[0]?.id;
  const otherId = keys[1]?.id;
  assert.ok(keyId && otherId);
  const savedCase = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["Анна"],
  });
  assert.ok(savedCase.ok);
  assert.ok(
    trainer.addSourceFile({
      caseId: savedCase.caseRecord.id,
      name: "протокол.xlsx",
      layer: "material",
      extractedText: "ФАЙЛ-ВЕС-ПАЛЛЕТЫ",
    }).ok,
  );
  assert.ok(
    trainer.addSourceFile({
      caseId: savedCase.caseRecord.id,
      name: "вопросы.txt",
      layer: "crib",
      extractedText: "ФАЙЛ-ШПАРГАЛКИ",
    }).ok,
  );
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  return { keyId, caseId: savedCase.caseRecord.id, dossierId: approved.dossier.id };
}

test("разбор идёт ключом сессии и не пишет ход подготовки", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const trainer = start(recorded(calls), directory);
  const prepared = prepare(trainer);
  assert.ok(
    trainer.writePreparation({
      caseId: prepared.caseId,
      role: "аналитик",
      executorId: "владелец",
      note: "НЕ-ПИСАТЬ-В-РАЗБОР",
    }).ok,
  );
  const notes = trainer.readPreparation(prepared.caseId, "аналитик", "владелец");
  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  const sessionId = openedSession.session.id;

  await take(trainer.reply(sessionId, "У нас маржа двенадцать."));
  await take(trainer.reply(sessionId, "Склад закрыт."));
  const transcript = trainer.readTranscript(sessionId);
  assert.ok(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "позже.txt",
      layer: "material",
      extractedText: "ПОЗДНИЙ-ФАЙЛ",
    }).ok,
  );
  assert.ok(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "позже-шпаргалка.txt",
      layer: "crib",
      extractedText: "ПОЗДНЯЯ-ШПАРГАЛКА",
    }).ok,
  );
  assert.ok(
    trainer.approveDossier({
      caseId: prepared.caseId,
      material: "НОВОЕ-ДОСЬЕ",
      serviceLayer: "НОВОЕ-ДОСЬЕ",
      crib: "НОВОЕ-ДОСЬЕ",
    }).ok,
  );

  const finished = await trainer.finishSession(sessionId);
  assert.ok(finished.ok);
  assert.equal(finished.session.status, "finished");
  assert.equal(finished.review.text, REVIEW);
  assert.equal("score" in finished, false);
  assert.equal("score" in finished.review, false);
  assert.deepEqual(trainer.readReview(sessionId), { text: REVIEW });
  assert.deepEqual(trainer.readTranscript(sessionId), transcript);
  assert.deepEqual(trainer.readPreparation(prepared.caseId, "аналитик", "владелец"), notes);
  assert.equal(trainer.listOpenSessions().some((session) => session.id === sessionId), false);

  const reviewCall = calls.find((call) => call.messages[0]?.text.includes("Разбери законченную сессию"));
  assert.ok(reviewCall);
  assert.equal(reviewCall.secret, keyDraft.secret);
  assert.equal(reviewCall.modelName, keyDraft.modelName);
  assert.equal(reviewCall.protocol, keyDraft.protocol);
  assert.notEqual(reviewCall.secret, otherKey.secret);
  assert.equal(calls.filter((call) => call.messages[0]?.text.includes("Разбери законченную сессию")).length, 1);

  const callCount = calls.length;
  assert.deepEqual(await take(trainer.reply(sessionId, "Ещё вопрос")), []);
  assert.deepEqual(await take(trainer.openingQuestion(sessionId)), []);
  assert.equal(calls.length, callCount);
  assert.deepEqual(trainer.readTranscript(sessionId), transcript);

  const again = await trainer.finishSession(sessionId);
  assert.deepEqual(again, { ok: false, reason: "finished" });
  assert.equal(calls.length, callCount);
  assert.deepEqual(await trainer.finishSession("нет-такой-сессии"), { ok: false, reason: "missing" });
  assert.equal(trainer.readReview("нет-такой-сессии"), undefined);

  const next = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(next.ok);

  trainer.close();
  const restarted = start(recorded([]), directory);
  assert.equal(restarted.readSession(sessionId)?.status, "finished");
  assert.deepEqual(restarted.readReview(sessionId), { text: REVIEW });
  assert.deepEqual(restarted.readTranscript(sessionId), transcript);
  assert.deepEqual(restarted.readPreparation(prepared.caseId, "аналитик", "владелец"), notes);
});

test("сбой разбора оставляет стенограмму и не пишет ход подготовки", async () => {
  const trainer = start({
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        throw new ModelFailure("model");
      }
      yield "Склад принимает паллеты.";
    },
  });
  const prepared = prepare(trainer);
  assert.ok(
    trainer.writePreparation({
      caseId: prepared.caseId,
      role: "аналитик",
      executorId: "владелец",
      note: "НЕ-ПИСАТЬ-В-РАЗБОР",
    }).ok,
  );
  const notes = trainer.readPreparation(prepared.caseId, "аналитик", "владелец");
  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "У нас маржа двенадцать."));
  const transcript = trainer.readTranscript(openedSession.session.id);

  const failed = await trainer.finishSession(openedSession.session.id);
  assert.deepEqual(failed, { ok: false, reason: "model" });
  assert.equal(trainer.readSession(openedSession.session.id)?.status, "open");
  assert.equal(trainer.readReview(openedSession.session.id), undefined);
  assert.deepEqual(trainer.readTranscript(openedSession.session.id), transcript);
  assert.deepEqual(trainer.readPreparation(prepared.caseId, "аналитик", "владелец"), notes);
  assert.equal(trainer.listOpenSessions().some((session) => session.id === openedSession.session.id), true);
});

test("пустой разбор сессию не заканчивает", async () => {
  const trainer = start({
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        yield "   ";
        return;
      }
      yield "Склад принимает паллеты.";
    },
  });
  const prepared = prepare(trainer);
  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  const failed = await trainer.finishSession(openedSession.session.id);
  assert.deepEqual(failed, { ok: false, reason: "model" });
  assert.equal(trainer.readSession(openedSession.session.id)?.status, "open");
  assert.equal(trainer.readReview(openedSession.session.id), undefined);
});

test("прежняя таблица сессий принимает законченную сессию", async () => {
  const directory = tempDirectory();
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    dossier_id TEXT NOT NULL,
    side TEXT NOT NULL,
    character_name TEXT NOT NULL,
    role TEXT NOT NULL,
    executor_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'open')
  )`);
  database.close();

  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls), directory);
  const prepared = prepare(trainer);
  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "У нас маржа двенадцать."));
  await take(trainer.reply(openedSession.session.id, "Склад закрыт."));
  const finished = await trainer.finishSession(openedSession.session.id);
  assert.ok(finished.ok);
  assert.equal(finished.review.text, REVIEW);
});
