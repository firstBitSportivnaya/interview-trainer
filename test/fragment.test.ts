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
const NO_LIMIT = "Ограничения по весу нет.";
const LIMIT_EXISTS = "Ограничение по весу есть.";
const WEIGHT_500 = "Максимальный вес 500 кг.";
const WEIGHT_800 = "Максимальный вес 800 кг.";
const WEIGHT_1200 = "Максимальный вес 1200 кг.";
const NEITHER_NUMBER = "Ни одно из этих чисел не произноси как факт.";
const LIMIT_WITH_CAVEAT = "Ограничение по весу есть, исключений нет.";
const NOT_WEIGHT = "Максимальный весь 500 кг.";
const TWO_LIMITS = "Ограничение по высоте есть, ограничение по весу есть.";
const WEIGHT_15 = "Максимальный вес 1,5 кг.";
const WEIGHT_18 = "Максимальный вес 1,8 кг.";
const WEIGHT_15_DOT = "Максимальный вес 1.5 кг.";
const WEIGHT_500_T = "Максимальный вес 500 т.";
const WEIGHT_1500 = "Максимальный вес 1500 кг.";

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
        text.includes(SERVICE_FRAGMENT) ||
        text.includes(NO_LIMIT) ||
        text.includes(WEIGHT_500) ||
        text.includes(WEIGHT_800) ||
        text.includes(WEIGHT_1200) ||
        text.includes(LIMIT_WITH_CAVEAT) ||
        text.includes(NOT_WEIGHT) ||
        text.includes(WEIGHT_15) ||
        text.includes(WEIGHT_18) ||
        text.includes(WEIGHT_15_DOT) ||
        text.includes(WEIGHT_500_T);
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

function prepare(
  trainer: ReturnType<typeof openTrainer>,
  title = "Внедрение склада",
  material = DOSSIER_FACT,
) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({ customerName: "Север", title });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material,
    serviceLayer: DOSSIER_SERVICE,
    crib: DOSSIER_CRIB,
  });
  assert.ok(approved.ok);
  return { keyId, caseId: saved.caseRecord.id, customerId: saved.caseRecord.customerId, dossierId: approved.dossier.id };
}

function materialSection(prompt: string): string {
  const start = prompt.indexOf("Материал проекта:\n");
  const end = prompt.indexOf("\nСтенограмма:");
  if (start < 0 || end <= start) {
    return "";
  }
  return prompt.slice(start, end);
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

test("фрагмент, который отрицает ограничение по весу, не входит, если досье говорит, что оно есть", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", LIMIT_EXISTS);
  addFile(trainer, prepared.caseId, "weight.txt", "material", `${NO_LIMIT}\n\n${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(NO_LIMIT), false);
  assert.equal(prompt.includes(LIMIT_EXISTS), true);
  assert.equal(prompt.includes(PALLET), true);
});

test("фрагмент с другим максимальным весом, чем досье того же слоя, во вход не входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", WEIGHT_800);
  addFile(trainer, prepared.caseId, "weight.txt", "material", `${WEIGHT_500}\n\n${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes("500"), false);
  assert.equal(prompt.includes("800"), true);
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("два разных максимальных веса остаются во входе, и ни одно не произносится как факт", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "light.txt", "material", WEIGHT_500);
  addFile(trainer, prepared.caseId, "heavy.txt", "material", WEIGHT_1200);
  const dossier = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(dossier);
  assert.equal(dossier.material.includes("вес"), false);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про максимальный вес."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  const material = materialSection(prompt);
  assert.equal(prompt.includes("500"), true);
  assert.equal(prompt.includes("1200"), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), true);
  assert.equal(material.includes("500"), false);
  assert.equal(material.includes("1200"), false);
  assert.equal(prompt.includes("777"), false);
});

test("один вес при молчании досье может попасть во вход и не произносится как факт", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "light.txt", "material", WEIGHT_500);
  addFile(trainer, prepared.caseId, "term.txt", "material", DISTANT);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про максимальный вес."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  const material = materialSection(prompt);
  assert.equal(prompt.includes(WEIGHT_500), true);
  assert.equal(prompt.includes(WITHHOLD), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
  assert.equal(prompt.includes(DISTANT), false);
  assert.equal(material.includes("500"), false);
});

test("оговорка «исключений нет» не отменяет названное ограничение", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", LIMIT_EXISTS);
  addFile(trainer, prepared.caseId, "caveat.txt", "material", LIMIT_WITH_CAVEAT);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(LIMIT_WITH_CAVEAT), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("слово «весь» не спорит с максимальным весом", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "all.txt", "material", NOT_WEIGHT);
  addFile(trainer, prepared.caseId, "heavy.txt", "material", WEIGHT_1200);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про максимальный вес."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(NOT_WEIGHT), true);
  assert.equal(prompt.includes(WEIGHT_1200), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("второе ограничение в том же предложении досье тоже не пускает отрицание", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", TWO_LIMITS);
  addFile(trainer, prepared.caseId, "weight.txt", "material", `${NO_LIMIT}\n\n${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(NO_LIMIT), false);
  assert.equal(prompt.includes(TWO_LIMITS), true);
  assert.equal(prompt.includes(PALLET), true);
});

test("дробные максимумы 1,5 и 1,8 остаются оба и не произносятся как факт", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "light.txt", "material", WEIGHT_15);
  addFile(trainer, prepared.caseId, "heavy.txt", "material", WEIGHT_18);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про максимальный вес."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_15), true);
  assert.equal(prompt.includes(WEIGHT_18), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), true);
});

test("запятая и точка в одном числе не спорят", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", WEIGHT_15);
  addFile(trainer, prepared.caseId, "dot.txt", "material", WEIGHT_15_DOT);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_15_DOT), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("500 кг и 500 т спорят, тонны во вход не входят", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer, "Внедрение склада", WEIGHT_500);
  addFile(trainer, prepared.caseId, "tonnes.txt", "material", `${WEIGHT_500_T}\n\n${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_500_T), false);
  assert.equal(prompt.includes(WEIGHT_500), true);
  assert.equal(prompt.includes(PALLET), true);
});

test("далёкий другой вес входит вместе с близким и не произносится как факт", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "near.txt", "material", WEIGHT_500);
  addFile(trainer, prepared.caseId, "far.txt", "material", WEIGHT_1500);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, "Задай вопрос про максимальный вес."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_500), true);
  assert.equal(prompt.includes(WEIGHT_1500), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), true);
});
