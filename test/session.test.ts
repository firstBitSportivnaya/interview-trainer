import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, ModelFailure, type ModelPort } from "../src/model.ts";
import { ABSENT_FACT, openTrainer, type SpeechEvent } from "../src/trainer.ts";
import { withoutTime } from "./records.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-session-"));
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

function materialOf(text: string): string {
  const marker = "Материал проекта:\n";
  const start = text.indexOf(marker);
  const end = text.indexOf("\n\nСтенограмма:");
  if (start < 0 || end < 0) {
    return "";
  }
  return text.slice(start + marker.length, end);
}

/** Записанная модель: факт копирует из материала вызова, чужой факт называет отсутствующим. */
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
      const task = text.split("\n\n").at(-1) ?? "";
      if (task.startsWith("Задай один вопрос")) {
        yield "Как ";
        yield "принимаете паллеты?";
        return;
      }
      const material = materialOf(text);
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

function prepare(trainer: ReturnType<typeof openTrainer>) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const savedCase = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["Анна"],
  });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  return { keyId, caseId: savedCase.caseRecord.id, dossierId: approved.dossier.id };
}

test("сессия заказчика открывается проектом, персонажем, ролью и ключом", () => {
  const trainer = start();
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
  assert.equal(openedSession.session.caseId, prepared.caseId);
  assert.equal(openedSession.session.side, "заказчик");
  assert.equal(openedSession.session.character, "Анна");
  assert.equal(openedSession.session.role, "аналитик");
  assert.equal(openedSession.session.keyId, prepared.keyId);
  assert.deepEqual(trainer.readTranscript(openedSession.session.id), []);
  assert.equal(trainer.readTranscript("нет-такой-сессии"), undefined);
});

test("персонаж задаёт один вопрос и делает паузу", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
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

  assert.deepEqual(await take(trainer.openingQuestion(openedSession.session.id)), [
    { kind: "speech", text: "Как " },
    { kind: "speech", text: "принимаете паллеты?" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.secret, keyDraft.secret);
  assert.equal(calls[0]?.messages[0]?.text.includes("Склад принимает паллеты."), true);
  assert.equal(calls[0]?.messages[0]?.text.includes("Маржа подрядчика 12%."), false);
  assert.equal(calls[0]?.messages[0]?.text.includes("Спросить про сроки."), false);
  assert.deepEqual(await take(trainer.openingQuestion(openedSession.session.id)), []);
  assert.equal(calls.length, 1);
  assert.deepEqual(withoutTime(trainer.readTranscript(openedSession.session.id)), [
    { speaker: "персонаж", kind: "вопрос", text: "Как принимаете паллеты?" },
  ]);
});

test("исполнитель спрашивает, не дожидаясь вопроса персонажа", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
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

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какие паллеты принимает склад?")), [
    { kind: "speech", text: "Склад принимает паллеты." },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(withoutTime(trainer.readTranscript(openedSession.session.id)), [
    { speaker: "исполнитель", kind: "реплика", text: "Какие паллеты принимает склад?" },
    { speaker: "персонаж", kind: "ответ", text: "Склад принимает паллеты." },
  ]);

  await take(trainer.openingQuestion(openedSession.session.id));
  assert.equal(calls.length, 2);
  assert.equal(trainer.readTranscript(openedSession.session.id)?.some((line) => line.kind === "вопрос"), true);
});

test("ответ берётся из материала, а факта вне материала персонаж не называет", async () => {
  const calls: ModelCall[] = [];
  const directory = tempDirectory();
  const trainer = start(recorded(calls), directory);
  const prepared = prepare(trainer);
  assert.ok(
    trainer.writePreparation({
      caseId: prepared.caseId,
      role: "аналитик",
      executorId: "владелец",
      note: "Давить на маржу.",
    }).ok,
  );
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

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какие паллеты принимает склад?")), [
    { kind: "speech", text: "Склад принимает паллеты." },
  ]);
  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какая маржа?")), [
    { kind: "speech", text: ABSENT_FACT },
  ]);

  const factCall = calls[0]?.messages[0]?.text ?? "";
  const absentCall = calls[1]?.messages[0]?.text ?? "";
  assert.equal(materialOf(factCall), "Склад принимает паллеты.");
  assert.equal(factCall.includes("Маржа подрядчика 12%."), false);
  assert.equal(factCall.includes("Спросить про сроки."), false);
  assert.equal(factCall.includes("Давить на маржу."), true);
  assert.equal(factCall.includes(ABSENT_FACT), true);
  assert.equal(calls[0]?.secret, keyDraft.secret);
  assert.equal(calls[0]?.modelName, "claude-sonnet");
  assert.equal(absentCall.includes("Давить на маржу."), true);
  assert.equal(absentCall.includes("Маржа подрядчика 12%."), false);
  assert.equal(
    trainer.readTranscript(openedSession.session.id)?.some((line) => line.text === ABSENT_FACT),
    true,
  );
  assert.equal(JSON.stringify(trainer.readTranscript(openedSession.session.id)).includes("12%"), false);

  trainer.close();
  const restarted = start(recorded([]), directory);
  assert.equal(
    restarted.readTranscript(openedSession.session.id)?.some((line) => line.text === ABSENT_FACT),
    true,
  );
  assert.equal(restarted.readSession(openedSession.session.id)?.keyId, prepared.keyId);
});

test("оборванный первый вопрос не закрывает паузу", async () => {
  let calls = 0;
  const trainer = start({
    async *complete() {
      calls += 1;
      if (calls === 1) {
        yield "Как ";
        throw new ModelFailure("timeout");
      }
      yield "Как принимаете паллеты?";
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

  assert.deepEqual(await take(trainer.openingQuestion(openedSession.session.id)), [
    { kind: "speech", text: "Как " },
    { kind: "failure", reason: "timeout", message: "Модель не ответила вовремя." },
  ]);
  assert.equal(
    trainer.readTranscript(openedSession.session.id)?.some((line) => line.kind === "вопрос"),
    false,
  );

  assert.deepEqual(await take(trainer.openingQuestion(openedSession.session.id)), [
    { kind: "speech", text: "Как принимаете паллеты?" },
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(withoutTime(trainer.readTranscript(openedSession.session.id)), [
    { speaker: "персонаж", kind: "вопрос", text: "Как принимаете паллеты?" },
  ]);
});

test("второй запрос первого вопроса ждёт, пока первый не закончится", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const trainer = start({
    async *complete() {
      calls += 1;
      await gate;
      yield "Как принимаете паллеты?";
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

  const first = trainer.openingQuestion(openedSession.session.id)[Symbol.asyncIterator]();
  const started = first.next();
  const second = trainer.openingQuestion(openedSession.session.id)[Symbol.asyncIterator]();
  assert.equal((await second.next()).done, true);
  assert.equal(calls, 1);
  release();
  assert.deepEqual((await started).value, { kind: "speech", text: "Как принимаете паллеты?" });
  assert.equal((await first.next()).done, true);
  assert.equal(
    trainer.readTranscript(openedSession.session.id)?.filter((line) => line.kind === "вопрос").length,
    1,
  );
});

test("персонаж внутренней команды читает служебный слой и пишет стенограмму", async () => {
  const calls: ModelCall[] = [];
  const trainer = start({
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
      if (task.startsWith("Задай один вопрос")) {
        yield "Как в роли «аналитик» устроена приёмка?";
        return;
      }
      yield text.includes("Маржа подрядчика 12%.") ? "Маржа подрядчика 12%." : "В материале проекта этого нет.";
    },
  });
  const prepared = prepare(trainer);
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

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какая маржа?")), [
    { kind: "speech", text: "Маржа подрядчика 12%." },
  ]);
  const replyCall = calls[0]?.messages[0]?.text ?? "";
  assert.equal(replyCall.includes("Маржа подрядчика 12%."), true);
  assert.equal(replyCall.includes("Спросить про сроки."), false);
  assert.equal(replyCall === "Какая маржа?", false);
  assert.deepEqual(withoutTime(trainer.readTranscript(openedSession.session.id)), [
    { speaker: "исполнитель", kind: "реплика", text: "Какая маржа?" },
    { speaker: "персонаж", kind: "ответ", text: "Маржа подрядчика 12%." },
  ]);

  assert.deepEqual(await take(trainer.openingQuestion(openedSession.session.id)), [
    { kind: "speech", text: "Как в роли «аналитик» устроена приёмка?" },
  ]);
  assert.equal(calls[1]?.messages[0]?.text.includes("роли «аналитик»"), true);
  assert.equal(calls.length, 2);
});

test("правка досье не меняет реплики открытой сессии", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const prepared = prepare(trainer);
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

  const revised = trainer.approveDossier({
    caseId: prepared.caseId,
    material: "Склад принимает короба.",
    serviceLayer: "Маржа подрядчика 20%.",
    crib: "Спросить про возвраты.",
  });
  assert.ok(revised.ok);
  assert.notEqual(revised.dossier.id, prepared.dossierId);

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какие паллеты принимает склад?")), [
    { kind: "speech", text: "Склад принимает паллеты." },
  ]);
  const prompt = calls[0]?.messages[0]?.text ?? "";
  assert.equal(materialOf(prompt), "Склад принимает паллеты.");
  assert.equal(prompt.includes("Маржа подрядчика 12%."), true);
  assert.equal(prompt.includes("короба"), false);
  assert.equal(prompt.includes("Маржа подрядчика 20%."), false);
  assert.equal(JSON.stringify(trainer.readTranscript(openedSession.session.id)).includes("короба"), false);
  assert.equal(JSON.stringify(trainer.readTranscript(openedSession.session.id)).includes("20%"), false);
  assert.equal(trainer.readSession(openedSession.session.id)?.dossierId, prepared.dossierId);
});

test("новое утверждение досье читает следующая сессия", async () => {
  const calls: ModelCall[] = [];
  const trainer = start({
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      yield materialOf(call.messages[0]?.text ?? "");
    },
  });
  const prepared = prepare(trainer);
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

  const revised = trainer.approveDossier({
    caseId: prepared.caseId,
    material: "Склад принимает короба.",
    serviceLayer: "Маржа подрядчика 20%.",
    crib: "Спросить про возвраты.",
  });
  assert.ok(revised.ok);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.id, revised.dossier.id);
  assert.deepEqual(
    trainer.openSession({
      caseId: prepared.caseId,
      dossierId: revised.dossier.id,
      side: "внутренняя команда",
      character: "руководитель проекта",
      role: "аналитик",
      executorId: "владелец",
      keyId: prepared.keyId,
    }),
    { ok: false, reason: "open" },
  );

  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Что принимает склад?")), [
    { kind: "speech", text: "Склад принимает паллеты." },
  ]);

  const next = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: revised.dossier.id,
    side: "внутренняя команда",
    character: "руководитель проекта",
    role: "разработчик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(next.ok);
  assert.notEqual(next.session.id, openedSession.session.id);

  assert.deepEqual(await take(trainer.reply(next.session.id, "Что принимает склад?")), [
    { kind: "speech", text: "Склад принимает короба." },
  ]);
  assert.deepEqual(await take(trainer.reply(openedSession.session.id, "Какие паллеты принимает склад?")), [
    { kind: "speech", text: "Склад принимает паллеты." },
  ]);

  const nextSessionPrompt = calls[1]?.messages[0]?.text ?? "";
  const openedSessionLaterPrompt = calls[2]?.messages[0]?.text ?? "";
  assert.equal(materialOf(openedSessionLaterPrompt), "Склад принимает паллеты.");
  assert.equal(openedSessionLaterPrompt.includes("Маржа подрядчика 12%."), true);
  assert.equal(openedSessionLaterPrompt.includes("короба"), false);
  assert.equal(openedSessionLaterPrompt.includes("Маржа подрядчика 20%."), false);
  assert.equal(materialOf(nextSessionPrompt), "Склад принимает короба.");
  assert.equal(nextSessionPrompt.includes("Маржа подрядчика 20%."), true);
  assert.equal(nextSessionPrompt.includes("Склад принимает паллеты."), false);
  assert.equal(nextSessionPrompt.includes("Маржа подрядчика 12%."), false);
  assert.equal(trainer.readSession(openedSession.session.id)?.dossierId, prepared.dossierId);
  assert.equal(trainer.readSession(next.session.id)?.dossierId, revised.dossier.id);
});

test("смена стороны или персонажа при открытой тройке вторую сессию не создаёт", () => {
  const trainer = start();
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const savedCase = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["Анна", "Борис"],
  });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const openedSession = trainer.openSession({
    caseId: savedCase.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(openedSession.ok);

  assert.deepEqual(
    trainer.openSession({
      caseId: savedCase.caseRecord.id,
      dossierId: approved.dossier.id,
      side: "внутренняя команда",
      character: "Анна",
      role: "аналитик",
      executorId: "владелец",
      keyId,
    }),
    { ok: false, reason: "open" },
  );
  assert.deepEqual(
    trainer.openSession({
      caseId: savedCase.caseRecord.id,
      dossierId: approved.dossier.id,
      side: "заказчик",
      character: "Борис",
      role: "аналитик",
      executorId: "владелец",
      keyId,
    }),
    { ok: false, reason: "open" },
  );

  assert.deepEqual(trainer.listOpenSessions(), [openedSession.session]);
  assert.equal(trainer.readSession(openedSession.session.id)?.side, "заказчик");
  assert.equal(trainer.readSession(openedSession.session.id)?.character, "Анна");
});

test("две открытые тройки одного проекта не смешивают стенограммы", async () => {
  const calls: ModelCall[] = [];
  const trainer = start({
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      const task = call.messages[0]?.text.split("\n\n").at(-1) ?? "";
      yield `ответ: ${task}`;
    },
  });
  const prepared = prepare(trainer);
  const analyst = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  const developer = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "разработчик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(analyst.ok);
  assert.ok(developer.ok);
  assert.notEqual(analyst.session.id, developer.session.id);

  assert.deepEqual(await take(trainer.reply(analyst.session.id, "Вопрос аналитика")), [
    { kind: "speech", text: "ответ: Вопрос аналитика" },
  ]);
  assert.deepEqual(await take(trainer.reply(developer.session.id, "Вопрос разработчика")), [
    { kind: "speech", text: "ответ: Вопрос разработчика" },
  ]);

  assert.deepEqual(withoutTime(trainer.readTranscript(analyst.session.id)), [
    { speaker: "исполнитель", kind: "реплика", text: "Вопрос аналитика" },
    { speaker: "персонаж", kind: "ответ", text: "ответ: Вопрос аналитика" },
  ]);
  assert.deepEqual(withoutTime(trainer.readTranscript(developer.session.id)), [
    { speaker: "исполнитель", kind: "реплика", text: "Вопрос разработчика" },
    { speaker: "персонаж", kind: "ответ", text: "ответ: Вопрос разработчика" },
  ]);
  const developerPrompt = calls[1]?.messages[0]?.text ?? "";
  assert.equal(developerPrompt.includes("Вопрос аналитика"), false);
  assert.equal(developerPrompt.includes("ответ: Вопрос аналитика"), false);
});
