/**
 * Секрет ключа средствами ОС.
 * Windows пишет в хранилище свёрток DPAPI текущей учётной записи.
 * macOS пишет в хранилище только ссылку, а сам секрет кладёт в keychain.
 * Чужой свёрток этим модулем не раскрывается и наружу как секрет не отдаётся.
 */
import { Worker } from "node:worker_threads";

const DPAPI_PREFIX = "sealed:dpapi:";
const KEYCHAIN_PREFIX = "sealed:keychain:";
const CAPACITY = 65_536;

const shared = new SharedArrayBuffer(8 + CAPACITY);
const meta = new Int32Array(shared, 0, 2);

let worker: Worker | undefined;

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  const spawned = new Worker(new URL("./os-secret-worker.mjs", import.meta.url), {
    workerData: shared,
    execArgv: [],
  });
  spawned.unref();
  spawned.on("error", () => {
    if (worker === spawned) {
      worker = undefined;
    }
  });
  spawned.on("exit", () => {
    if (worker === spawned) {
      worker = undefined;
    }
  });
  worker = spawned;
  return spawned;
}

function stopWorker(): void {
  const current = worker;
  worker = undefined;
  if (!current) {
    return;
  }
  try {
    Atomics.store(meta, 0, 0);
    current.postMessage({ op: "QUIT", payload: "" });
    Atomics.wait(meta, 0, 0, 2_000);
  } catch {
    // Процесс и так завершается: секрет в эту ошибку не попадает.
  }
  void current.terminate();
}

process.once("beforeExit", stopWorker);

/** Ответ средств ОС. undefined — отказ, и этот отказ секретом не становится. */
function exchange(op: "SEAL" | "OPEN", payload: string): string | undefined {
  const current = ensureWorker();
  Atomics.store(meta, 0, 0);
  current.postMessage({ op, payload });
  Atomics.wait(meta, 0, 0, 30_000);
  if (Atomics.load(meta, 0) !== 1) {
    stopWorker();
    throw new Error("Средства ОС не ответили.");
  }
  const length = Atomics.load(meta, 1);
  const text = Buffer.from(new Uint8Array(shared, 8, length)).toString("utf8");
  if (text.startsWith("OK ")) {
    return text.slice(3);
  }
  if (text === "ERR") {
    return undefined;
  }
  throw new Error("Средства ОС не ответили.");
}

function requirePlatform(): "win32" | "darwin" {
  if (process.platform === "win32" || process.platform === "darwin") {
    return process.platform;
  }
  throw new Error("Секрет ключа шифруется только на Windows и macOS.");
}

/** Колонка хранилища уже свёрнута средствами ОС, а не лежит открытым текстом. */
export function isSealedSecret(stored: string): boolean {
  return stored.startsWith(DPAPI_PREFIX) || stored.startsWith(KEYCHAIN_PREFIX);
}

/**
 * Сворачивает секрет для записи в хранилище.
 * account — идентификатор ключа: на macOS это учётная запись записи keychain.
 */
export function sealSecret(secret: string, account: string): string {
  const platform = requirePlatform();
  const secretB64 = Buffer.from(secret, "utf8").toString("base64");
  if (platform === "win32") {
    const blob = exchange("SEAL", secretB64);
    if (!blob) {
      throw new Error("Средства ОС не сохранили секрет.");
    }
    return DPAPI_PREFIX + blob;
  }
  const accountB64 = Buffer.from(account, "utf8").toString("base64");
  const saved = exchange("SEAL", `${accountB64} ${secretB64}`);
  if (saved === undefined) {
    throw new Error("Средства ОС не сохранили секрет.");
  }
  return KEYCHAIN_PREFIX + account;
}

/**
 * Читает секрет, свёрнутый этой учётной записью.
 * Чужой или испорченный свёрток возвращает undefined и не становится секретом.
 */
export function openSecret(stored: string): string | undefined {
  const platform = requirePlatform();
  if (platform === "win32" && stored.startsWith(DPAPI_PREFIX)) {
    const opened = exchange("OPEN", stored.slice(DPAPI_PREFIX.length));
    if (!opened) {
      return undefined;
    }
    return Buffer.from(opened, "base64").toString("utf8");
  }
  if (platform === "darwin" && stored.startsWith(KEYCHAIN_PREFIX)) {
    const opened = exchange("OPEN", stored.slice(KEYCHAIN_PREFIX.length));
    if (!opened) {
      return undefined;
    }
    return Buffer.from(opened, "base64").toString("utf8");
  }
  return undefined;
}
