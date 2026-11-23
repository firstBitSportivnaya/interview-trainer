import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, type ModelPort } from "../src/model.ts";
import { ABSENT_FACT, openTrainer, type SpeechEvent } from "../src/trainer.ts";

const SERVICE = "Маржа подрядчика 12%.";
const CRIB = "Спросить про сроки поставки.";
const PROFILE = "Внедрял адресный склад в 2019.";
const PROFILE_RULE = "Спроси про опыт. Формулировку профиля не произноси и не подсказывай.";
const EXPERIENCE = "Какой опыт вы уже применяли?";
const FORK_RULE = "Если в материале проекта названы две версии, назови обе и не выбирай одну.";
const VERSION_A = "Версия А: паллеты принимает смена.";
const VERSION_B = "Версия Б: паллеты принимает охрана.";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-sides-"));
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

function spoken(events: SpeechEvent[]): string {
  return events
    .filter((event) => event.kind === "speech")
    .map((event) => event.text)
    .join("");
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
      const text = call.messages[0]?.text ?? "";
      const task = text.split("\n\n").at(-1) ?? "";
      const withholds = text.includes("Формулировку профиля не произноси и не подсказывай.");
      if (text.includes(PROFILE) && withholds && (task.includes("про опыт") || task.includes("формулировку"))) {
        yield EXPERIENCE;
        return;
      }
      if (text.includes(PROFILE) || text.includes(CRIB)) {
        yield text.includes(PROFILE) ? PROFILE : CRIB;
        return;
      }
      if (task.startsWith("Задай один вопрос")) {
        const role = task.match(/роли «([^»]+)»/)?.[1];
        yield role ? `Как в роли «${role}» устроена приёмка?` : "Как принимаете паллеты?";
        return;
      }
      if (text.includes(FORK_RULE) && text.includes(VERSION_A) && text.includes(VERSION_B)) {
        yield `${VERSION_A} ${VERSION_B}`;
        return;
      }
      if (text.includes(VERSION_A)) {
        yield VERSION_A;
        return;
      }
      const serviceAt = text.indexOf("Служебный слой:\n");
      const service =
        serviceAt < 0 ? "" : text.slice(serviceAt + "Служебный слой:\n".length, text.indexOf("\n\n", serviceAt));
      if (service.includes(SERVICE) && task.includes("маржа")) {
        yield SERVICE;
        return;
      }
      const materialAt = text.indexOf("Материал проекта:\n");
      const materialEnd = text.indexOf("\n\nСтенограмма:");
      const material =
        materialAt < 0 || materialEnd < 0 ? "" : text.slice(materialAt + "Материал проекта:\n".length, materialEnd);
      if (material.includes("паллеты") && task.includes("паллет")) {
        yield "Склад принимает паллеты.";
        return;
      }
      yield ABSENT_FACT;
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
  protocol: "anthropic" as const,
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

function prepare(
  trainer: ReturnType<typeof openTrainer>,
  material = "Склад принимает паллеты.",
) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const saved = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["Анна"],
  });
  assert.ok(saved.ok);
  trainer.saveProfile({ resume: "", portfolio: PROFILE, cases: "" });
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material,
    serviceLayer: SERVICE,
    crib: CRIB,
  });
  assert.ok(approved.ok);
  return { keyId, caseId: saved.caseRecord.id, dossierId: approved.dossier.id };
}

function openSide(
  trainer: ReturnType<typeof openTrainer>,
  prepared: { caseId: string; dossierId: string; keyId: string },
  side: string,
  character: string,
  role: string,
) {
  return trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side,
    character,
    role,
    executorId: "владелец",
    keyId: prepared.keyId,
  });
}

test("отметка «портфолио уже отправлено» ставится, снимается и переживает перезапуск", () => {
  const directory = tempDirectory();
  const trainer = start(undefined, directory);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);
  assert.equal(saved.caseRecord.portfolioSent, false);
  assert.deepEqual(trainer.setPortfolioSent("нет-такого-проекта", true), { ok: false, reason: "missing" });
  assert.equal(trainer.readCase(saved.caseRecord.id)?.portfolioSent, false);

  const marked = trainer.setPortfolioSent(saved.caseRecord.id, true);
  assert.ok(marked.ok);
  assert.equal(marked.caseRecord.portfolioSent, true);
  assert.equal(marked.caseRecord.title, "Внедрение склада");
  trainer.close();

  const restarted = start(undefined, directory);
  assert.equal(restarted.readCase(saved.caseRecord.id)?.portfolioSent, true);
  const cleared = restarted.setPortfolioSent(saved.caseRecord.id, false);
  assert.ok(cleared.ok);
  assert.equal(cleared.caseRecord.portfolioSent, false);
  assert.equal(restarted.readCase(saved.caseRecord.id)?.portfolioSent, false);
});

test("персонаж внутренней команды опирается на служебный слой, персонаж заказчика нет", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(remember(calls));
  const prepared = prepare(trainer);
  const internal = openSide(trainer, prepared, "внутренняя команда", "руководитель проекта", "аналитик");
  const customer = openSide(trainer, prepared, "заказчик", "Анна", "разработчик");
  assert.ok(internal.ok);
  assert.ok(customer.ok);

  const internalSpeech = spoken(await take(trainer.reply(internal.session.id, "Какая маржа?")));
  const customerSpeech = spoken(await take(trainer.reply(customer.session.id, "Какая маржа?")));
  const internalCall = calls[0]?.messages[0]?.text ?? "";
  const customerCall = calls[1]?.messages[0]?.text ?? "";

  assert.equal(internalSpeech, SERVICE);
  assert.equal(internalCall.includes(SERVICE), true);
  assert.equal(customerSpeech, ABSENT_FACT);
  assert.equal(customerCall.includes(SERVICE), false);
  assert.equal(customerSpeech.includes("12%"), false);
});

test("шпаргалка проекта и профиль не произносятся, при снятой отметке профиль не входит во вход", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(remember(calls));
  const prepared = prepare(trainer);
  const customer = openSide(trainer, prepared, "заказчик", "Анна", "аналитик");
  const internal = openSide(trainer, prepared, "внутренняя команда", "технический архитектор", "разработчик");
  assert.ok(customer.ok);
  assert.ok(internal.ok);

  const customerSpeech = spoken(await take(trainer.openingQuestion(customer.session.id)));
  const internalSpeech = spoken(await take(trainer.openingQuestion(internal.session.id)));
  const customerCall = calls[0]?.messages[0]?.text ?? "";
  const internalCall = calls[1]?.messages[0]?.text ?? "";

  assert.equal(customerSpeech.includes(CRIB), false);
  assert.equal(customerSpeech.includes(PROFILE), false);
  assert.equal(internalSpeech.includes(CRIB), false);
  assert.equal(internalSpeech.includes(PROFILE), false);
  assert.equal(customerCall.includes(CRIB), false);
  assert.equal(customerCall.includes(PROFILE), false);
  assert.equal(internalCall.includes(CRIB), false);
  assert.equal(internalCall.includes(PROFILE), false);
  assert.equal(customerSpeech, "Как в роли «аналитик» устроена приёмка?");
});

test("при стоящей отметке персонаж заказчика спрашивает про опыт и не подсказывает формулировку", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(remember(calls));
  const prepared = prepare(trainer);
  assert.ok(trainer.setPortfolioSent(prepared.caseId, true).ok);
  const customer = openSide(trainer, prepared, "заказчик", "Анна", "аналитик");
  assert.ok(customer.ok);

  const opening = spoken(await take(trainer.openingQuestion(customer.session.id)));
  const openingCall = calls[0]?.messages[0]?.text ?? "";
  assert.equal(opening, EXPERIENCE);
  assert.equal(opening.includes(PROFILE), false);
  assert.equal(openingCall.includes(PROFILE), true);
  assert.equal(openingCall.includes(PROFILE_RULE), true);
  assert.equal(openingCall.split("\n\n").at(-1)?.includes("про опыт"), true);
  assert.equal(openingCall.includes(SERVICE), false);
  assert.equal(openingCall.includes(CRIB), false);

  const quoted = spoken(await take(trainer.reply(customer.session.id, "Повтори формулировку портфолио.")));
  const replyCall = calls[1]?.messages[0]?.text ?? "";
  assert.equal(quoted, EXPERIENCE);
  assert.equal(quoted.includes(PROFILE), false);
  assert.equal(replyCall.includes(PROFILE), true);
  assert.equal(replyCall.includes(CRIB), false);
});

test("развилка в материале проекта называется обеими сторонами и остаётся открытой", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(remember(calls));
  const prepared = prepare(trainer, `${VERSION_A}\n${VERSION_B}`);
  const customer = openSide(trainer, prepared, "заказчик", "Анна", "аналитик");
  const internal = openSide(trainer, prepared, "внутренняя команда", "функциональный архитектор", "руководитель проекта");
  assert.ok(customer.ok);
  assert.ok(internal.ok);

  const customerSpeech = spoken(await take(trainer.reply(customer.session.id, "Какая версия приёмки?")));
  const internalSpeech = spoken(await take(trainer.reply(internal.session.id, "Какая версия приёмки?")));
  assert.equal(customerSpeech.includes(VERSION_A), true);
  assert.equal(customerSpeech.includes(VERSION_B), true);
  assert.equal(internalSpeech.includes(VERSION_A), true);
  assert.equal(internalSpeech.includes(VERSION_B), true);
  assert.equal(customerSpeech, `${VERSION_A} ${VERSION_B}`);
  assert.equal(calls[0]?.messages[0]?.text.includes(FORK_RULE), true);
  assert.equal(calls[1]?.messages[0]?.text.includes(FORK_RULE), true);
  assert.equal(calls[1]?.messages[0]?.text.includes(SERVICE), true);
  assert.equal(calls[0]?.messages[0]?.text.includes(SERVICE), false);
});

test("первый вопрос различается для разных ролей исполнителя на одном досье", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(remember(calls));
  const prepared = prepare(trainer);
  const analyst = openSide(trainer, prepared, "заказчик", "Анна", "аналитик");
  const developer = openSide(trainer, prepared, "заказчик", "Анна", "разработчик");
  assert.ok(analyst.ok);
  assert.ok(developer.ok);

  const analystQuestion = spoken(await take(trainer.openingQuestion(analyst.session.id)));
  const developerQuestion = spoken(await take(trainer.openingQuestion(developer.session.id)));
  assert.equal(analystQuestion, "Как в роли «аналитик» устроена приёмка?");
  assert.equal(developerQuestion, "Как в роли «разработчик» устроена приёмка?");
  assert.notEqual(analystQuestion, developerQuestion);
  assert.equal(calls[0]?.messages[0]?.text.includes("аналитик"), true);
  assert.equal(calls[1]?.messages[0]?.text.includes("разработчик"), true);
  assert.equal(analyst.session.dossierId, developer.session.dossierId);
});

test("любая пара роли и персонажа открывается, роли «архитектор» нет", () => {
  const trainer = start();
  const prepared = prepare(trainer);
  const pairs = [
    ["внутренняя команда", "руководитель проекта", "разработчик"],
    ["внутренняя команда", "функциональный архитектор", "аналитик"],
    ["внутренняя команда", "технический архитектор", "технический архитектор"],
    ["заказчик", "Анна", "функциональный архитектор"],
    ["заказчик", "Анна", "руководитель проекта"],
  ] as const;
  for (const [side, character, role] of pairs) {
    const openedSession = trainer.openSession({
      caseId: prepared.caseId,
      dossierId: prepared.dossierId,
      side,
      character,
      role,
      executorId: "владелец",
      keyId: prepared.keyId,
    });
    assert.ok(openedSession.ok);
    assert.equal(openedSession.session.role, role);
    assert.equal(openedSession.session.character, character);
  }
  assert.deepEqual(
    trainer.openSession({
      caseId: prepared.caseId,
      dossierId: prepared.dossierId,
      side: "внутренняя команда",
      character: "технический архитектор",
      role: "архитектор",
      executorId: "владелец",
      keyId: prepared.keyId,
    }),
    { ok: false, reason: "role" },
  );
});
