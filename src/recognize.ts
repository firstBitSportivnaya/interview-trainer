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
  ): Promise<TesseractWorker>;
};

type TesseractWorker = {
  recognize(image: Buffer): Promise<{ data: { text?: string } }>;
  terminate(): Promise<unknown>;
};

/** Воркер распознавателя: отдаёт текст страницы и умеет завершиться. */
export type RecognizeWorker = {
  recognize(image: Uint8Array): Promise<string>;
  terminate(): Promise<unknown>;
};

/** Открывает воркер. Портом подменяется в тесте: живой воркер тянет веса. */
type WorkerSource = (modelDirectory: string) => Promise<RecognizeWorker>;

/**
 * Распознаватель установки.
 * Файл rus.traineddata лежит в каталоге на машине владельца.
 * Пока его нет, надписи нет и расчёт наружу не ходит.
 */
export function installationRecognizer(ownerDirectory: string): PageRecognizer {
  return liveRecognizer(join(ownerDirectory, "models", "tesseract"));
}

/**
 * Читает страницу и завершает воркер в том же вызове.
 * Следующая страница открывает свой: распознавание не копит воркеры.
 */
export function liveRecognizer(modelDirectory: string, open: WorkerSource = openWorker): PageRecognizer {
  return {
    async recognize(image) {
      if (image.length === 0 || !existsSync(join(modelDirectory, "rus.traineddata"))) {
        return "";
      }
      const worker = await open(modelDirectory);
      try {
        return await worker.recognize(image);
      } finally {
        await worker.terminate();
      }
    },
  };
}

/** LSTM, без классического движка. Язык читается с диска, не с чужого адреса. */
async function openWorker(modelDirectory: string): Promise<RecognizeWorker> {
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
    terminate: () => worker.terminate(),
  };
}
