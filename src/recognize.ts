import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** Локальное чтение надписи с картинки. Сеть этот расчёт не вызывает. */
export type PageRecognizer = {
  recognize(image: Uint8Array): Promise<string>;
};

type TesseractApi = {
  createWorker(
    langs: string,
    oem: number,
    options: {
      langPath: string;
      cachePath: string;
      gzip: boolean;
      errorHandler?: (error: unknown) => void;
    },
  ): Promise<{
    recognize(image: Buffer): Promise<{ data: { text?: string } }>;
  }>;
};

/**
 * Распознаватель установки.
 * Файл rus.traineddata лежит в каталоге на машине владельца.
 * Пока его нет, надписи нет и расчёт наружу не ходит.
 */
export function installationRecognizer(ownerDirectory: string): PageRecognizer {
  return liveRecognizer(join(ownerDirectory, "models", "tesseract"));
}

export function liveRecognizer(modelDirectory: string): PageRecognizer {
  let worker: Promise<PageRecognizer> | undefined;
  return {
    async recognize(image) {
      if (image.length === 0 || !existsSync(join(modelDirectory, "rus.traineddata"))) {
        return "";
      }
      try {
        worker ??= openWorker(modelDirectory);
        return await (await worker).recognize(image);
      } catch (error) {
        worker = undefined;
        throw error;
      }
    },
  };
}

/** LSTM, без классического движка. Язык читается с диска, не с чужого адреса. */
async function openWorker(modelDirectory: string): Promise<PageRecognizer> {
  const tesseract = require("tesseract.js") as TesseractApi;
  const worker = await tesseract.createWorker("rus", 1, {
    langPath: modelDirectory,
    cachePath: modelDirectory,
    gzip: false,
    // Отказ уже отклоняет обещание. Второй бросок из колбэка роняет процесс.
    errorHandler() {},
  });
  return {
    async recognize(image) {
      const result = await worker.recognize(Buffer.from(image));
      return result.data.text ?? "";
    },
  };
}
