import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const FIRST_HALF = "Первая половина набора.";
const SECOND_HALF = "Вторая половина набора.";
const NEIGHBOUR = "Полный соседний файл.";
const PREVIOUS_TEXT = "Прежний текст файла про приёмку.";
const NEXT_TEXT = "Новый текст файла про приёмку.";
const OTHER_MODEL = "чужой вектор другой модели";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-fragment-"));
  directories.push(directory);
  return directory;
}

/** Ось единичного вектора длины 384. Близкий фрагмент и запрос смотрят в одну сторону. */
function axis(index: 0 | 1): number[] {
  const vector = Array.from({ length: 384 }, () => 0);
  vector[index] = 1;
  return vector;
}

/** Близкий фрагмент и запрос хода смотрят в одну сторону. Далёкий текст — в другую. */
function scriptedEmbeddings(): EmbeddingPort {
  return {
    async embed(text, role) {
      if (role === "query") {
        return axis(0);
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

test("оборванный набор векторов в поиск не входит, полный набор другого файла входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      if (text.includes(SECOND_HALF)) {
        return [];
      }
      return scriptedEmbeddings().embed(text, role);
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(
    trainer,
    prepared.caseId,
    "broken.txt",
    "material",
    `${PALLET}. ${FIRST_HALF}\n\n${SECOND_HALF}`,
  );
  addFile(trainer, prepared.caseId, "whole.txt", "material", `${NEIGHBOUR} ${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(FIRST_HALF), false);
  assert.equal(prompt.includes(SECOND_HALF), false);
  assert.equal(prompt.includes(NEIGHBOUR), true);
});

test("исключение на середине набора не кладёт частичный файл в поиск", async () => {
  const calls: ModelCall[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      if (text.includes(SECOND_HALF)) {
        throw new Error("обрыв расчёта");
      }
      return scriptedEmbeddings().embed(text, role);
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(
    trainer,
    prepared.caseId,
    "broken.txt",
    "material",
    `${PALLET}. ${FIRST_HALF}\n\n${SECOND_HALF}`,
  );
  addFile(trainer, prepared.caseId, "whole.txt", "material", `${NEIGHBOUR} ${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(FIRST_HALF), false);
  assert.equal(prompt.includes(SECOND_HALF), false);
  assert.equal(prompt.includes(NEIGHBOUR), true);
});

test("следующая сессия видит фрагменты только нового текста файла", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(calls);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", `${PREVIOUS_TEXT} ${PALLET}.`);
  const first = openCustomer(trainer, prepared);
  assert.ok(first.ok);
  await take(trainer.openingQuestion(first.session.id));
  assert.equal(calls[0]?.messages[0]?.text.includes(PREVIOUS_TEXT), true);

  const finished = await trainer.finishSession(first.session.id);
  assert.ok(finished.ok);
  addFile(trainer, prepared.caseId, "places.txt", "material", `${NEXT_TEXT} ${PALLET}.\n\nХвост нового текста. ${PALLET}.`);
  const second = openCustomer(trainer, prepared);
  assert.ok(second.ok);
  await take(trainer.openingQuestion(second.session.id));

  const prompt = calls.at(-1)?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(NEXT_TEXT), true);
  assert.equal(prompt.includes("Хвост нового текста."), true);
  assert.equal(prompt.includes(PREVIOUS_TEXT), false);
});

test("открытая сессия держит прежний текст, пока новый набор не полон", async () => {
  const calls: ModelCall[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      if (text.includes(NEXT_TEXT)) {
        return [];
      }
      return scriptedEmbeddings().embed(text, role);
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", `${PREVIOUS_TEXT} ${PALLET}.`);
  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));
  assert.equal(calls[0]?.messages[0]?.text.includes(PREVIOUS_TEXT), true);

  addFile(trainer, prepared.caseId, "places.txt", "material", `${NEXT_TEXT} ${PALLET}.\n\n${SECOND_HALF}`);
  calls.length = 0;
  await take(trainer.reply(openedSession.session.id, "Что с приёмкой?"));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PREVIOUS_TEXT), true);
  assert.equal(prompt.includes(NEXT_TEXT), false);
  assert.equal(prompt.includes(SECOND_HALF), false);
});

test("пустой текст не становится готовым, непустой файл в поиск входит", async () => {
  const calls: ModelCall[] = [];
  const embedded: string[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      embedded.push(text);
      return scriptedEmbeddings().embed(text, role);
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  assert.equal(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "empty.txt",
      layer: "material",
      extractedText: "   ",
    }).ok,
    false,
  );
  addFile(trainer, prepared.caseId, "places.txt", "material", `${PALLET}.`);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(embedded.some((text) => text.trim() === ""), false);
});

test("нулевой вектор не делает файл готовым, полный набор соседа входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      if (role === "query" || text.includes(WEIGHT_500)) {
        return axis(0);
      }
      return Array.from({ length: 384 }, () => 0);
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "zero.txt", "material", WEIGHT_1500);
  addFile(trainer, prepared.caseId, "ready.txt", "material", WEIGHT_500);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_1500), false);
  assert.equal(prompt.includes(WEIGHT_500), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("вектор не той длины не делает файл готовым, полный набор соседа входит", async () => {
  const calls: ModelCall[] = [];
  const trainer = openTrainer(tempDirectory(), recorded(calls), {
    async embed(text, role) {
      if (role === "query" || text.includes(WEIGHT_500)) {
        return axis(0);
      }
      return [1, 0];
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "short.txt", "material", WEIGHT_1500);
  addFile(trainer, prepared.caseId, "ready.txt", "material", WEIGHT_500);

  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(WEIGHT_1500), false);
  assert.equal(prompt.includes(WEIGHT_500), true);
  assert.equal(prompt.includes(NEITHER_NUMBER), false);
});

test("векторы другой модели в сравнение текущего индекса не входят", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const other = openTrainer(directory, recorded(calls), {
    modelName: "другая-модель",
    async embed(text, role) {
      if (role === "query" || text.includes(OTHER_MODEL)) {
        return axis(0);
      }
      return axis(1);
    },
  });
  opened.push(other);
  const prepared = prepare(other);
  addFile(other, prepared.caseId, "foreign-model.txt", "material", OTHER_MODEL);
  addFile(other, prepared.caseId, "places.txt", "material", PALLET);
  const openedSession = openCustomer(other, prepared);
  assert.ok(openedSession.ok);
  await take(other.openingQuestion(openedSession.session.id));
  other.close();

  const current = openTrainer(directory, recorded(calls), {
    modelName: "multilingual-e5-small",
    async embed(text, role) {
      if (role === "query" || text.includes(PALLET)) {
        return axis(0);
      }
      return axis(1);
    },
  });
  opened.push(current);
  calls.length = 0;
  await take(current.reply(openedSession.session.id, "Задай вопрос про приёмку."));

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(OTHER_MODEL), false);
});

test("сохранённый вектор фрагмента нормирован по L2", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const trainer = openTrainer(directory, recorded(calls), {
    async embed(text, role) {
      if (role === "query") {
        return axis(0);
      }
      const vector = axis(0);
      vector[0] = 3;
      vector[1] = 4;
      return vector;
    },
  });
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);
  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));
  trainer.close();

  const database = new DatabaseSync(join(directory, "store.sqlite"));
  try {
    const rows = database.prepare("SELECT vector FROM session_fragments").all() as { vector: string }[];
    assert.equal(rows.length, 1);
    const vector = JSON.parse(rows[0]?.vector ?? "[]") as number[];
    assert.equal(vector.length, 384);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-9);
    assert.ok(Math.abs((vector[0] ?? 0) - 0.6) < 1e-9);
    assert.ok(Math.abs((vector[1] ?? 0) - 0.8) < 1e-9);
  } finally {
    database.close();
  }
});

test("прежний индекс без имени модели остаётся и в текущий поиск не входит", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const created = new DatabaseSync(join(directory, "store.sqlite"));
  created.exec(`
    CREATE TABLE session_fragments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      body TEXT NOT NULL,
      vector TEXT NOT NULL
    ) STRICT
  `);
  created.close();

  const trainer = openTrainer(directory, recorded(calls), scriptedEmbeddings());
  opened.push(trainer);
  const prepared = prepare(trainer);
  addFile(trainer, prepared.caseId, "places.txt", "material", PALLET);
  const openedSession = openCustomer(trainer, prepared);
  assert.ok(openedSession.ok);
  await take(trainer.openingQuestion(openedSession.session.id));
  trainer.close();

  const planted = new DatabaseSync(join(directory, "store.sqlite"));
  planted
    .prepare(
      "INSERT INTO session_fragments (id, session_id, layer, body, vector, model_name) VALUES ('old', ?, 'material', ?, ?, '')",
    )
    .run(openedSession.session.id, OTHER_MODEL, JSON.stringify(axis(0)));
  planted.close();

  const current = openTrainer(directory, recorded(calls), scriptedEmbeddings());
  opened.push(current);
  calls.length = 0;
  await take(current.reply(openedSession.session.id, "Задай вопрос про приёмку."));
  current.close();

  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(prompt.includes(PALLET), true);
  assert.equal(prompt.includes(OTHER_MODEL), false);

  const check = new DatabaseSync(join(directory, "store.sqlite"));
  try {
    const old = check.prepare("SELECT body, model_name FROM session_fragments WHERE id = 'old'").get() as
      | { body: string; model_name: string }
      | undefined;
    assert.equal(old?.body, OTHER_MODEL);
    assert.equal(old?.model_name, "");
  } finally {
    check.close();
  }
});
