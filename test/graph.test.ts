import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, type ModelPort } from "../src/model.ts";
import { openTrainer, type EmbeddingPort, type SpeechEvent } from "../src/trainer.ts";

const DOSSIER_FACT = "Склад работает круглосуточно.";
const DOSSIER_SERVICE = "Маржа известна только внутренней команде.";
const DOSSIER_CRIB = "Не называть имя подрядчика.";
const NO_LIMIT = "Ограничения по весу нет.";
const TABLE = "Тип паллеты\tМаксимальный вес\nEUR\t500";
const EDGE = "Тип паллеты — Максимальный вес";
const WEIGHT_NUMBER = "500";
const EDGE_RULE = "Число из таблицы не называй.";
const PROSE = "Тип паллеты связан с максимальным весом 500 кг.";
const PDF_PROSE = "В протоколе тип паллеты связан с максимальным весом 500 кг.";
const SERVICE_EDGE = "Служебный лимит";
const CRIB_EDGE = "Шпаргалка проекта";
const ASK_PALLET = "Задай вопрос про паллету.";
const SIGNED_TABLE = "Тип паллеты\t-500\nFIN\t-600";
const NO_HEIGHT = "Ограничения по высоте нет.";
const HEIGHT_TABLE = "Тип паллеты\tМаксимальная высота\nEUR\t3";
const HEIGHT_EDGE = "Тип паллеты — Максимальная высота";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-graph-"));
  directories.push(directory);
  return directory;
}

/** Ось единичного вектора длины 384. Близкая связь и запрос смотрят в одну сторону. */
function axis(index: 0 | 1): number[] {
  const vector = Array.from({ length: 384 }, () => 0);
  vector[index] = 1;
  return vector;
}

/** Запрос про паллету и связь таблицы смотрят в одну сторону. Чужой текст — в другую. */
function scriptedEmbeddings(): EmbeddingPort {
  return {
    async embed(text, role) {
      if (role === "query") {
        return text.includes("паллет") ? axis(0) : axis(1);
      }
      const close =
        text.includes("Тип паллеты") ||
        text.includes("Максимальный вес") ||
        text.includes(PROSE) ||
        text.includes(PDF_PROSE) ||
        text.includes(SERVICE_EDGE) ||
        text.includes(CRIB_EDGE);
      return close ? axis(0) : axis(1);
    },
  };
}

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
      yield "Как принимаете паллеты?";
    },
  };
}

function start(calls: ModelCall[]) {
  const trainer = openTrainer(tempDirectory(), recorded(calls), scriptedEmbeddings());
  opened.push(trainer);
  return trainer;
}

async function take(events: AsyncIterable<SpeechEvent>): Promise<void> {
  for await (const event of events) {
    if (event.kind === "failure") {
      assert.fail(event.message);
    }
  }
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

function prepare(trainer: ReturnType<typeof openTrainer>, material = DOSSIER_FACT) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material,
    serviceLayer: DOSSIER_SERVICE,
    crib: DOSSIER_CRIB,
  });
  assert.ok(approved.ok);
  return { keyId, caseId: saved.caseRecord.id, dossierId: approved.dossier.id };
}

function addFile(
  trainer: ReturnType<typeof openTrainer>,
  caseId: string,
  name: string,
  layer: string,
  extractedText: string,
): void {
  assert.ok(trainer.addSourceFile({ caseId, name, layer, extractedText }).ok);
}

test("вопрос про паллету может спросить про вес и не называет число из таблицы", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "паллеты.xlsx", "material", TABLE);
  addFile(trainer, prepared.caseId, "смена.xlsx", "serviceLayer", `${SERVICE_EDGE}\tСмена\nночь\t12`);
  addFile(trainer, prepared.caseId, "script.xlsx", "crib", `${CRIB_EDGE}\tШтраф\nспросить\tда`);
  const dossier = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(dossier);
  assert.equal(dossier.material.includes("вес"), false);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, ASK_PALLET));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(EDGE), true);
  assert.equal(prompt.includes(EDGE_RULE), true);
  assert.equal(prompt.includes(WEIGHT_NUMBER), false);
  assert.equal(prompt.includes(SERVICE_EDGE), false);
  assert.equal(prompt.includes(CRIB_EDGE), false);
  assert.equal(prompt.includes(DOSSIER_SERVICE), false);
  assert.equal(prompt.includes(DOSSIER_CRIB), false);
});

test("связь таблицы про вес не отдаётся, если досье говорит, что ограничения нет", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, NO_LIMIT);
  addFile(trainer, prepared.caseId, "паллеты.xlsx", "material", TABLE);
  const dossier = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(dossier);
  assert.equal(dossier.material.includes(NO_LIMIT), true);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, ASK_PALLET));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(EDGE), false);
  assert.equal(prompt.includes(EDGE_RULE), false);
  assert.equal(prompt.includes(WEIGHT_NUMBER), false);
  assert.equal(prompt.includes(NO_LIMIT), true);
});

test("абзац и pdf не становятся ребром графа", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "абзац.txt", "material", PROSE);
  addFile(trainer, prepared.caseId, "протокол.pdf", "material", PDF_PROSE);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, ASK_PALLET));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PROSE), true);
  assert.equal(prompt.includes(PDF_PROSE), true);
  assert.equal(prompt.includes(EDGE), false);
  assert.equal(prompt.includes(EDGE_RULE), false);
});

test("отрицательное число первой строки не называется", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "знаки.xlsx", "material", SIGNED_TABLE);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, ASK_PALLET));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes("-500"), false);
  assert.equal(prompt.includes("-600"), false);
  assert.equal(prompt.includes("Тип паллеты"), true);
});

test("связь про высоту не отдаётся, если досье отрицает ограничение по высоте", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, NO_HEIGHT);
  addFile(trainer, prepared.caseId, "высота.xlsx", "material", HEIGHT_TABLE);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, ASK_PALLET));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(HEIGHT_EDGE), false);
  assert.equal(prompt.includes("Максимальная высота"), false);
  assert.equal(prompt.includes(NO_HEIGHT), true);
});
