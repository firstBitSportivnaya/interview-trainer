import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, type ModelPort } from "../src/model.ts";
import { openTrainer, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

const EXECUTOR = "другой-исполнитель";
const OWNER_PORTFOLIO = "ПОРТФОЛИО-ВЛАДЕЛЬЦА";
const EXECUTOR_PORTFOLIO = "ПОРТФОЛИО-ИСПОЛНИТЕЛЯ";

const keyDraft = {
  protocol: "anthropic" as const,
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-profile-"));
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

/** Записанная модель: во вход попадает то, что ядро ей отдало. */
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

function promptOf(calls: ModelCall[], index: number): string {
  return calls[index]?.messages.map((message) => message.text).join("\n") ?? "";
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
  const keyId = trainer.listKeys().at(-1)?.id;
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
  assert.ok(trainer.setPortfolioSent(savedCase.caseRecord.id, true).ok);
  return { keyId, caseId: savedCase.caseRecord.id, dossierId: approved.dossier.id };
}

test("во вход персонажа заказчика входит профиль исполнителя этой сессии", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const prepared = prepare(trainer);
  trainer.saveProfile({ resume: "Резюме владельца", portfolio: OWNER_PORTFOLIO, cases: "Кейс владельца" });
  trainer.saveProfile({
    resume: "Резюме исполнителя",
    portfolio: EXECUTOR_PORTFOLIO,
    cases: "Кейс исполнителя",
    executorId: EXECUTOR,
  });
  assert.deepEqual(trainer.assignExecutor({ executorId: EXECUTOR, caseId: prepared.caseId }), { ok: true });

  const owner = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  const executor = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "разработчик",
    executorId: EXECUTOR,
    keyId: prepared.keyId,
  });
  assert.ok(owner.ok);
  assert.ok(executor.ok);

  await take(trainer.openingQuestion(owner.session.id));
  await take(trainer.openingQuestion(executor.session.id));
  const ownerPrompt = promptOf(calls, 0);
  const executorPrompt = promptOf(calls, 1);

  assert.equal(ownerPrompt.includes(OWNER_PORTFOLIO), true);
  assert.equal(ownerPrompt.includes(EXECUTOR_PORTFOLIO), false);
  assert.equal(executorPrompt.includes(EXECUTOR_PORTFOLIO), true);
  assert.equal(executorPrompt.includes(OWNER_PORTFOLIO), false);
});

test("единственный профиль владельца читает персонаж его сессии", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const prepared = prepare(trainer);
  trainer.saveProfile({ resume: "Резюме владельца", portfolio: OWNER_PORTFOLIO, cases: "Кейс владельца" });

  const owner = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(owner.ok);

  await take(trainer.openingQuestion(owner.session.id));
  const prompt = promptOf(calls, 0);
  assert.equal(prompt.includes(OWNER_PORTFOLIO), true);
  assert.equal(prompt.includes("Резюме владельца"), true);
  assert.equal(prompt.includes("Кейс владельца"), true);
});

test("пустой профиль исполнителя не заменяется профилем владельца", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const prepared = prepare(trainer);
  trainer.saveProfile({ resume: "Резюме владельца", portfolio: OWNER_PORTFOLIO, cases: "Кейс владельца" });
  trainer.saveProfile({ resume: "", portfolio: "", cases: "", executorId: EXECUTOR });
  assert.deepEqual(trainer.assignExecutor({ executorId: EXECUTOR, caseId: prepared.caseId }), { ok: true });

  const executor = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "разработчик",
    executorId: EXECUTOR,
    keyId: prepared.keyId,
  });
  assert.ok(executor.ok);

  await take(trainer.openingQuestion(executor.session.id));
  const prompt = promptOf(calls, 0);
  assert.equal(prompt.includes(OWNER_PORTFOLIO), false);
  assert.equal(prompt.includes("Резюме владельца"), false);
  assert.equal(prompt.includes("Кейс владельца"), false);
});

test("прежняя строка профиля остаётся профилем владельца", () => {
  const directory = tempDirectory();
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE cases (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      title TEXT NOT NULL
    ) STRICT;
    CREATE TABLE owner_profile (
      id TEXT PRIMARY KEY CHECK (id = 'owner'),
      resume TEXT NOT NULL,
      portfolio TEXT NOT NULL,
      cases_text TEXT NOT NULL
    ) STRICT;
    INSERT INTO customers (id, name) VALUES ('c1', 'Север');
    INSERT INTO cases (id, customer_id, title) VALUES ('case-1', 'c1', 'Склад');
    INSERT INTO owner_profile (id, resume, portfolio, cases_text)
      VALUES ('owner', 'Старое резюме', 'Старое портфолио', 'Старый кейс');
  `);
  database.close();

  const trainer = start(undefined, directory);
  assert.deepEqual(trainer.readProfile(), {
    resume: "Старое резюме",
    portfolio: "Старое портфолио",
    cases: "Старый кейс",
  });
  assert.equal(trainer.readCase("case-1")?.title, "Склад");
  trainer.saveProfile({
    resume: "Чужое резюме",
    portfolio: EXECUTOR_PORTFOLIO,
    cases: "Чужой кейс",
    executorId: EXECUTOR,
  });
  assert.deepEqual(trainer.readProfile(), {
    resume: "Старое резюме",
    portfolio: "Старое портфолио",
    cases: "Старый кейс",
  });
  assert.deepEqual(trainer.readProfile(EXECUTOR), {
    resume: "Чужое резюме",
    portfolio: EXECUTOR_PORTFOLIO,
    cases: "Чужой кейс",
  });
});
