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

/** Отказ сохранить ключ: не хватает поля, протокол не из двух допустимых или ключ записывает не владелец. */
export type SaveKeyResult =
  | { ok: true }
  | { ok: false; reason: "incomplete" | "protocol" | "forbidden" };

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

/** Проект заказчика, который можно прочитать после перезапуска. */
export type CaseRecord = {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
  /** Персонажи заказчика. Пустой список не хранит голос «заказчик»: его добавляет customerVoices. */
  characters: string[];
  /** Отметка «портфолио уже отправлено». У нового проекта снята. */
  portfolioSent: boolean;
};

/** Заказчик. Второй проект ссылается на ту же запись и не заводит вторую компанию. */
export type CustomerRecord = {
  id: string;
  name: string;
};

/** Отказ завести проект: нет имени заказчика или названия, заказчик для второго проекта не найден, либо проект создаёт не владелец. */
export type SaveCaseResult =
  | { ok: true; caseRecord: CaseRecord }
  | { ok: false; reason: "incomplete" | "missing" | "forbidden" };

/** Отказ поставить отметку «портфолио уже отправлено»: проекта нет. */
export type SetPortfolioSentResult =
  | { ok: true; caseRecord: CaseRecord }
  | { ok: false; reason: "missing" };

/**
 * Профиль исполнителя: резюме, портфолио и кейсы.
 * Общий для всех его проектов. Без идентификатора это профиль владельца.
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

/** Имя слоя, которое владелец назначает файлу. Ядро другое имя слоем не считает. */
export const DOSSIER_LAYER_NAMES = ["material", "serviceLayer", "crib"] as const;

/** Слой файла проекта: материал проекта, служебный слой или шпаргалка проекта. */
export type DossierLayerName = (typeof DOSSIER_LAYER_NAMES)[number];

/**
 * Файл проекта с уже извлечённым текстом.
 * Слой записан так, как его назвал владелец. Имя файла слой не задаёт.
 */
export type SourceFileRecord = {
  id: string;
  caseId: string;
  name: string;
  layer: DossierLayerName;
  extractedText: string;
};

/** Отказ записать файл: слоя нет в каталоге, поля пустые, проекта нет или слой называет не владелец. */
export type AddSourceFileResult =
  | { ok: true; file: SourceFileRecord }
  | { ok: false; reason: "layer" | "incomplete" | "missing" | "forbidden" };

/** Отказ собрать черновик. Текст модели в отказ не входит. */
export type DraftDossierResult =
  | { ok: true; draft: DossierLayers }
  | { ok: false; reason: "incomplete" | "missing" | "timeout" | "model" | "secret" };

/** Утверждённое досье проекта. Сессия хранит его идентификатор. */
export type DossierRecord = {
  id: string;
  caseId: string;
  /** Материал проекта. */
  material: string;
  /** Служебный слой. */
  serviceLayer: string;
  /** Шпаргалка проекта. */
  crib: string;
};

/** Отказ утвердить досье: проекта нет или досье утверждает не владелец. */
export type ApproveDossierResult =
  | { ok: true; dossier: DossierRecord }
  | { ok: false; reason: "missing" | "forbidden" };

/** Сессия. Законченная хранит разбор отдельно от стенограммы. */
export type SessionStatus = "open" | "finished";

/** Сессия, открытая или уже законченная. */
export type SessionRecord = {
  id: string;
  caseId: string;
  dossierId: string;
  side: Side;
  character: string;
  role: PerformerRole;
  executorId: string;
  keyId: string;
  status: SessionStatus;
};

/** Текст разбора. Числовой оценки в нём нет. */
export type ReviewRecord = {
  text: string;
};

/** Отказ закончить сессию: её нет, она уже закончена или ключ не ответил. */
export type FinishSessionResult =
  | { ok: true; session: SessionRecord; review: ReviewRecord }
  | { ok: false; reason: "missing" | "finished" | "timeout" | "model" | "secret" };

/**
 * Исполнитель первой версии.
 * Сессию по любому своему проекту он открывает без отдельной строки назначения.
 */
export const OWNER_EXECUTOR_ID = "владелец";

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

/** Кто говорит в стенограмме. */
export type TranscriptSpeaker = "персонаж" | "исполнитель";

/** Вопрос персонажа, его ответ или реплика исполнителя. */
export type TranscriptKind = "вопрос" | "ответ" | "реплика";

/** Строка стенограммы. Она остаётся на сессии. */
export type TranscriptLine = {
  speaker: TranscriptSpeaker;
  kind: TranscriptKind;
  text: string;
};

/**
 * Фраза, которой персонаж заказчика называет факт, которого нет в материале проекта.
 * Записанная модель и живая получают одну и ту же формулировку.
 */
export const ABSENT_FACT = "В материале проекта этого нет.";

/** Один вопрос персонажа. После него персонаж ждёт и сам очередь не продолжает. */
function openingTask(role: string, askExperience: boolean): string {
  if (askExperience) {
    return `Задай один вопрос про опыт исполнителю в роли «${role}» и остановись. Формулировку профиля не произноси и не подсказывай.`;
  }
  return `Задай один вопрос исполнителю в роли «${role}» и остановись.`;
}

/** Обе версии в материале проекта остаются открытыми: персонаж не выбирает одну. */
const FORK_RULE = "Если в материале проекта названы две версии, назови обе и не выбирай одну.";

/** При стоящей отметке персонаж спрашивает про опыт и не цитирует профиль. */
const PROFILE_RULE = "Спроси про опыт. Формулировку профиля не произноси и не подсказывай.";

/** Отказ открыть сессию: тройка уже открыта, записи нет, поле не из каталога или назначения на проект нет. */
export type OpenSessionResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: "open" | "missing" | "role" | "side" | "incomplete" | "assignment" };

/** Отказ назначить исполнителя: поля пустые, проекта нет или назначает не владелец. */
export type AssignExecutorResult =
  | { ok: true }
  | { ok: false; reason: "incomplete" | "missing" | "forbidden" };

/** Отказ отозвать назначение: поля пустые, строки нет или отзывает не владелец. */
export type RevokeAssignmentResult =
  | { ok: true }
  | { ok: false; reason: "incomplete" | "missing" | "forbidden" };

/** Ход подготовки одной тройки «проект + роль исполнителя + исполнитель». */
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

/** Отказ дописать ход: проекта нет, роль чужая или заметка пустая. */
export type WritePreparationResult =
  | { ok: true; preparation: PreparationRecord }
  | { ok: false; reason: "missing" | "role" | "incomplete" };

/** Вид записи хода. Пробел закрывает поздний разбор. Сигнал и расхождение снимает владелец. */
export type PreparationKind = "gap" | "watch" | "divergence" | "line" | "proposal";

/** Одна запись хода тройки. Правка хранит слой, который она предлагает заменить дополнением. */
export type PreparationEntry = {
  id: string;
  caseId: string;
  role: PerformerRole;
  executorId: string;
  kind: PreparationKind;
  text: string;
  layer?: "material" | "serviceLayer";
  status: "open" | "closed" | "accepted";
};

/** Отказ снять сигнал или расхождение: записи нет либо это не сигнал и не расхождение. */
export type DismissPreparationResult =
  | { ok: true; entry: PreparationEntry }
  | { ok: false; reason: "missing" | "kind" };

/** Отказ принять правку: записи нет, это не правка или досье проекта нет. */
export type AcceptProposalResult =
  | { ok: true; dossier: DossierRecord; entry: PreparationEntry }
  | { ok: false; reason: "missing" | "kind" };

/** Факты разбора, из которых дописывается ход. Числовой оценки среди них нет. */
type ReviewFacts = {
  gaps: string[];
  covered: string[];
  watch: string[];
  divergence: string[];
  line: string;
  proposals: { layer: "material" | "serviceLayer"; text: string }[];
};

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

export const PERFORMER_ROLES = [
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

    CREATE TABLE IF NOT EXISTS profiles (
      executor_id TEXT PRIMARY KEY,
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

    CREATE TABLE IF NOT EXISTS source_files (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      name TEXT NOT NULL,
      layer TEXT NOT NULL CHECK (layer IN ('material', 'serviceLayer', 'crib')),
      extracted_text TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS source_files_case
      ON source_files(case_id);

    CREATE TABLE IF NOT EXISTS keys (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      base_address TEXT NOT NULL,
      model_name TEXT NOT NULL,
      secret TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS assignments (
      executor_id TEXT NOT NULL,
      case_id TEXT NOT NULL REFERENCES cases(id),
      PRIMARY KEY (executor_id, case_id)
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
      status TEXT NOT NULL CHECK (status IN ('open', 'finished')),
      review TEXT
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open
      ON sessions(case_id, role, executor_id)
      WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS session_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      name TEXT NOT NULL,
      layer TEXT NOT NULL CHECK (layer IN ('material', 'serviceLayer', 'crib')),
      extracted_text TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS session_files_session
      ON session_files(session_id);

    CREATE TABLE IF NOT EXISTS preparation_notes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      role TEXT NOT NULL CHECK (role IN (${roles})),
      executor_id TEXT NOT NULL,
      note TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS preparation_entries (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      role TEXT NOT NULL CHECK (role IN (${roles})),
      executor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('gap', 'watch', 'divergence', 'line', 'proposal')),
      body TEXT NOT NULL,
      layer TEXT CHECK (layer IS NULL OR layer IN ('material', 'serviceLayer')),
      status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'accepted'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS preparation_entries_triple
      ON preparation_entries(case_id, role, executor_id);

    CREATE TABLE IF NOT EXISTS transcript (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      ordinal INTEGER NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('персонаж', 'исполнитель')),
      kind TEXT NOT NULL CHECK (kind IN ('вопрос', 'ответ', 'реплика')),
      body TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS transcript_session
      ON transcript(session_id, ordinal);
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

function isDossierLayer(value: string): value is DossierLayerName {
  return (DOSSIER_LAYER_NAMES as readonly string[]).includes(value);
}

/** Чужой исполнитель. Пустое поле — не владелец. Поле не передали — действует владелец первой версии. */
function foreignExecutor(executorId: string | undefined): boolean {
  return executorId !== undefined && executorId.trim() !== OWNER_EXECUTOR_ID;
}

/** Профиль без идентификатора принадлежит владельцу. Пустое поле тоже. */
function profileExecutorId(executorId: string | undefined): string {
  return (executorId ?? OWNER_EXECUTOR_ID).trim() || OWNER_EXECUTOR_ID;
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
 * Голоса заказчика на проекте.
 * Пустой список даёт один голос «заказчик», не записывая его в персонажи.
 */
export function customerVoices(characters: readonly string[]): string[] {
  return characters.length === 0 ? ["заказчик"] : [...characters];
}

/**
 * Прежняя единственная строка профиля становится профилем владельца.
 * Проекты, досье, сессии и ключи этот перенос не трогает.
 */
function ensureProfileShape(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_profile'")
    .get();
  if (!row) {
    return;
  }
  inTransaction(database, () => {
    database
      .prepare(
        `INSERT OR IGNORE INTO profiles (executor_id, resume, portfolio, cases_text)
         SELECT ?, resume, portfolio, cases_text FROM owner_profile`,
      )
      .run(OWNER_EXECUTOR_ID);
    database.exec("DROP TABLE owner_profile");
  });
}

/** Прежнее хранилище без отметки портфолио получает колонку. Уже записанный проект остаётся без отметки. */
function ensureCaseShape(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA table_info(cases)").all() as Row[];
  const names = new Set(rows.map((row) => textColumn(row, "name")));
  if (!names.has("portfolio_sent")) {
    database.exec("ALTER TABLE cases ADD COLUMN portfolio_sent INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Прежняя таблица сессий знает только открытую.
 * Перенос добавляет законченную и текст разбора. Строки сессий остаются.
 */
function ensureSessionShape(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as
    | Row
    | undefined;
  if (!row) {
    return;
  }
  const sql = textColumn(row, "sql");
  if (sql.includes("'finished'")) {
    return;
  }
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    inTransaction(database, () => {
      database.exec(`
        CREATE TABLE sessions_next (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES cases(id),
          dossier_id TEXT NOT NULL REFERENCES dossiers(id),
          side TEXT NOT NULL CHECK (side IN (${sqlTextList(SIDES)})),
          character_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN (${sqlTextList(PERFORMER_ROLES)})),
          executor_id TEXT NOT NULL,
          key_id TEXT NOT NULL REFERENCES keys(id),
          status TEXT NOT NULL CHECK (status IN ('open', 'finished')),
          review TEXT
        ) STRICT;
        INSERT INTO sessions_next (
          id, case_id, dossier_id, side, character_name, role, executor_id, key_id, status, review
        )
        SELECT id, case_id, dossier_id, side, character_name, role, executor_id, key_id, status, NULL
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_next RENAME TO sessions;
        CREATE UNIQUE INDEX sessions_one_open
          ON sessions(case_id, role, executor_id)
          WHERE status = 'open';
      `);
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Кладёт извлечённый текст в слой, который назвал владелец.
 * Пустой список файлов оставляет вставленный текст как есть.
 */
function composeLayers(pasted: DossierLayers, files: readonly SourceFileRecord[]): DossierLayers {
  const text = (layer: DossierLayerName, pastedText: string): string => {
    const parts = [pastedText];
    for (const file of files) {
      if (file.layer === layer && file.extractedText) {
        parts.push(file.extractedText);
      }
    }
    return parts.filter((part) => part.length > 0).join("\n\n");
  };
  return {
    material: text("material", pasted.material),
    serviceLayer: text("serviceLayer", pasted.serviceLayer),
    crib: text("crib", pasted.crib),
  };
}

/** Просит модель разложить вставленные тексты по слоям и вернуть только JSON. */
function dossierDraftPrompt(layers: DossierLayers): string {
  return [
    "Собери черновик досье из вставленных текстов. Каждый текст остаётся в своём слое.",
    "Не переноси текст между слоями. Не добавляй фактов, которых нет во вставленном тексте.",
    "Верни только JSON-объект с полями material, serviceLayer и crib. Значения — строки.",
    "",
    "Материал проекта:",
    layers.material,
    "",
    "Служебный слой:",
    layers.serviceLayer,
    "",
    "Шпаргалка проекта:",
    layers.crib,
  ].join("\n");
}

function historyText(history: readonly TranscriptLine[]): string {
  if (history.length === 0) {
    return "пока пусто";
  }
  return history.map((line) => `${line.speaker}: ${line.text}`).join("\n");
}

/**
 * Задание персонажу заказчика.
 * Факты — только материал проекта. Заметки хода подготовки — линия поведения, не источник фактов.
 * Служебный слой и шпаргалка проекта в текст не входят.
 * Профиль входит только при стоящей отметке и не произносится.
 */
function customerPrompt(input: {
  character: string;
  role: string;
  material: string;
  notes: readonly string[];
  history: readonly TranscriptLine[];
  profile?: OwnerProfile;
  task: string;
}): string {
  const lines = [
    `Ты — персонаж «${input.character}», сторона «заказчик».`,
    `Исполнитель в роли «${input.role}».`,
    "Факты бери только из материала проекта.",
    `Если факта в материале проекта нет, скажи дословно: ${ABSENT_FACT}`,
    "Шпаргалку проекта не произноси. Служебный слой не читай и не упоминай.",
    FORK_RULE,
    "Линия поведения — не факты. Фактов из неё не произноси.",
    "",
    "Линия поведения:",
    input.notes.length === 0 ? "нет" : input.notes.join("\n"),
    "",
  ];
  if (input.profile) {
    lines.push(
      "Профиль не входит в материал проекта. Вопрос про опыт не заменяй фразой об отсутствии факта.",
      PROFILE_RULE,
      "",
      "Профиль:",
      "Резюме:",
      input.profile.resume,
      "Портфолио:",
      input.profile.portfolio,
      "Кейсы:",
      input.profile.cases,
      "",
    );
  }
  lines.push("Материал проекта:", input.material, "", "Стенограмма:", historyText(input.history), "", input.task);
  return lines.join("\n");
}

/**
 * Задание персонажу внутренней команды.
 * Он читает материал проекта и служебный слой. Шпаргалка проекта и профиль в текст не входят.
 */
function internalPrompt(input: {
  character: string;
  role: string;
  material: string;
  serviceLayer: string;
  notes: readonly string[];
  history: readonly TranscriptLine[];
  task: string;
}): string {
  return [
    `Ты — персонаж «${input.character}», сторона «внутренняя команда».`,
    `Исполнитель в роли «${input.role}».`,
    "Факты бери из материала проекта и служебного слоя.",
    `Если факта нет ни в материале проекта, ни в служебном слое, скажи дословно: ${ABSENT_FACT}`,
    "Шпаргалку проекта не произноси. Профиль не произноси.",
    FORK_RULE,
    "",
    "Ход подготовки:",
    input.notes.length === 0 ? "нет" : input.notes.join("\n"),
    "",
    "Служебный слой:",
    input.serviceLayer,
    "",
    "Материал проекта:",
    input.material,
    "",
    "Стенограмма:",
    historyText(input.history),
    "",
    input.task,
  ].join("\n");
}

/** Текст файлов, с которыми открыта сессия. Пустой снимок так и называется. */
function fileLayerLabel(layer: DossierLayerName): string {
  if (layer === "material") {
    return "материал проекта";
  }
  if (layer === "serviceLayer") {
    return "служебный слой";
  }
  return "шпаргалка проекта";
}

function heldFileText(files: readonly { name: string; layer: DossierLayerName; text: string }[]): string {
  if (files.length === 0) {
    return "нет";
  }
  return files
    .map((file) => `${fileLayerLabel(file.layer)}, ${file.name}:\n${file.text}`)
    .join("\n\n");
}

/**
 * Задание на разбор.
 * Досье и тексты файлов — те, с которыми открыта сессия.
 * Из хода сюда входят только открытые пробелы и их идентификаторы.
 * Числовой оценки разбор не ставит.
 */
function reviewPrompt(input: {
  material: string;
  serviceLayer: string;
  crib: string;
  files: readonly { name: string; layer: DossierLayerName; text: string }[];
  history: readonly TranscriptLine[];
  gaps: readonly { id: string; text: string }[];
}): string {
  const openGaps = input.gaps.length === 0 ? "нет" : input.gaps.map((gap) => `${gap.id}: ${gap.text}`).join("\n");
  return [
    "Разбери законченную сессию.",
    "Числовой оценки не ставь.",
    "Отметь, где прозвучал служебный слой.",
    "Отметь, где речь разошлась с досье.",
    "Отметь, где речь разошлась с текстом файла проекта.",
    "Назови вопросы шпаргалки проекта, которые не прозвучали.",
    "В конце, с новой строки, напиши маркер ХОД и следом один JSON-объект.",
    "Поля JSON: gaps, watch, divergence — массивы строк; covered — массив идентификаторов открытых пробелов; line — строка линии поведения без текста служебного слоя; proposals — массив объектов с полями layer и text.",
    "layer в proposals — только material или serviceLayer. text — дополнение этого слоя, не замена всего досье.",
    "В covered ставь идентификатор пробела, который в этой сессии прозвучал. Своя формулировка пробел не закрывает. Сигнал следить и расхождение сами не снимаются.",
    "Числовой оценки нет и в JSON.",
    "",
    "Открытые пробелы:",
    openGaps,
    "",
    "Досье, с которым открыта сессия:",
    "Материал проекта:",
    input.material,
    "",
    "Служебный слой:",
    input.serviceLayer,
    "",
    "Шпаргалка проекта:",
    input.crib,
    "",
    "Тексты файлов, с которыми открыта сессия:",
    heldFileText(input.files),
    "",
    "Стенограмма:",
    historyText(input.history),
  ].join("\n");
}

/** Берёт непустые строки. Чужой элемент делает весь список негодным. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    const text = item.trim();
    if (text) {
      items.push(text);
    }
  }
  return items;
}

/** Берёт предложения правки. Чужой слой или не объект список негодным делают. */
function proposalList(value: unknown): ReviewFacts["proposals"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: ReviewFacts["proposals"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (record.layer !== "material" && record.layer !== "serviceLayer") {
      return undefined;
    }
    if (text) {
      items.push({ layer: record.layer, text });
    }
  }
  return items;
}

/** Читает JSON после маркера. Обрывок и чужие поля фактами разбора не становятся. */
function parseFactsJson(raw: string): ReviewFacts | undefined {
  const source = raw.replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
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
  const gaps = stringList(record.gaps);
  const covered = stringList(record.covered);
  const watch = stringList(record.watch);
  const divergence = stringList(record.divergence);
  const proposals = proposalList(record.proposals);
  if (!gaps || !covered || !watch || !divergence || !proposals || typeof record.line !== "string") {
    return undefined;
  }
  return {
    gaps,
    covered,
    watch,
    divergence,
    line: record.line.trim(),
    proposals,
  };
}

/**
 * Отделяет текст разбора от блока хода.
 * Нет маркера или JSON не читается — остаётся весь ответ, ход из него не пишется.
 */
function splitReview(text: string): { prose: string; facts?: ReviewFacts } {
  const marker = "\nХОД\n";
  const at = text.lastIndexOf(marker);
  if (at < 0) {
    return { prose: text.trim() };
  }
  const facts = parseFactsJson(text.slice(at + marker.length));
  if (!facts) {
    return { prose: text.trim() };
  }
  return { prose: text.slice(0, at).trim(), facts };
}

/** Режет текст на предложения. Короткий обрывок из линии не вырезается. */
function servicePieces(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

/**
 * Тексты, которых не должно быть в линии заказчика.
 * Статус записи не открывает служебный текст: снятый сигнал и принятая правка остаются скрытыми.
 */
function hiddenServiceTexts(serviceLayer: string, entries: readonly PreparationEntry[]): string[] {
  const hidden = new Set<string>();
  const add = (value: string): void => {
    const text = value.trim();
    if (text) {
      hidden.add(text);
    }
    for (const piece of servicePieces(value)) {
      hidden.add(piece);
    }
  };
  add(serviceLayer);
  for (const entry of entries) {
    if (entry.kind === "watch" || (entry.kind === "proposal" && entry.layer === "serviceLayer")) {
      add(entry.text);
    }
  }
  return [...hidden].sort((left, right) => right.length - left.length);
}

/** Вырезает служебные тексты. Обычная линия поведения остаётся. */
function withoutServiceText(text: string, secrets: readonly string[]): string {
  let next = text;
  for (const secret of secrets) {
    next = next.split(secret).join("");
  }
  return next.trim();
}

/** Убирает из линии текст служебного слоя и служебные записи любого статуса. */
function behaviorLine(notes: readonly string[], entries: readonly PreparationEntry[], serviceLayer: string): string {
  const secrets = hiddenServiceTexts(serviceLayer, entries);
  const parts: string[] = [];
  for (const note of notes) {
    const text = withoutServiceText(note, secrets);
    if (text) {
      parts.push(text);
    }
  }
  for (const entry of entries) {
    if (entry.status !== "open" || entry.kind !== "line") {
      continue;
    }
    const text = withoutServiceText(entry.text, secrets);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Полная запись хода для внутренней команды. Закрытое и принятое в неё не входит. */
function preparationLog(notes: readonly string[], entries: readonly PreparationEntry[]): string {
  const parts = [...notes];
  for (const entry of entries) {
    if (entry.status !== "open") {
      continue;
    }
    if (entry.kind === "gap") {
      parts.push(`Пробел: ${entry.text}`);
    } else if (entry.kind === "watch") {
      parts.push(`Сигнал следить: ${entry.text}`);
    } else if (entry.kind === "divergence") {
      parts.push(`Расхождение: ${entry.text}`);
    } else if (entry.kind === "line") {
      parts.push(`Линия: ${entry.text}`);
    } else if (entry.layer === "serviceLayer") {
      parts.push(`Правка служебного слоя: ${entry.text}`);
    } else {
      parts.push(`Правка материала проекта: ${entry.text}`);
    }
  }
  return parts.join("\n");
}

/** Дописывает принятый текст к слою. Пустой слой становится этим текстом. */
function appendLayer(current: string, addition: string): string {
  const base = current.trim();
  const next = addition.trim();
  return base ? `${base}\n\n${next}` : next;
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

function readSourceFileRecord(row: Row): SourceFileRecord {
  const layer = textColumn(row, "layer");
  if (!isDossierLayer(layer)) {
    throw new Error("Запись хранилища повреждена");
  }
  return {
    id: textColumn(row, "id"),
    caseId: textColumn(row, "case_id"),
    name: textColumn(row, "name"),
    layer,
    extractedText: textColumn(row, "extracted_text"),
  };
}

function isSessionStatus(value: string): value is SessionStatus {
  return value === "open" || value === "finished";
}

function readSessionRecord(row: Row): SessionRecord {
  const role = textColumn(row, "role");
  const side = textColumn(row, "side");
  const status = textColumn(row, "status");
  if (!isPerformerRole(role) || !isSide(side) || !isSessionStatus(status)) {
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
 * Каталог — хранилище на этой машине: заказчики, проекты, файлы проекта, профиль, досье, сессии, ход подготовки и ключи.
 * Список ключей секрет целиком не отдаёт. Секрет в хранилище свёрнут средствами ОС.
 * Одна открытая сессия на тройку
 * «проект + роль исполнителя + исполнитель» держится уникальным индексом.
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
    ensureSessionShape(database);
    ensureProfileShape(database);
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

  function assignmentExists(executorId: string, caseId: string): boolean {
    return (
      database
        .prepare("SELECT executor_id FROM assignments WHERE executor_id = ? AND case_id = ?")
        .get(executorId, caseId) !== undefined
    );
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

  function loadSourceFiles(caseId: string): SourceFileRecord[] {
    const rows = database
      .prepare(
        `SELECT id, case_id, name, layer, extracted_text
         FROM source_files WHERE case_id = ? ORDER BY rowid`,
      )
      .all(caseId) as Row[];
    return rows.map((row) => readSourceFileRecord(row));
  }

  /** Снимок текстов файлов на момент открытия. Поздний файл сюда не входит. */
  function rememberSessionFiles(sessionId: string, caseId: string): void {
    const insert = database.prepare(
      "INSERT INTO session_files (id, session_id, name, layer, extracted_text) VALUES (?, ?, ?, ?, ?)",
    );
    for (const file of loadSourceFiles(caseId)) {
      insert.run(randomUUID(), sessionId, file.name, file.layer, file.extractedText);
    }
  }

  function loadHeldFiles(sessionId: string): { name: string; layer: DossierLayerName; text: string }[] {
    const rows = database
      .prepare(
        `SELECT name, layer, extracted_text
         FROM session_files WHERE session_id = ? ORDER BY rowid`,
      )
      .all(sessionId) as Row[];
    return rows.map((row) => {
      const layer = textColumn(row, "layer");
      if (!isDossierLayer(layer)) {
        throw new Error("Запись хранилища повреждена");
      }
      return { name: textColumn(row, "name"), layer, text: textColumn(row, "extracted_text") };
    });
  }

  function readReviewRow(sessionId: string): ReviewRecord | undefined {
    const row = database.prepare("SELECT status, review FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
    if (!row || textColumn(row, "status") !== "finished") {
      return undefined;
    }
    const text = row.review;
    if (typeof text !== "string" || text.trim() === "") {
      return undefined;
    }
    return { text };
  }

  function loadDossier(dossierId: string): DossierRecord | undefined {
    const row = database
      .prepare("SELECT id, case_id, material, service_layer, crib FROM dossiers WHERE id = ?")
      .get(dossierId) as Row | undefined;
    return row ? readDossierRecord(row) : undefined;
  }

  function isTranscriptSpeaker(value: string): value is TranscriptSpeaker {
    return value === "персонаж" || value === "исполнитель";
  }

  function isTranscriptKind(value: string): value is TranscriptKind {
    return value === "вопрос" || value === "ответ" || value === "реплика";
  }

  function readTranscriptRows(sessionId: string): TranscriptLine[] {
    const rows = database
      .prepare("SELECT speaker, kind, body FROM transcript WHERE session_id = ? ORDER BY ordinal")
      .all(sessionId) as Row[];
    return rows.map((row) => {
      const speaker = textColumn(row, "speaker");
      const kind = textColumn(row, "kind");
      if (!isTranscriptSpeaker(speaker) || !isTranscriptKind(kind)) {
        throw new Error("Запись хранилища повреждена");
      }
      return { speaker, kind, text: textColumn(row, "body") };
    });
  }

  function hasOpeningQuestion(sessionId: string): boolean {
    return (
      database.prepare("SELECT id FROM transcript WHERE session_id = ? AND kind = 'вопрос' LIMIT 1").get(sessionId) !==
      undefined
    );
  }

  function appendTranscript(sessionId: string, speaker: TranscriptSpeaker, kind: TranscriptKind, text: string): void {
    const row = database
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM transcript WHERE session_id = ?")
      .get(sessionId) as Row;
    database
      .prepare("INSERT INTO transcript (id, session_id, ordinal, speaker, kind, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), sessionId, integerColumn(row, "ordinal") + 1, speaker, kind, text);
  }

  /**
   * Зовёт модель ключом сессии и отдаёт речь кусками.
   * spoken собирает куски. failed — вызов оборвался, и целая реплика не сложилась.
   * signal обрывает вызов, когда читатель закрыл поток.
   */
  async function* streamKey(
    session: SessionRecord,
    messages: { role: "user"; text: string }[],
    spoken: { text: string; failed: boolean },
    signal?: AbortSignal,
  ): AsyncIterable<SpeechEvent> {
    const loaded = loadKey(session.keyId);
    if (!loaded) {
      spoken.failed = true;
      yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
      return;
    }
    if (!("key" in loaded)) {
      spoken.failed = true;
      yield { kind: "failure", reason: "secret", message: FAILURE_MESSAGE.secret };
      return;
    }
    const key = loaded.key;
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
      if (signal?.aborted) {
        spoken.failed = true;
        return;
      }
      for await (const text of model.complete(
        {
          protocol: key.protocol,
          baseAddress: key.baseAddress,
          modelName: key.modelName,
          secret: key.secret,
          messages,
        },
        controller.signal,
      )) {
        if (signal?.aborted) {
          spoken.failed = true;
          return;
        }
        if (text) {
          spoken.text += text;
          yield { kind: "speech", text };
        }
      }
      if (signal?.aborted) {
        spoken.failed = true;
      }
    } catch (error) {
      spoken.failed = true;
      if (signal?.aborted) {
        return;
      }
      const reason = error instanceof ModelFailure ? error.reason : "model";
      yield { kind: "failure", reason, message: FAILURE_MESSAGE[reason] };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  function portfolioMarked(caseId: string): boolean {
    const row = database.prepare("SELECT portfolio_sent FROM cases WHERE id = ?").get(caseId) as Row | undefined;
    if (!row) {
      return false;
    }
    return integerColumn(row, "portfolio_sent") === 1;
  }

  function loadProfile(executorId: string): OwnerProfile {
    const row = database
      .prepare("SELECT resume, portfolio, cases_text FROM profiles WHERE executor_id = ?")
      .get(executorId) as Row | undefined;
    if (!row) {
      return { resume: "", portfolio: "", cases: "" };
    }
    return {
      resume: textColumn(row, "resume"),
      portfolio: textColumn(row, "portfolio"),
      cases: textColumn(row, "cases_text"),
    };
  }

  function optionalText(row: Row, column: string): string | undefined {
    const value = row[column];
    if (value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error("Запись хранилища повреждена");
    }
    return value;
  }

  function isPreparationKind(value: string): value is PreparationKind {
    return value === "gap" || value === "watch" || value === "divergence" || value === "line" || value === "proposal";
  }

  function readPreparationEntry(row: Row): PreparationEntry {
    const kind = textColumn(row, "kind");
    const status = textColumn(row, "status");
    const role = textColumn(row, "role");
    const layer = optionalText(row, "layer");
    if (
      !isPreparationKind(kind) ||
      (status !== "open" && status !== "closed" && status !== "accepted") ||
      !isPerformerRole(role) ||
      (layer !== undefined && layer !== "material" && layer !== "serviceLayer")
    ) {
      throw new Error("Запись хранилища повреждена");
    }
    return {
      id: textColumn(row, "id"),
      caseId: textColumn(row, "case_id"),
      role,
      executorId: textColumn(row, "executor_id"),
      kind,
      text: textColumn(row, "body"),
      ...(layer ? { layer } : {}),
      status,
    };
  }

  function loadPreparationEntries(caseId: string, role: PerformerRole, executorId: string): PreparationEntry[] {
    const rows = database
      .prepare(
        `SELECT id, case_id, role, executor_id, kind, body, layer, status
         FROM preparation_entries
         WHERE case_id = ? AND role = ? AND executor_id = ?
         ORDER BY rowid`,
      )
      .all(caseId, role, executorId) as Row[];
    return rows.map((row) => readPreparationEntry(row));
  }

  function loadPreparationEntry(entryId: string): PreparationEntry | undefined {
    const row = database
      .prepare(
        `SELECT id, case_id, role, executor_id, kind, body, layer, status
         FROM preparation_entries WHERE id = ?`,
      )
      .get(entryId) as Row | undefined;
    return row ? readPreparationEntry(row) : undefined;
  }

  /** Дописывает ход тройки из фактов разбора. Пробел закрывается по идентификатору. Сигнал и расхождение нет. */
  function applyReviewFacts(session: SessionRecord, facts: ReviewFacts): void {
    const coveredBodies = new Set<string>();
    const findGap = database.prepare(
      `SELECT body FROM preparation_entries
       WHERE id = ? AND case_id = ? AND role = ? AND executor_id = ? AND kind = 'gap' AND status = 'open'`,
    );
    const closeGap = database.prepare(
      `UPDATE preparation_entries SET status = 'closed'
       WHERE id = ? AND case_id = ? AND role = ? AND executor_id = ? AND kind = 'gap' AND status = 'open'`,
    );
    for (const id of facts.covered) {
      const row = findGap.get(id, session.caseId, session.role, session.executorId) as Row | undefined;
      if (!row) {
        continue;
      }
      coveredBodies.add(textColumn(row, "body"));
      closeGap.run(id, session.caseId, session.role, session.executorId);
    }
    const insert = database.prepare(
      `INSERT INTO preparation_entries (
         id, case_id, role, executor_id, kind, body, layer, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    );
    const sameOpen = database.prepare(
      `SELECT id FROM preparation_entries
       WHERE case_id = ? AND role = ? AND executor_id = ? AND kind = ? AND status = 'open' AND body = ?
         AND ((? IS NULL AND layer IS NULL) OR layer = ?)`,
    );
    const add = (kind: PreparationKind, body: string, layer: "material" | "serviceLayer" | null): void => {
      if (kind === "gap" && coveredBodies.has(body)) {
        return;
      }
      if (kind !== "line" && sameOpen.get(session.caseId, session.role, session.executorId, kind, body, layer, layer)) {
        return;
      }
      insert.run(randomUUID(), session.caseId, session.role, session.executorId, kind, body, layer);
    };
    for (const gap of facts.gaps) {
      add("gap", gap, null);
    }
    for (const item of facts.watch) {
      add("watch", item, null);
    }
    for (const item of facts.divergence) {
      add("divergence", item, null);
    }
    if (facts.line) {
      add("line", facts.line, null);
    }
    for (const proposal of facts.proposals) {
      add("proposal", proposal.text, proposal.layer);
    }
  }

  /**
   * Задание персонажу открытой сессии.
   * Заказчик получает линию без текста служебного слоя. Внутренняя команда читает ход целиком.
   * Профиль исполнителя этой сессии входит персонажу заказчика только при стоящей отметке.
   */
  function characterTask(session: SessionRecord, task: string): { ok: true; text: string } | { ok: false } {
    const dossier = loadDossier(session.dossierId);
    const caseRow = database.prepare(`${caseQuery} WHERE cases.id = ?`).get(session.caseId) as Row | undefined;
    if (!dossier || !caseRow) {
      return { ok: false };
    }
    const notes = readPreparationRecord(session.caseId, session.role, session.executorId)?.notes ?? [];
    const entries = loadPreparationEntries(session.caseId, session.role, session.executorId);
    const history = readTranscriptRows(session.id);
    if (session.side === "внутренняя команда") {
      const log = preparationLog(notes, entries);
      return {
        ok: true,
        text: internalPrompt({
          character: session.character,
          role: session.role,
          material: dossier.material,
          serviceLayer: dossier.serviceLayer,
          notes: log ? [log] : [],
          history,
          task,
        }),
      };
    }
    const caseRecord = loadCase(caseRow);
    const behavior = behaviorLine(notes, entries, dossier.serviceLayer);
    return {
      ok: true,
      text: customerPrompt({
        character: session.character,
        role: session.role,
        material: dossier.material,
        notes: behavior ? [behavior] : [],
        history,
        profile: caseRecord.portfolioSent ? loadProfile(session.executorId) : undefined,
        task,
      }),
    };
  }

  let closed = false;
  /** Сессии, у которых первый вопрос уже пошёл к модели и ещё не записан. */
  const openingReservations = new Set<string>();
  /** Сессии, у которых разбор уже пошёл к модели и ещё не записан. */
  const finishing = new Set<string>();

  return {
    /** Закрывает файл хранилища. Повторный вызов ничего не делает. */
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },

    /** Дописывает ключ отдельно от уже сохранённых. Пустое поле или чужой протокол ключ не создают. Чужой исполнитель ключ не записывает. */
    saveKey(draft: KeyDraft & { executorId?: string }): SaveKeyResult {
      if (foreignExecutor(draft.executorId)) {
        return { ok: false, reason: "forbidden" };
      }
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
     * Одним действием заводит заказчика и первый проект.
     * Пустое имя или название не создают проект. Пустой список персонажей остаётся пустым.
     */
    saveCase(draft: {
      customerName: string;
      title: string;
      characters?: readonly string[];
      executorId?: string;
    }): SaveCaseResult {
      if (foreignExecutor(draft.executorId)) {
        return { ok: false, reason: "forbidden" };
      }
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
     * Добавляет ещё один проект уже существующему заказчику.
     * Новую компанию не создаёт. Неизвестный заказчик проект не создаёт.
     */
    addCase(draft: {
      customerId: string;
      title: string;
      characters?: readonly string[];
      executorId?: string;
    }): SaveCaseResult {
      if (foreignExecutor(draft.executorId)) {
        return { ok: false, reason: "forbidden" };
      }
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

    /** Возвращает проекты в порядке появления. */
    listCases(): CaseRecord[] {
      const rows = database.prepare(`${caseQuery} ORDER BY cases.rowid`).all() as Row[];
      return rows.map((row) => loadCase(row));
    },

    /** Возвращает проект. Нет идентификатора — проекта нет. */
    readCase(caseId: string): CaseRecord | undefined {
      const row = database.prepare(`${caseQuery} WHERE cases.id = ?`).get(caseId) as Row | undefined;
      return row ? loadCase(row) : undefined;
    },

    /**
     * Ставит или снимает отметку «портфолио уже отправлено».
     * Другие поля проекта и досье не меняет. Неизвестного проекта нет.
     */
    setPortfolioSent(caseId: string, sent: boolean): SetPortfolioSentResult {
      const id = caseId.trim();
      if (!id || !caseExists(id)) {
        return { ok: false, reason: "missing" };
      }
      database.prepare("UPDATE cases SET portfolio_sent = ? WHERE id = ?").run(sent ? 1 : 0, id);
      const row = database.prepare(`${caseQuery} WHERE cases.id = ?`).get(id) as Row;
      return { ok: true, caseRecord: loadCase(row) };
    },

    /**
     * Записывает профиль исполнителя.
     * Без идентификатора это профиль владельца. Повторная запись заменяет ту же строку.
     */
    saveProfile(draft: OwnerProfile & { executorId?: string }): void {
      const executorId = profileExecutorId(draft.executorId);
      database
        .prepare(
          `INSERT INTO profiles (executor_id, resume, portfolio, cases_text) VALUES (?, ?, ?, ?)
           ON CONFLICT(executor_id) DO UPDATE SET
             resume = excluded.resume,
             portfolio = excluded.portfolio,
             cases_text = excluded.cases_text`,
        )
        .run(executorId, draft.resume.trim(), draft.portfolio.trim(), draft.cases.trim());
    },

    /** Возвращает профиль исполнителя. Без идентификатора — профиль владельца. Пока его не сохраняли, поля пустые. */
    readProfile(executorId?: string): OwnerProfile {
      return loadProfile(profileExecutorId(executorId));
    },

    /**
     * Записывает файл проекта в названный слой.
     * Пустой или чужой слой файлом не становится: ядро слой по имени файла не выбирает.
     * Запись не меняет утверждённое досье и сессию не открывает.
     */
    addSourceFile(draft: {
      caseId: string;
      name: string;
      layer: string;
      extractedText: string;
      executorId?: string;
    }): AddSourceFileResult {
      if (foreignExecutor(draft.executorId)) {
        return { ok: false, reason: "forbidden" };
      }
      const layer = draft.layer.trim();
      if (!isDossierLayer(layer)) {
        return { ok: false, reason: "layer" };
      }
      const caseId = draft.caseId.trim();
      const name = draft.name.trim();
      const extractedText = draft.extractedText.trim();
      if (!caseId || !name || !extractedText) {
        return { ok: false, reason: "incomplete" };
      }
      if (!caseExists(caseId)) {
        return { ok: false, reason: "missing" };
      }
      const file: SourceFileRecord = {
        id: randomUUID(),
        caseId,
        name,
        layer,
        extractedText,
      };
      database
        .prepare("INSERT INTO source_files (id, case_id, name, layer, extracted_text) VALUES (?, ?, ?, ?, ?)")
        .run(file.id, file.caseId, file.name, file.layer, file.extractedText);
      return { ok: true, file };
    },

    /** Возвращает файлы проекта в порядке записи. Нет проекта — списка нет. */
    listSourceFiles(caseId: string): SourceFileRecord[] {
      if (!caseExists(caseId)) {
        return [];
      }
      return loadSourceFiles(caseId);
    },

    /**
     * Собирает черновик из вставленных текстов и файлов проекта выбранным ключом.
     * Текст файла входит только в слой, который назвал владелец.
     * Черновик не записывается и сессию не открывает: в диалог он попадёт только после правки и утверждения.
     */
    async draftDossier(draft: { caseId: string; keyId: string } & DossierLayers): Promise<DraftDossierResult> {
      const caseId = draft.caseId.trim();
      const keyId = draft.keyId.trim();
      const layers = composeLayers(
        {
          material: draft.material.trim(),
          serviceLayer: draft.serviceLayer.trim(),
          crib: draft.crib.trim(),
        },
        caseId ? loadSourceFiles(caseId) : [],
      );
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
    approveDossier(draft: {
      caseId: string;
      material: string;
      serviceLayer: string;
      crib: string;
      executorId?: string;
    }): ApproveDossierResult {
      if (foreignExecutor(draft.executorId)) {
        return { ok: false, reason: "forbidden" };
      }
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
     * Возвращает последнее утверждённое досье проекта.
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
     * Назначает исполнителя на проект.
     * Владельцу строка не нужна: он открывает любой свой проект. Повтор той же пары вторую строку не создаёт.
     * Назначает владелец. Открытую сессию это не закрывает и не перенацеливает.
     */
    assignExecutor(draft: { executorId: string; caseId: string; actorId?: string }): AssignExecutorResult {
      const actorId = (draft.actorId ?? OWNER_EXECUTOR_ID).trim();
      if (actorId !== OWNER_EXECUTOR_ID) {
        return { ok: false, reason: "forbidden" };
      }
      const executorId = draft.executorId.trim();
      const caseId = draft.caseId.trim();
      if (!executorId || !caseId) {
        return { ok: false, reason: "incomplete" };
      }
      if (!caseExists(caseId)) {
        return { ok: false, reason: "missing" };
      }
      if (executorId === OWNER_EXECUTOR_ID) {
        return { ok: true };
      }
      database
        .prepare("INSERT OR IGNORE INTO assignments (executor_id, case_id) VALUES (?, ?)")
        .run(executorId, caseId);
      return { ok: true };
    },

    /**
     * Отзывает назначение.
     * Уже открытая сессия остаётся на досье и текстах файлов, с которыми её открыли.
     * Следующее открытие этой пары не проходит. Отзывает владелец.
     */
    revokeAssignment(draft: { executorId: string; caseId: string; actorId?: string }): RevokeAssignmentResult {
      const actorId = (draft.actorId ?? OWNER_EXECUTOR_ID).trim();
      if (actorId !== OWNER_EXECUTOR_ID) {
        return { ok: false, reason: "forbidden" };
      }
      const executorId = draft.executorId.trim();
      const caseId = draft.caseId.trim();
      if (!executorId || !caseId) {
        return { ok: false, reason: "incomplete" };
      }
      const existing = database
        .prepare("SELECT executor_id FROM assignments WHERE executor_id = ? AND case_id = ?")
        .get(executorId, caseId);
      if (!existing) {
        return { ok: false, reason: "missing" };
      }
      database.prepare("DELETE FROM assignments WHERE executor_id = ? AND case_id = ?").run(executorId, caseId);
      return { ok: true };
    },

    /**
     * Открывает сессию.
     * Вторая открытая сессия той же тройки не создаётся: это держит уникальный индекс.
     * Кроме владельца, сессия открывается только по назначенному проекту.
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
      if (executorId !== OWNER_EXECUTOR_ID && !assignmentExists(executorId, caseId)) {
        return { ok: false, reason: "assignment" };
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
        inTransaction(database, () => {
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
          rememberSessionFiles(session.id, caseId);
        });
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

    /** Возвращает стенограмму сессии. Нет сессии — записи нет. */
    readTranscript(sessionId: string): TranscriptLine[] | undefined {
      if (!loadSession(sessionId)) {
        return undefined;
      }
      return readTranscriptRows(sessionId);
    },

    /** Возвращает разбор законченной сессии. Открытая сессия и чужой идентификатор разбора не имеют. */
    readReview(sessionId: string): ReviewRecord | undefined {
      return readReviewRow(sessionId);
    },

    /**
     * Заканчивает сессию и пишет разбор ключом, которым она открыта.
     * Сбой и пустой ответ сессию не заканчивают и ход подготовки не меняют.
     * Блок ХОД дописывает ход этой тройки. Текст разбора — до маркера.
     */
    async finishSession(sessionId: string): Promise<FinishSessionResult> {
      const session = loadSession(sessionId);
      if (!session) {
        return { ok: false, reason: "missing" };
      }
      if (session.status !== "open" || finishing.has(session.id)) {
        return { ok: false, reason: "finished" };
      }
      const dossier = loadDossier(session.dossierId);
      if (!dossier) {
        return { ok: false, reason: "missing" };
      }
      finishing.add(session.id);
      try {
        const spoken = { text: "", failed: false };
        let failure: "timeout" | "model" | "missing" | "secret" | undefined;
        for await (const event of streamKey(
          session,
          [
            {
              role: "user",
              text: reviewPrompt({
                material: dossier.material,
                serviceLayer: dossier.serviceLayer,
                crib: dossier.crib,
                files: loadHeldFiles(session.id),
                history: readTranscriptRows(session.id),
                gaps: loadPreparationEntries(session.caseId, session.role, session.executorId)
                  .filter((entry) => entry.kind === "gap" && entry.status === "open")
                  .map((entry) => ({ id: entry.id, text: entry.text })),
              }),
            },
          ],
          spoken,
        )) {
          if (event.kind === "failure") {
            failure = event.reason;
          }
        }
        if (failure) {
          return { ok: false, reason: failure };
        }
        const text = spoken.text.trim();
        if (spoken.failed || !text) {
          return { ok: false, reason: "model" };
        }
        const split = splitReview(text);
        if (!split.prose) {
          return { ok: false, reason: "model" };
        }
        const current = loadSession(session.id);
        if (!current || current.status !== "open") {
          return { ok: false, reason: "finished" };
        }
        try {
          inTransaction(database, () => {
            const stillOpen = loadSession(session.id);
            if (!stillOpen || stillOpen.status !== "open") {
              throw new Error("Сессия уже закончена");
            }
            database
              .prepare("UPDATE sessions SET status = 'finished', review = ? WHERE id = ? AND status = 'open'")
              .run(split.prose, session.id);
            if (split.facts) {
              applyReviewFacts(stillOpen, split.facts);
            }
          });
        } catch (error) {
          if (error instanceof Error && error.message === "Сессия уже закончена") {
            return { ok: false, reason: "finished" };
          }
          throw error;
        }
        const saved = loadSession(session.id);
        const review = readReviewRow(session.id);
        if (!saved || saved.status !== "finished" || !review) {
          return { ok: false, reason: "model" };
        }
        return { ok: true, session: saved, review };
      } finally {
        finishing.delete(session.id);
      }
    },

    /**
     * Персонаж задаёт один вопрос по роли исполнителя и делает паузу.
     * Повторный вызов модель не зовёт: очередь сама не продолжается.
     * signal обрывает генерацию, когда страница закрыла поток.
     */
    async *openingQuestion(sessionId: string, signal?: AbortSignal): AsyncIterable<SpeechEvent> {
      const session = loadSession(sessionId);
      if (!session) {
        yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
        return;
      }
      if (session.status !== "open") {
        return;
      }
      if (hasOpeningQuestion(session.id) || openingReservations.has(session.id)) {
        return;
      }
      openingReservations.add(session.id);
      try {
        const task = characterTask(session, openingTask(session.role, session.side === "заказчик" && portfolioMarked(session.caseId)));
        if (!task.ok) {
          yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
          return;
        }
        const spoken = { text: "", failed: false };
        yield* streamKey(session, [{ role: "user", text: task.text }], spoken, signal);
        if (!spoken.failed && spoken.text && !signal?.aborted) {
          appendTranscript(session.id, "персонаж", "вопрос", spoken.text);
        }
      } finally {
        openingReservations.delete(session.id);
      }
    },

    /**
     * Зовёт модель ключом, которым открыта сессия.
     * Ответ берётся из слоя, открытого стороне, и пишется в стенограмму.
     * Исполнитель может спросить, не дожидаясь вопроса персонажа.
     * Речь приходит кусками. Ошибка модели в речь не подмешивается.
     * signal обрывает генерацию, когда страница закрыла поток.
     */
    async *reply(sessionId: string, line: string, signal?: AbortSignal): AsyncIterable<SpeechEvent> {
      const session = loadSession(sessionId);
      if (!session) {
        yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
        return;
      }
      if (session.status !== "open") {
        return;
      }
      const text = line.trim();
      if (!text) {
        return;
      }
      const task = characterTask(session, text);
      if (!task.ok) {
        yield { kind: "failure", reason: "missing", message: FAILURE_MESSAGE.missing };
        return;
      }
      appendTranscript(session.id, "исполнитель", "реплика", text);
      const spoken = { text: "", failed: false };
      yield* streamKey(session, [{ role: "user", text: task.text }], spoken, signal);
      if (spoken.text && !signal?.aborted) {
        appendTranscript(session.id, "персонаж", "ответ", spoken.text);
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

    /** Возвращает сессии в порядке открытия, включая законченные. */
    listSessions(): SessionRecord[] {
      const rows = database.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY rowid`).all() as Row[];
      return rows.map((row) => readSessionRecord(row));
    },

    /** Возвращает записи хода тройки, включая закрытые. Чужая роль — пустой список. */
    readPreparationEntries(caseId: string, role: string, executorId: string): PreparationEntry[] {
      if (!isPerformerRole(role)) {
        return [];
      }
      return loadPreparationEntries(caseId, role, executorId);
    },

    /** Возвращает одну запись хода. Нет идентификатора — записи нет. */
    readPreparationEntry(entryId: string): PreparationEntry | undefined {
      return loadPreparationEntry(entryId.trim());
    },

    /**
     * Снимает сигнал следить или расхождение.
     * Пробел и правка этим действием не закрываются: пробел закрывает поздний разбор, правку принимают отдельно.
     */
    dismissPreparation(entryId: string): DismissPreparationResult {
      const entry = loadPreparationEntry(entryId.trim());
      if (!entry) {
        return { ok: false, reason: "missing" };
      }
      if ((entry.kind !== "watch" && entry.kind !== "divergence") || entry.status !== "open") {
        return { ok: false, reason: "kind" };
      }
      database.prepare("UPDATE preparation_entries SET status = 'closed' WHERE id = ? AND status = 'open'").run(entry.id);
      const saved = loadPreparationEntry(entry.id);
      if (!saved) {
        return { ok: false, reason: "missing" };
      }
      return { ok: true, entry: saved };
    },

    /**
     * Принимает правку в новое досье.
     * Текст слоя дополняется, веса модели не меняются. Уже открытая сессия держит прежнее досье.
     */
    acceptProposal(entryId: string): AcceptProposalResult {
      const entry = loadPreparationEntry(entryId.trim());
      if (!entry) {
        return { ok: false, reason: "missing" };
      }
      if (entry.kind !== "proposal" || entry.status !== "open" || (entry.layer !== "material" && entry.layer !== "serviceLayer")) {
        return { ok: false, reason: "kind" };
      }
      const current = database
        .prepare(
          `SELECT id, case_id, material, service_layer, crib
           FROM dossiers WHERE case_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(entry.caseId) as Row | undefined;
      if (!current) {
        return { ok: false, reason: "missing" };
      }
      const dossier = readDossierRecord(current);
      const layer = entry.layer;
      const next: DossierRecord = {
        id: randomUUID(),
        caseId: dossier.caseId,
        material: layer === "material" ? appendLayer(dossier.material, entry.text) : dossier.material,
        serviceLayer: layer === "serviceLayer" ? appendLayer(dossier.serviceLayer, entry.text) : dossier.serviceLayer,
        crib: dossier.crib,
      };
      inTransaction(database, () => {
        database
          .prepare("INSERT INTO dossiers (id, case_id, material, service_layer, crib) VALUES (?, ?, ?, ?, ?)")
          .run(next.id, next.caseId, next.material, next.serviceLayer, next.crib);
        database.prepare("UPDATE preparation_entries SET status = 'accepted' WHERE id = ? AND status = 'open'").run(entry.id);
      });
      const saved = loadPreparationEntry(entry.id);
      if (!saved || saved.status !== "accepted") {
        return { ok: false, reason: "kind" };
      }
      return { ok: true, dossier: next, entry: saved };
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
