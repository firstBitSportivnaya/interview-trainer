import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { join } from "node:path";

import { liveModel, ModelFailure, type ModelPort } from "./model.ts";

/** Протокол ключа: родной Anthropic или совместимый с OpenAI. */
export type Protocol = "anthropic" | "openai-compatible";

/** Четыре поля, из которых владелец собирает ключ. Протокол ещё строка: ядро само решает, годится ли она. */
export type KeyDraft = {
  protocol: string;
  baseAddress: string;
  modelName: string;
  secret: string;
};

/** Отказ сохранить ключ: не хватает поля или протокол не из двух допустимых. */
export type SaveKeyResult =
  | { ok: true }
  | { ok: false; reason: "incomplete" | "protocol" };

/** Ключ, который можно показать. Хвост секрета виден, только если секрет длиннее четырёх знаков. */
export type KeySummary = {
  id: string;
  protocol: Protocol;
  baseAddress: string;
  modelName: string;
  secretPreview: string;
};

/** Роль исполнителя из каталога первой версии. */
export type PerformerRole =
  | "руководитель проекта"
  | "аналитик"
  | "функциональный архитектор"
  | "технический архитектор"
  | "разработчик";

/** Сторона, напротив которой сидит исполнитель. */
export type Side = "заказчик" | "внутренняя команда";

/** Дело заказчика, которое можно прочитать после перезапуска. */
export type CaseRecord = {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
};

/** Отказ завести дело: нет имени заказчика или названия. */
export type SaveCaseResult =
  | { ok: true; caseRecord: CaseRecord }
  | { ok: false; reason: "incomplete" };

/** Утверждённое досье дела. Сессия хранит его идентификатор. */
export type DossierRecord = {
  id: string;
  caseId: string;
  /** Материал дела. */
  material: string;
  /** Служебный слой. */
  serviceLayer: string;
  /** Шпаргалка дела. */
  crib: string;
};

/** Отказ утвердить досье: дела нет. */
export type ApproveDossierResult =
  | { ok: true; dossier: DossierRecord }
  | { ok: false; reason: "missing" };

/** Открытая сессия. */
export type SessionRecord = {
  id: string;
  caseId: string;
  dossierId: string;
  side: Side;
  character: string;
  role: PerformerRole;
  executorId: string;
  keyId: string;
  status: "open";
};

/**
 * Поля открытия сессии.
 * Сторона и роль ещё строки: ядро само решает, есть ли они в каталоге.
 */
export type SessionDraft = {
  caseId: string;
  dossierId: string;
  side: string;
  character: string;
  role: string;
  executorId: string;
  keyId: string;
};

/** Речь модели или отказ, который владельцу виден отдельно от речи. */
export type SpeechEvent =
  | { kind: "speech"; text: string }
  | { kind: "failure"; reason: "timeout" | "model" | "missing"; message: string };

/** Отказ открыть сессию: тройка уже открыта, записи нет или поле не из каталога. */
export type OpenSessionResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: "open" | "missing" | "role" | "side" | "incomplete" };

/** Ход подготовки одной тройки «дело + роль исполнителя + исполнитель». */
export type PreparationRecord = {
  caseId: string;
  role: PerformerRole;
  executorId: string;
  notes: string[];
};

/** Заметка в ход подготовки. Роль ещё строка: ядро сверяет её с каталогом. */
export type PreparationDraft = {
  caseId: string;
  role: string;
  executorId: string;
  note: string;
};

/** Отказ дописать ход: дела нет, роль чужая или заметка пустая. */
export type WritePreparationResult =
  | { ok: true; preparation: PreparationRecord }
  | { ok: false; reason: "missing" | "role" | "incomplete" };

type StoredKey = {
  id: string;
  protocol: Protocol;
  baseAddress: string;
  modelName: string;
  secret: string;
};

type Row = Record<string, SQLOutputValue>;

const FAILURE_MESSAGE = {
  timeout: "Модель не ответила вовремя.",
  model: "Модель вернула ошибку.",
  missing: "Сессия не найдена.",
} as const;

const LEGACY_KEYS = "keys.json";
/** Снимок keys.json, уже снятый с пути, куда пишет прежний процесс. */
const LEGACY_STAGING = "keys.json.migrating";
const STORE_FILE = "store.sqlite";
const SESSION_COLUMNS = "id, case_id, dossier_id, side, character_name, role, executor_id, key_id, status";
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const PERFORMER_ROLES = [
  "руководитель проекта",
  "аналитик",
  "функциональный архитектор",
  "технический архитектор",
  "разработчик",
] as const satisfies readonly PerformerRole[];

const SIDES = ["заказчик", "внутренняя команда"] as const satisfies readonly Side[];

/** Собирает список SQL-литералов для CHECK. Значения каталога кавычек не содержат. */
function sqlTextList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

/** Схема хранилища. Повторный запуск не трогает уже записанные строки. */
function schemaSql(): string {
  const roles = sqlTextList(PERFORMER_ROLES);
  const sides = sqlTextList(SIDES);
  return `
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      title TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS dossiers (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      material TEXT NOT NULL,
      service_layer TEXT NOT NULL,
      crib TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      base_address TEXT NOT NULL,
      model_name TEXT NOT NULL,
      secret TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      dossier_id TEXT NOT NULL REFERENCES dossiers(id),
      side TEXT NOT NULL CHECK (side IN (${sides})),
      character_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN (${roles})),
      executor_id TEXT NOT NULL,
      key_id TEXT NOT NULL REFERENCES keys(id),
      status TEXT NOT NULL CHECK (status = 'open')
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open
      ON sessions(case_id, role, executor_id)
      WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS preparation_notes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      role TEXT NOT NULL CHECK (role IN (${roles})),
      executor_id TEXT NOT NULL,
      note TEXT NOT NULL
    ) STRICT;
  `;
}

function isProtocol(value: string): value is Protocol {
  return value === "anthropic" || value === "openai-compatible";
}

function isPerformerRole(value: string): value is PerformerRole {
  return (PERFORMER_ROLES as readonly string[]).includes(value);
}

function isSide(value: string): value is Side {
  return (SIDES as readonly string[]).includes(value);
}

function secretPreview(secret: string): string {
  if (secret.length <= 4) {
    return "••••";
  }
  return `••••${secret.slice(-4)}`;
}

function toSummary(key: StoredKey): KeySummary {
  return {
    id: key.id,
    protocol: key.protocol,
    baseAddress: key.baseAddress,
    modelName: key.modelName,
    secretPreview: secretPreview(key.secret),
  };
}

function isStoredKey(value: unknown): value is StoredKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const key = value as StoredKey;
  return (
    typeof key.id === "string" &&
    isProtocol(key.protocol) &&
    typeof key.baseAddress === "string" &&
    typeof key.modelName === "string" &&
    typeof key.secret === "string"
  );
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isUniqueConstraint(error: unknown): boolean {
  return !!error && typeof error === "object" && "errcode" in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/** Берёт текстовую колонку. Число или NULL значит, что файл хранилища разошёлся со схемой. */
function textColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error("Запись хранилища повреждена");
  }
  return value;
}

/** Читает прежний список. Нет файла — переносить нечего. Битый файл не подменяем пустым списком. */
function readLegacyKeys(file: string): StoredKey[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Список ключей повреждён: ${file}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isStoredKey)) {
    throw new Error(`Список ключей повреждён: ${file}`);
  }
  return parsed;
}

/** Выполняет несколько записей одним коммитом. Ошибка откатывает все. */
function inTransaction(database: DatabaseSync, body: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    body();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Исходная ошибка важнее сбоя отката.
    }
    throw error;
  }
}

/** Удаляет уже перенесённый снимок. Повторное открытие застаёт файл уже удалённым. */
function removeLegacyKeys(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Забирает keys.json в снимок.
 * Прежний процесс нужно остановить до запуска: запись после переименования
 * создаёт новый keys.json, и его заберёт следующее открытие.
 */
function claimLegacy(legacy: string, staging: string): boolean {
  if (existsSync(staging)) {
    return true;
  }
  try {
    renameSync(legacy, staging);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

/** Возвращает снимок на прежний путь, если новый список туда ещё не встал. */
function restoreLegacy(legacy: string, staging: string): void {
  if (!existsSync(staging) || existsSync(legacy)) {
    return;
  }
  try {
    renameSync(staging, legacy);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}

function sameStoredKey(row: Row, key: StoredKey): boolean {
  return (
    textColumn(row, "protocol") === key.protocol &&
    textColumn(row, "base_address") === key.baseAddress &&
    textColumn(row, "model_name") === key.modelName &&
    textColumn(row, "secret") === key.secret
  );
}

/**
 * Переносит снимок.
 * Тот же id с теми же полями пропускается, чтобы повтор после уже сделанной записи дошёл до удаления снимка.
 * Тот же id с другим секретом откатывает перенос.
 */
function importKeys(database: DatabaseSync, keys: readonly StoredKey[]): void {
  const find = database.prepare("SELECT protocol, base_address, model_name, secret FROM keys WHERE id = ?");
  const insert = database.prepare(
    "INSERT INTO keys (id, protocol, base_address, model_name, secret) VALUES (?, ?, ?, ?, ?)",
  );
  for (const key of keys) {
    const row = find.get(key.id) as Row | undefined;
    if (row) {
      if (!sameStoredKey(row, key)) {
        throw new Error(`Ключ ${key.id} в списке расходится с хранилищем`);
      }
      continue;
    }
    insert.run(key.id, key.protocol, key.baseAddress, key.modelName, key.secret);
  }
}

/** Переносит снимки, пока они есть. Расхождение или порча списка оставляют файл владельцу. */
function migrateLegacyKeys(database: DatabaseSync, directory: string): void {
  const legacy = join(directory, LEGACY_KEYS);
  const staging = join(directory, LEGACY_STAGING);
  for (;;) {
    if (!claimLegacy(legacy, staging)) {
      return;
    }

    let keys: StoredKey[];
    try {
      const read = readLegacyKeys(staging);
      if (read === undefined) {
        return;
      }
      keys = read;
    } catch (error) {
      restoreLegacy(legacy, staging);
      throw error;
    }

    try {
      inTransaction(database, () => importKeys(database, keys));
    } catch (error) {
      restoreLegacy(legacy, staging);
      throw error;
    }
    removeLegacyKeys(staging);
  }
}

function readStoredKey(row: Row, file: string): StoredKey {
  const protocol = textColumn(row, "protocol");
  if (!isProtocol(protocol)) {
    throw new Error(`Список ключей повреждён: ${file}`);
  }
  return {
    id: textColumn(row, "id"),
    protocol,
    baseAddress: textColumn(row, "base_address"),
    modelName: textColumn(row, "model_name"),
    secret: textColumn(row, "secret"),
  };
}

function readCaseRecord(row: Row): CaseRecord {
  return {
    id: textColumn(row, "id"),
    customerId: textColumn(row, "customer_id"),
    customerName: textColumn(row, "customer_name"),
    title: textColumn(row, "title"),
  };
}

function readDossierRecord(row: Row): DossierRecord {
  return {
    id: textColumn(row, "id"),
    caseId: textColumn(row, "case_id"),
    material: textColumn(row, "material"),
    serviceLayer: textColumn(row, "service_layer"),
    crib: textColumn(row, "crib"),
  };
}

function readSessionRecord(row: Row): SessionRecord {
  const role = textColumn(row, "role");
  const side = textColumn(row, "side");
  const status = textColumn(row, "status");
  if (!isPerformerRole(role) || !isSide(side) || status !== "open") {
    throw new Error("Запись хранилища повреждена");
  }
  return {
    id: textColumn(row, "id"),
    caseId: textColumn(row, "case_id"),
    dossierId: textColumn(row, "dossier_id"),
    side,
    character: textColumn(row, "character_name"),
    role,
    executorId: textColumn(row, "executor_id"),
    keyId: textColumn(row, "key_id"),
    status,
  };
}

/**
 * Ядро одного владельца.
 * Каталог — хранилище на этой машине: дела, досье, сессии, ход подготовки и ключи.
 * Список ключей секрет целиком не отдаёт. Одна открытая сессия на тройку
 * «дело + роль исполнителя + исполнитель» держится уникальным индексом.
 * Прежний процесс, который пишет keys.json, нужно остановить до этого запуска.
 * Модель приходит портом: проверка подставляет записанную, запуск — живую.
 */
export function openTrainer(directory: string, model: ModelPort = liveModel()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const databaseFile = join(directory, STORE_FILE);
  const database = new DatabaseSync(databaseFile, { enableForeignKeyConstraints: true });

  try {
    chmodSync(databaseFile, 0o600);
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(schemaSql());
    migrateLegacyKeys(database, directory);
  } catch (error) {
    database.close();
    throw error;
  }

  function caseExists(caseId: string): boolean {
    return database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId) !== undefined;
  }

  function readPreparationRecord(caseId: string, role: PerformerRole, executorId: string): PreparationRecord | undefined {
    const rows = database
      .prepare(
        `SELECT note FROM preparation_notes
         WHERE case_id = ? AND role = ? AND executor_id = ?
         ORDER BY rowid`,
      )
      .all(caseId, role, executorId) as Row[];
    if (rows.length === 0) {
      return undefined;
    }
    return {
      caseId,
      role,
      executorId,
      notes: rows.map((row) => textColumn(row, "note")),
    };
  }

  function loadSession(sessionId: string): SessionRecord | undefined {
    const row = database.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as
      | Row
      | undefined;
    return row ? readSessionRecord(row) : undefined;
  }

  function loadKey(keyId: string): StoredKey | undefined {
    const row = database
      .prepare("SELECT id, protocol, base_address, model_name, secret FROM keys WHERE id = ?")
      .get(keyId) as Row | undefined;
    return row ? readStoredKey(row, databaseFile) : undefined;
  }

  let closed = false;

  return {
    /** Закрывает файл хранилища. Повторный вызов ничего не делает. */
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },

    /** Дописывает ключ отдельно от уже сохранённых. Пустое поле или чужой протокол ключ не создают. */
    saveKey(draft: KeyDraft): SaveKeyResult {
      const protocol = draft.protocol.trim();
      const baseAddress = draft.baseAddress.trim();
      const modelName = draft.modelName.trim();
      const secret = draft.secret.trim();
      if (!protocol || !baseAddress || !modelName || !secret) {
        return { ok: false, reason: "incomplete" };
      }
      if (!isProtocol(protocol)) {
        return { ok: false, reason: "protocol" };
      }

      database
        .prepare("INSERT INTO keys (id, protocol, base_address, model_name, secret) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), protocol, baseAddress, modelName, secret);
      return { ok: true };
    },

    /** Возвращает сохранённые ключи без секрета целиком. */
    listKeys(): KeySummary[] {
      const rows = database
        .prepare("SELECT id, protocol, base_address, model_name, secret FROM keys ORDER BY rowid")
        .all() as Row[];
      return rows.map((row) => toSummary(readStoredKey(row, databaseFile)));
    },

    /** Заводит заказчика и его дело. Пустое имя или название дело не создают. */
    saveCase(draft: { customerName: string; title: string }): SaveCaseResult {
      const customerName = draft.customerName.trim();
      const title = draft.title.trim();
      if (!customerName || !title) {
        return { ok: false, reason: "incomplete" };
      }

      const caseRecord: CaseRecord = {
        id: randomUUID(),
        customerId: randomUUID(),
        customerName,
        title,
      };
      inTransaction(database, () => {
        database.prepare("INSERT INTO customers (id, name) VALUES (?, ?)").run(caseRecord.customerId, customerName);
        database
          .prepare("INSERT INTO cases (id, customer_id, title) VALUES (?, ?, ?)")
          .run(caseRecord.id, caseRecord.customerId, title);
      });
      return { ok: true, caseRecord };
    },

    /** Возвращает дело. Нет идентификатора — дела нет. */
    readCase(caseId: string): CaseRecord | undefined {
      const row = database
        .prepare(
          `SELECT cases.id, cases.customer_id, customers.name AS customer_name, cases.title
           FROM cases
           JOIN customers ON customers.id = cases.customer_id
           WHERE cases.id = ?`,
        )
        .get(caseId) as Row | undefined;
      return row ? readCaseRecord(row) : undefined;
    },

    /** Утверждает досье новой записью. Открытая сессия держит то досье, с которым её открыли. */
    approveDossier(draft: { caseId: string; material: string; serviceLayer: string; crib: string }): ApproveDossierResult {
      if (!caseExists(draft.caseId)) {
        return { ok: false, reason: "missing" };
      }
      const dossier: DossierRecord = {
        id: randomUUID(),
        caseId: draft.caseId,
        material: draft.material,
        serviceLayer: draft.serviceLayer,
        crib: draft.crib,
      };
      database
        .prepare("INSERT INTO dossiers (id, case_id, material, service_layer, crib) VALUES (?, ?, ?, ?, ?)")
        .run(dossier.id, dossier.caseId, dossier.material, dossier.serviceLayer, dossier.crib);
      return { ok: true, dossier };
    },

    /** Возвращает утверждённое досье. Нет идентификатора — досье нет. */
    readDossier(dossierId: string): DossierRecord | undefined {
      const row = database
        .prepare("SELECT id, case_id, material, service_layer, crib FROM dossiers WHERE id = ?")
        .get(dossierId) as Row | undefined;
      return row ? readDossierRecord(row) : undefined;
    },

    /**
     * Открывает сессию.
     * Вторая открытая сессия той же тройки не создаётся: это держит уникальный индекс.
     */
    openSession(draft: SessionDraft): OpenSessionResult {
      const caseId = draft.caseId.trim();
      const dossierId = draft.dossierId.trim();
      const side = draft.side.trim();
      const character = draft.character.trim();
      const role = draft.role.trim();
      const executorId = draft.executorId.trim();
      const keyId = draft.keyId;
      if (!caseId || !dossierId || !side || !character || !role || !executorId || !keyId.trim()) {
        return { ok: false, reason: "incomplete" };
      }
      if (!isPerformerRole(role)) {
        return { ok: false, reason: "role" };
      }
      if (!isSide(side)) {
        return { ok: false, reason: "side" };
      }

      const dossier = database.prepare("SELECT case_id FROM dossiers WHERE id = ?").get(dossierId) as Row | undefined;
      const key = database.prepare("SELECT id FROM keys WHERE id = ?").get(keyId);
      if (!caseExists(caseId) || !dossier || textColumn(dossier, "case_id") !== caseId || !key) {
        return { ok: false, reason: "missing" };
      }

      const session: SessionRecord = {
        id: randomUUID(),
        caseId,
        dossierId,
        side,
        character,
        role,
        executorId,
        keyId,
        status: "open",
      };
      try {
        database
          .prepare(
            `INSERT INTO sessions (
               id, case_id, dossier_id, side, character_name, role, executor_id, key_id, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
          )
          .run(
            session.id,
            session.caseId,
            session.dossierId,
            session.side,
            session.character,
            session.role,
            session.executorId,
            session.keyId,
          );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return { ok: false, reason: "open" };
        }
        throw error;
      }
      return { ok: true, session };
    },

    /** Возвращает сессию. Нет идентификатора — сессии нет. */
    readSession(sessionId: string): SessionRecord | undefined {
      return loadSession(sessionId);
    },

    /**
     * Зовёт модель ключом, которым открыта сессия.
     * Речь приходит кусками. Ошибка модели в речь не подмешивается.
     */
    async *reply(sessionId: string, line: string): AsyncIterable<SpeechEvent> {
      const session = loadSession(sessionId);
      const key = session ? loadKey(session.keyId) : undefined;
      if (!session || !key) {
        yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
        return;
      }

      const controller = new AbortController();
      try {
        for await (const text of model.complete(
          {
            protocol: key.protocol,
            baseAddress: key.baseAddress,
            modelName: key.modelName,
            secret: key.secret,
            messages: [{ role: "user", text: line }],
          },
          controller.signal,
        )) {
          if (text) {
            yield { kind: "speech", text };
          }
        }
      } catch (error) {
        const reason = error instanceof ModelFailure ? error.reason : "model";
        yield { kind: "failure", reason, message: FAILURE_MESSAGE[reason] };
      } finally {
        controller.abort();
      }
    },

    /** Возвращает открытые сессии в порядке открытия. */
    listOpenSessions(): SessionRecord[] {
      const rows = database
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE status = 'open' ORDER BY rowid`,
        )
        .all() as Row[];
      return rows.map((row) => readSessionRecord(row));
    },

    /** Дописывает заметку в ход подготовки тройки. Пустая заметка ход не меняет. */
    writePreparation(draft: PreparationDraft): WritePreparationResult {
      const caseId = draft.caseId.trim();
      const role = draft.role.trim();
      const executorId = draft.executorId.trim();
      const note = draft.note.trim();
      if (!caseId || !role || !executorId || !note) {
        return { ok: false, reason: "incomplete" };
      }
      if (!isPerformerRole(role)) {
        return { ok: false, reason: "role" };
      }
      if (!caseExists(caseId)) {
        return { ok: false, reason: "missing" };
      }

      database
        .prepare("INSERT INTO preparation_notes (id, case_id, role, executor_id, note) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), caseId, role, executorId, note);
      const preparation = readPreparationRecord(caseId, role, executorId);
      if (!preparation) {
        throw new Error("Ход подготовки не записан");
      }
      return { ok: true, preparation };
    },

    /** Возвращает ход подготовки тройки. Заметок ещё нет — записи нет. */
    readPreparation(caseId: string, role: string, executorId: string): PreparationRecord | undefined {
      if (!isPerformerRole(role)) {
        return undefined;
      }
      return readPreparationRecord(caseId, role, executorId);
    },
  };
}
