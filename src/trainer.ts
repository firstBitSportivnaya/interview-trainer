import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { join } from "node:path";

import { liveModel, ModelFailure, type ModelPort } from "./model.ts";
import { isSealedSecret, openSecret, sealSecret } from "./os-secret.ts";

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
  /** Персонажи заказчика. Пустой список не хранит голос «заказчик»: его добавляет customerVoices. */
  characters: string[];
  /** Отметка «портфолио уже отправлено». У нового дела снята. */
  portfolioSent: boolean;
};

/** Заказчик. Второе дело ссылается на ту же запись и не заводит вторую компанию. */
export type CustomerRecord = {
  id: string;
  name: string;
};

/** Отказ завести дело: нет имени заказчика или названия, либо заказчик для второго дела не найден. */
export type SaveCaseResult =
  | { ok: true; caseRecord: CaseRecord }
  | { ok: false; reason: "incomplete" | "missing" };

/**
 * Профиль владельца: резюме, портфолио и кейсы.
 * Один на владельца и общий для всех дел.
 */
export type OwnerProfile = {
  resume: string;
  portfolio: string;
  cases: string;
};

/** Три слоя досье. Черновик ещё без идентификатора: сессия его не читает. */
export type DossierLayers = {
  material: string;
  serviceLayer: string;
  crib: string;
};

/** Отказ собрать черновик. Текст модели в отказ не входит. */
export type DraftDossierResult =
  | { ok: true; draft: DossierLayers }
  | { ok: false; reason: "incomplete" | "missing" | "timeout" | "model" | "secret" };

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
  | { kind: "failure"; reason: "timeout" | "model" | "missing" | "secret"; message: string };

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
  secret: "Секрет ключа не читается.",
} as const;

/**
 * Предел текста черновика, в знаках.
 * Форма утверждения кодирует один знак девятью байтами, поэтому предел короче тела запроса.
 */
export const DRAFT_LIMIT = 64 * 1024;

const PLAINTEXT_VACUUM = "plaintext-vacuum";
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
      title TEXT NOT NULL,
      portfolio_sent INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS case_characters (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      name TEXT NOT NULL,
      position INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS case_characters_case
      ON case_characters(case_id, position);

    CREATE TABLE IF NOT EXISTS owner_profile (
      id TEXT PRIMARY KEY CHECK (id = 'owner'),
      resume TEXT NOT NULL,
      portfolio TEXT NOT NULL,
      cases_text TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS store_flags (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
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

/** Секрет из колонки. Открытый текст прошлого хранилища читается как есть, чужой свёрток — нет. */
function revealSecret(stored: string): string | undefined {
  if (!isSealedSecret(stored)) {
    return stored;
  }
  return openSecret(stored);
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

/** Берёт целое. Текст или NULL значит, что файл хранилища разошёлся со схемой. */
function integerColumn(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error("Запись хранилища повреждена");
  }
  return value;
}

/** Оставляет названных персонажей. Пробелы и пустые строки в список не входят. */
function namedCharacters(names: readonly string[] | undefined): string[] {
  if (!names) {
    return [];
  }
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Голоса заказчика на деле.
 * Пустой список даёт один голос «заказчик», не записывая его в персонажи.
 */
export function customerVoices(characters: readonly string[]): string[] {
  return characters.length === 0 ? ["заказчик"] : [...characters];
}

/** Прежнее хранилище без отметки портфолио получает колонку. Уже записанное дело остаётся без отметки. */
function ensureCaseShape(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA table_info(cases)").all() as Row[];
  const names = new Set(rows.map((row) => textColumn(row, "name")));
  if (!names.has("portfolio_sent")) {
    database.exec("ALTER TABLE cases ADD COLUMN portfolio_sent INTEGER NOT NULL DEFAULT 0");
  }
}

/** Просит модель разложить вставленные тексты по слоям и вернуть только JSON. */
function dossierDraftPrompt(layers: DossierLayers): string {
  return [
    "Собери черновик досье из вставленных текстов. Каждый текст остаётся в своём слое.",
    "Не переноси текст между слоями. Не добавляй фактов, которых нет во вставленном тексте.",
    "Верни только JSON-объект с полями material, serviceLayer и crib. Значения — строки.",
    "",
    "Материал дела:",
    layers.material,
    "",
    "Служебный слой:",
    layers.serviceLayer,
    "",
    "Шпаргалка дела:",
    layers.crib,
  ].join("\n");
}

/** Читает три слоя из ответа модели. Чужой текст черновиком не становится. */
function parseDraft(text: string): DossierLayers | undefined {
  const trimmed = text.trim();
  const direct = layersFromJson(trimmed);
  if (direct) {
    return direct;
  }
  const wrapped = trimmed.match(/^```(?:json)?\s*([\s\S]*)```$/);
  if (!wrapped?.[1]) {
    return undefined;
  }
  return layersFromJson(wrapped[1].trim());
}

/** Берёт три строковых слоя из целого JSON. Обрывок объекта черновиком не становится. */
function layersFromJson(source: string): DossierLayers | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.material !== "string" ||
    typeof record.serviceLayer !== "string" ||
    typeof record.crib !== "string"
  ) {
    return undefined;
  }
  return {
    material: record.material,
    serviceLayer: record.serviceLayer,
    crib: record.crib,
  };
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
  const secret = revealSecret(textColumn(row, "secret"));
  return (
    secret !== undefined &&
    textColumn(row, "protocol") === key.protocol &&
    textColumn(row, "base_address") === key.baseAddress &&
    textColumn(row, "model_name") === key.modelName &&
    secret === key.secret
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
    insert.run(key.id, key.protocol, key.baseAddress, key.modelName, sealSecret(key.secret));
  }
}

function vacuumPending(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT value FROM store_flags WHERE name = ?").get(PLAINTEXT_VACUUM);
  return row !== undefined;
}

function setVacuumPending(database: DatabaseSync, pending: boolean): void {
  if (pending) {
    database.prepare("INSERT OR REPLACE INTO store_flags (name, value) VALUES (?, 'pending')").run(PLAINTEXT_VACUUM);
    return;
  }
  database.prepare("DELETE FROM store_flags WHERE name = ?").run(PLAINTEXT_VACUUM);
}

function hasPlaintextSecret(database: DatabaseSync): boolean {
  const rows = database.prepare("SELECT secret FROM keys").all() as Row[];
  return rows.some((row) => !isSealedSecret(textColumn(row, "secret")));
}

/** Сворачивает открытый секрет прошлого хранилища. Уже свёрнутую колонку не трогает. */
function sealPlaintextSecrets(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, secret FROM keys").all() as Row[];
  const update = database.prepare("UPDATE keys SET secret = ? WHERE id = ?");
  for (const row of rows) {
    const stored = textColumn(row, "secret");
    if (isSealedSecret(stored)) {
      continue;
    }
    const id = textColumn(row, "id");
    update.run(sealSecret(stored), id);
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

function readCaseRecord(row: Row, characters: readonly string[]): CaseRecord {
  return {
    id: textColumn(row, "id"),
    customerId: textColumn(row, "customer_id"),
    customerName: textColumn(row, "customer_name"),
    title: textColumn(row, "title"),
    characters: [...characters],
    portfolioSent: integerColumn(row, "portfolio_sent") === 1,
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
 * Каталог — хранилище на этой машине: заказчики, дела, профиль, досье, сессии, ход подготовки и ключи.
 * Список ключей секрет целиком не отдаёт. Секрет в хранилище свёрнут средствами ОС.
 * Одна открытая сессия на тройку
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
    ensureCaseShape(database);
    migrateLegacyKeys(database, directory);
    if (hasPlaintextSecret(database) || vacuumPending(database)) {
      setVacuumPending(database, true);
      sealPlaintextSecrets(database);
      database.exec("VACUUM");
      chmodSync(databaseFile, 0o600);
      setVacuumPending(database, false);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  function caseExists(caseId: string): boolean {
    return database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId) !== undefined;
  }

  const caseQuery = `
    SELECT cases.id, cases.customer_id, customers.name AS customer_name, cases.title, cases.portfolio_sent
    FROM cases
    JOIN customers ON customers.id = cases.customer_id
  `;

  function readCharacterNames(caseId: string): string[] {
    const rows = database
      .prepare("SELECT name FROM case_characters WHERE case_id = ? ORDER BY position, rowid")
      .all(caseId) as Row[];
    return rows.map((row) => textColumn(row, "name"));
  }

  function loadCase(row: Row): CaseRecord {
    return readCaseRecord(row, readCharacterNames(textColumn(row, "id")));
  }

  function insertCase(caseRecord: CaseRecord): void {
    database
      .prepare("INSERT INTO cases (id, customer_id, title, portfolio_sent) VALUES (?, ?, ?, 0)")
      .run(caseRecord.id, caseRecord.customerId, caseRecord.title);
    const insertCharacter = database.prepare(
      "INSERT INTO case_characters (id, case_id, name, position) VALUES (?, ?, ?, ?)",
    );
    caseRecord.characters.forEach((name, position) => {
      insertCharacter.run(randomUUID(), caseRecord.id, name, position);
    });
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

  function loadKey(keyId: string): { key: StoredKey } | { unreadable: true } | undefined {
    const row = database
      .prepare("SELECT id, protocol, base_address, model_name, secret FROM keys WHERE id = ?")
      .get(keyId) as Row | undefined;
    if (!row) {
      return undefined;
    }
    const stored = readStoredKey(row, databaseFile);
    const secret = revealSecret(stored.secret);
    if (secret === undefined) {
      return { unreadable: true };
    }
    return { key: { ...stored, secret } };
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

      const id = randomUUID();
      database
        .prepare("INSERT INTO keys (id, protocol, base_address, model_name, secret) VALUES (?, ?, ?, ?, ?)")
        .run(id, protocol, baseAddress, modelName, sealSecret(secret));
      return { ok: true };
    },

    /** Возвращает сохранённые ключи без секрета целиком. */
    listKeys(): KeySummary[] {
      const rows = database
        .prepare("SELECT id, protocol, base_address, model_name, secret FROM keys ORDER BY rowid")
        .all() as Row[];
      return rows.map((row) => {
        const stored = readStoredKey(row, databaseFile);
        const secret = revealSecret(stored.secret);
        if (secret === undefined) {
          return {
            id: stored.id,
            protocol: stored.protocol,
            baseAddress: stored.baseAddress,
            modelName: stored.modelName,
            secretPreview: "••••",
          };
        }
        return toSummary({ ...stored, secret });
      });
    },

    /**
     * Одним действием заводит заказчика и первое дело.
     * Пустое имя или название дело не создают. Пустой список персонажей остаётся пустым.
     */
    saveCase(draft: { customerName: string; title: string; characters?: readonly string[] }): SaveCaseResult {
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
        characters: namedCharacters(draft.characters),
        portfolioSent: false,
      };
      inTransaction(database, () => {
        database.prepare("INSERT INTO customers (id, name) VALUES (?, ?)").run(caseRecord.customerId, customerName);
        insertCase(caseRecord);
      });
      return { ok: true, caseRecord };
    },

    /**
     * Добавляет ещё одно дело уже существующему заказчику.
     * Новую компанию не создаёт. Неизвестный заказчик дело не создаёт.
     */
    addCase(draft: { customerId: string; title: string; characters?: readonly string[] }): SaveCaseResult {
      const customerId = draft.customerId.trim();
      const title = draft.title.trim();
      if (!customerId || !title) {
        return { ok: false, reason: "incomplete" };
      }

      const nameRow = database.prepare("SELECT name FROM customers WHERE id = ?").get(customerId) as Row | undefined;
      if (!nameRow) {
        return { ok: false, reason: "missing" };
      }

      const caseRecord: CaseRecord = {
        id: randomUUID(),
        customerId,
        customerName: textColumn(nameRow, "name"),
        title,
        characters: namedCharacters(draft.characters),
        portfolioSent: false,
      };
      inTransaction(database, () => {
        insertCase(caseRecord);
      });
      return { ok: true, caseRecord };
    },

    /** Возвращает заказчиков в порядке появления. */
    listCustomers(): CustomerRecord[] {
      const rows = database.prepare("SELECT id, name FROM customers ORDER BY rowid").all() as Row[];
      return rows.map((row) => ({ id: textColumn(row, "id"), name: textColumn(row, "name") }));
    },

    /** Возвращает дела в порядке появления. */
    listCases(): CaseRecord[] {
      const rows = database.prepare(`${caseQuery} ORDER BY cases.rowid`).all() as Row[];
      return rows.map((row) => loadCase(row));
    },

    /** Возвращает дело. Нет идентификатора — дела нет. */
    readCase(caseId: string): CaseRecord | undefined {
      const row = database.prepare(`${caseQuery} WHERE cases.id = ?`).get(caseId) as Row | undefined;
      return row ? loadCase(row) : undefined;
    },

    /**
     * Записывает профиль владельца.
     * Повторная запись заменяет ту же строку, вторую не создаёт.
     */
    saveProfile(draft: OwnerProfile): void {
      database
        .prepare(
          `INSERT INTO owner_profile (id, resume, portfolio, cases_text) VALUES ('owner', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET resume = excluded.resume, portfolio = excluded.portfolio, cases_text = excluded.cases_text`,
        )
        .run(draft.resume.trim(), draft.portfolio.trim(), draft.cases.trim());
    },

    /** Возвращает профиль владельца. Пока его не сохраняли, поля пустые. */
    readProfile(): OwnerProfile {
      const row = database
        .prepare("SELECT resume, portfolio, cases_text FROM owner_profile WHERE id = 'owner'")
        .get() as Row | undefined;
      if (!row) {
        return { resume: "", portfolio: "", cases: "" };
      }
      return {
        resume: textColumn(row, "resume"),
        portfolio: textColumn(row, "portfolio"),
        cases: textColumn(row, "cases_text"),
      };
    },

    /**
     * Собирает черновик из вставленных текстов слоёв выбранным ключом.
     * Черновик не записывается и сессию не открывает: в диалог он попадёт только после правки и утверждения.
     */
    async draftDossier(draft: { caseId: string; keyId: string } & DossierLayers): Promise<DraftDossierResult> {
      const caseId = draft.caseId.trim();
      const keyId = draft.keyId.trim();
      const layers: DossierLayers = {
        material: draft.material.trim(),
        serviceLayer: draft.serviceLayer.trim(),
        crib: draft.crib.trim(),
      };
      if (!caseId || !keyId || (!layers.material && !layers.serviceLayer && !layers.crib)) {
        return { ok: false, reason: "incomplete" };
      }
      if (!caseExists(caseId)) {
        return { ok: false, reason: "missing" };
      }
      const loaded = loadKey(keyId);
      if (!loaded) {
        return { ok: false, reason: "missing" };
      }
      if (!("key" in loaded)) {
        return { ok: false, reason: "secret" };
      }

      const controller = new AbortController();
      let text = "";
      try {
        for await (const chunk of model.complete(
          {
            protocol: loaded.key.protocol,
            baseAddress: loaded.key.baseAddress,
            modelName: loaded.key.modelName,
            secret: loaded.key.secret,
            messages: [{ role: "user", text: dossierDraftPrompt(layers) }],
          },
          controller.signal,
        )) {
          text += chunk;
          if (text.length > DRAFT_LIMIT) {
            return { ok: false, reason: "model" };
          }
        }
      } catch (error) {
        const reason = error instanceof ModelFailure ? error.reason : "model";
        return { ok: false, reason };
      } finally {
        controller.abort();
      }

      const parsed = parseDraft(text);
      if (!parsed) {
        return { ok: false, reason: "model" };
      }
      return { ok: true, draft: parsed };
    },

    /** Утверждает досье новой записью. В запись входит текст после правки, не черновик модели. Открытая сессия держит то досье, с которым её открыли. */
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
     * Возвращает последнее утверждённое досье дела.
     * Черновик сюда не входит. Пока владелец не утвердил правку, досье нет.
     */
    readApprovedDossier(caseId: string): DossierRecord | undefined {
      const row = database
        .prepare(
          `SELECT id, case_id, material, service_layer, crib
           FROM dossiers WHERE case_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(caseId) as Row | undefined;
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
      const loaded = session ? loadKey(session.keyId) : undefined;
      if (!session || !loaded) {
        yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
        return;
      }
      if (!("key" in loaded)) {
        yield { kind: "failure", reason: "secret", message: FAILURE_MESSAGE.secret };
        return;
      }
      const key = loaded.key;

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
