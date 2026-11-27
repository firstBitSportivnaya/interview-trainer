import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openTrainer, STORE_VERSION } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "store-migration-"));
  directories.push(directory);
  return directory;
}

function start(directory: string) {
  const trainer = openTrainer(directory);
  opened.push(trainer);
  return trainer;
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Хранилище текущей формы: проект, досье, открытая сессия и ключ. */
function seed(directory: string) {
  const trainer = start(directory);
  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-MIGR",
  });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);

  const saved = trainer.saveCase({ customerName: "Север", title: "Миграция", characters: ["Анна"] });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  const session = trainer.openSession({
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId,
  });
  assert.ok(session.ok);

  trainer.close();
  return {
    caseId: saved.caseRecord.id,
    dossierId: approved.dossier.id,
    sessionId: session.session.id,
    keyId,
  };
}

/** Прежняя установка версии не знала: `user_version` остаётся нулём. */
function forgetVersion(directory: string): void {
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database.exec("PRAGMA user_version = 0");
  database.close();
}

function version(directory: string): number {
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  database.close();
  return row.user_version;
}

test("хранилище текущей формы открывается на новой версии без потерь", () => {
  const directory = tempDirectory();
  const ids = seed(directory);
  forgetVersion(directory);

  const trainer = start(directory);
  assert.deepEqual(trainer.listCustomers(), [{ id: trainer.readCase(ids.caseId)?.customerId, name: "Север" }]);
  assert.equal(trainer.readCase(ids.caseId)?.title, "Миграция");
  assert.equal(trainer.readApprovedDossier(ids.caseId)?.id, ids.dossierId);
  assert.equal(trainer.listOpenSessions()[0]?.id, ids.sessionId);
  assert.equal(trainer.listKeys()[0]?.id, ids.keyId);
  assert.equal(version(directory), STORE_VERSION);
});

test("копия файла лежит до шага, и версия становится текущей", () => {
  const directory = tempDirectory();
  seed(directory);
  forgetVersion(directory);

  const storeFile = join(directory, "store.sqlite");
  const before = readFileSync(storeFile);

  start(directory);

  const backup = `${storeFile}.v0.bak`;
  assert.equal(existsSync(backup), true);
  assert.deepEqual(readFileSync(backup), before);
  assert.equal(version(directory), STORE_VERSION);
  assert.notDeepEqual(readFileSync(storeFile), before);
});

test("без копии миграция не начинается и файл не меняется", () => {
  const directory = tempDirectory();
  seed(directory);
  forgetVersion(directory);

  const storeFile = join(directory, "store.sqlite");
  const before = readFileSync(storeFile);
  mkdirSync(`${storeFile}.v0.bak`);

  assert.throws(() => openTrainer(directory));
  assert.deepEqual(readFileSync(storeFile), before);
  assert.equal(version(directory), 0);
});

test("текущая версия не перестраивает таблицы и не запускает догоняющие эвристики", () => {
  const directory = tempDirectory();
  const ids = seed(directory);
  const storeFile = join(directory, "store.sqlite");

  const database = new DatabaseSync(storeFile);
  const sessionsSql = (
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as { sql: string }
  ).sql;
  assert.equal(sessionsSql.includes("'finished'"), true);
  database.exec(`
    CREATE TABLE owner_profile (
      id TEXT PRIMARY KEY CHECK (id = 'owner'),
      resume TEXT NOT NULL,
      portfolio TEXT NOT NULL,
      cases_text TEXT NOT NULL
    ) STRICT;
    INSERT INTO owner_profile (id, resume, portfolio, cases_text)
      VALUES ('owner', 'Старое резюме', 'Старое портфолио', 'Старый кейс');
  `);
  database.close();

  const trainer = start(directory);
  assert.equal(trainer.readCase(ids.caseId)?.title, "Миграция");
  assert.equal(trainer.listOpenSessions()[0]?.id, ids.sessionId);
  trainer.close();

  const again = new DatabaseSync(storeFile);
  const sessionsAfter = (
    again.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as { sql: string }
  ).sql;
  assert.equal(sessionsAfter, sessionsSql);
  assert.notEqual(
    again.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_profile'").get(),
    undefined,
  );
  again.close();
  assert.equal(version(directory), STORE_VERSION);
});
