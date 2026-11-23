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
const PALLET = "приёмку паллет ведут по местам хранения";
const DISTANT = "срок поставки согласуют отдельно";
const SERVICE_FILE = "служебный маркер ночной смены";
const CRIB_FILE = "шпаргалка спросить про штраф";
const OTHER = "маркер чужого проекта касса";
const LATE = "новый файл после открытия сессии";
const SERVICE_FRAGMENT = "внутренний лимит смены двенадцать";
const WITHHOLD = "не произносится как факт";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-fragment-"));
  directories.push(directory);
  return directory;
}

/** Близкий фрагмент и запрос хода смотрят в одну сторону. Далёкий текст — в другую. */
function scriptedEmbeddings(): EmbeddingPort {
  return {
    async embed(text, role) {
      if (role === "query") {
        return [1, 0];
      }
      const close =
        text.includes(PALLET) ||
        text.includes(SERVICE_FILE) ||
        text.includes(CRIB_FILE) ||
        text.includes(OTHER) ||
        text.includes(LATE) ||
        text.includes(SERVICE_FRAGMENT);
      return close ? [1, 0] : [0, 1];
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

function prepare(trainer: ReturnType<typeof openTrainer>, title = "Внедрение склада") {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: DOSSIER_FACT,
    serviceLayer: DOSSIER_SERVICE,
    crib: DOSSIER_CRIB,
  });
  assert.ok(approved.ok);
  return { keyId, caseId: saved.caseRecord.id, customerId: saved.caseRecord.customerId, dossierId: approved.dossier.id };
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

function openCustomer(
  trainer: ReturnType<typeof openTrainer>,
  prepared: ReturnType<typeof prepare>,
) {
  return trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "заказчик",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
}

test("фрагмент приёмки паллет может попасть во вход и не произносится как факт", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  const filler = "стеллаж ".repeat(80);
  addFile(trainer, prepared.caseId, "places.txt", "material", `${PALLET}. ${filler}${DISTANT}.`);
  const dossier = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(dossier);
  assert.equal(dossier.material.includes(PALLET), false);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(WITHHOLD), true);
  assert.equal(prompt.includes(DOSSIER_FACT), true);
  assert.equal(prompt.includes(DISTANT), false);
});

test("персонаж заказчика не получает служебный слой и шпаргалку проекта", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);
  addFile(trainer, prepared.caseId, "night.txt", "serviceLayer", SERVICE_FILE);
  addFile(trainer, prepared.caseId, "script.txt", "crib", CRIB_FILE);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про приёмку."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(SERVICE_FILE), false);
  assert.equal(prompt.includes(DOSSIER_SERVICE), false);
  assert.equal(prompt.includes(CRIB_FILE), false);
  assert.equal(prompt.includes(DOSSIER_CRIB), false);
});

test("маркер чужого проекта во вход не попадает", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);
  const other = trainer.addCase({ customerId: prepared.customerId, title: "Касса" });
  assert.ok(other.ok);
  addFile(trainer, other.caseRecord.id, "foreign.txt", "material", OTHER);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(OTHER), false);
});

test("файл после открытия сессии в её поиск не входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  addFile(trainer, prepared.caseId, "late.txt", "material", LATE);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(LATE), false);
  assert.equal(trainer.listSourceFiles(prepared.caseId).some((file) => file.extractedText === LATE), true);
});

test("внутренняя команда получает фрагмент материала и служебного слоя, шпаргалка не входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);
  addFile(trainer, prepared.caseId, "limit.txt", "serviceLayer", SERVICE_FRAGMENT);
  addFile(trainer, prepared.caseId, "script.txt", "crib", CRIB_FILE);

  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "внутренняя команда",
    character: "руководитель проекта",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(SERVICE_FRAGMENT), true);
  assert.equal(prompt.includes(WITHHOLD), true);
  assert.equal(prompt.includes(CRIB_FILE), false);
  assert.equal(prompt.includes(DOSSIER_CRIB), false);
});
