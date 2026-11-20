import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

type StoredKey = {
  id: string;
  protocol: Protocol;
  baseAddress: string;
  modelName: string;
  secret: string;
};

const FILE_NAME = "keys.json";

function isProtocol(value: string): value is Protocol {
  return value === "anthropic" || value === "openai-compatible";
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

/** Читает список. Нет файла — ключей ещё нет. Битый файл не подменяем пустым списком. */
function readKeys(file: string): StoredKey[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
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

/** Пишет список целиком: сначала временный файл, затем подмена, чтобы обрыв не стёр ключи. */
function writeKeys(file: string, stored: StoredKey[]): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(stored), "utf8");
  renameSync(temporary, file);
}

/**
 * Ядро одного владельца.
 * Каталог — место ключа на этой машине. Список ключей секрет целиком не отдаёт.
 */
export function openTrainer(directory: string) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, FILE_NAME);
  const stored = readKeys(file);

  return {
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

      stored.push({
        id: randomUUID(),
        protocol,
        baseAddress,
        modelName,
        secret,
      });
      writeKeys(file, stored);
      return { ok: true };
    },

    /** Возвращает сохранённые ключи без секрета целиком. */
    listKeys(): KeySummary[] {
      return stored.map(toSummary);
    },
  };
}
