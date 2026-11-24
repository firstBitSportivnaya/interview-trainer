import { existsSync } from "node:fs";
import { join } from "node:path";

/** Скрытый размер multilingual-e5-small. Другая длина в индекс не входит. */
export const EMBEDDING_DIMENSION = 384;

/** Имя модели текущего индекса. Другое имя — другой индекс. */
export const LOCAL_EMBEDDING_MODEL = "multilingual-e5-small";

/**
 * Локальный расчёт токенов.
 * На вход уже приходит текст с префиксом. Сеть этот расчёт не вызывает.
 */
export type LocalEncoder = {
  encode(prefixedText: string): Promise<readonly (readonly number[])[]>;
};

type FeatureExtractor = (text: string) => Promise<{ data?: ArrayLike<number> }>;

/**
 * Порт эмбеддингов установки.
 * Текст файла получает префикс passage, текст хода — query.
 * Проверка подставляет свой расчёт токенов и живые веса не читает.
 */
export type InstallationEmbeddings = {
  modelName: string;
  embed(text: string, role: "passage" | "query"): Promise<readonly number[]>;
};

/** Единичный вектор длины 384. Ноль, другая длина и нечисло сюда не входят. */
export function unitVector(value: readonly unknown[]): number[] | undefined {
  if (value.length !== EMBEDDING_DIMENSION) {
    return undefined;
  }
  const numbers: number[] = [];
  let sum = 0;
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return undefined;
    }
    numbers.push(item);
    sum += item * item;
  }
  if (sum === 0) {
    return undefined;
  }
  const norm = Math.sqrt(sum);
  return numbers.map((item) => item / norm);
}

function meanPool(rows: readonly (readonly unknown[])[]): number[] | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const summed = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
  for (const row of rows) {
    if (row.length !== EMBEDDING_DIMENSION) {
      return undefined;
    }
    for (let index = 0; index < EMBEDDING_DIMENSION; index += 1) {
      const item = row[index];
      if (typeof item !== "number" || !Number.isFinite(item)) {
        return undefined;
      }
      summed[index] += item;
    }
  }
  return unitVector(summed);
}

const PASSAGE_PREFIX = "passage: ";
const QUERY_PREFIX = "query: ";

/**
 * Живой порт установки: multilingual-e5-small с диска, без внешнего API.
 * encoder подменяет расчёт токенов в проверке.
 */
export function localEmbeddings(encoder: LocalEncoder): InstallationEmbeddings {
  return {
    modelName: LOCAL_EMBEDDING_MODEL,
    async embed(text, role) {
      const prefix = role === "passage" ? PASSAGE_PREFIX : QUERY_PREFIX;
      const pooled = meanPool(await encoder.encode(`${prefix}${text}`));
      return pooled ?? [];
    },
  };
}

/**
 * Читает модель из каталога установки.
 * Пока файла модели нет, расчёт пуст и наружу не ходит.
 */
export function liveEncoder(modelDirectory: string): LocalEncoder {
  let extractor: Promise<FeatureExtractor> | undefined;
  return {
    async encode(prefixedText) {
      if (!existsSync(join(modelDirectory, "config.json"))) {
        return [];
      }
      try {
        extractor ??= loadExtractor(modelDirectory);
        const output = await (await extractor)(prefixedText);
        const data = output.data;
        if (!data || data.length !== EMBEDDING_DIMENSION) {
          return [];
        }
        return [Array.from(data)];
      } catch (error) {
        extractor = undefined;
        throw error;
      }
    },
  };
}

async function loadExtractor(modelDirectory: string): Promise<FeatureExtractor> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const extractor = await pipeline("feature-extraction", modelDirectory, { local_files_only: true });
  return async (text) => {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const data: number[] = [];
    for (const item of output.data) {
      if (typeof item !== "number") {
        return {};
      }
      data.push(item);
    }
    return { data };
  };
}
