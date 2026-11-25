import type { Protocol } from "./trainer.ts";

/** Потолок короткой реплики. Протокол требует предел. */
export const REPLY_TOKENS = 4096;
/** Потолок разбора, отдельно от короткой реплики. */
export const REVIEW_TOKENS = 8192;
/**
 * Потолок черновика.
 * Один токен на знак вмещает DRAFT_LIMIT (64 КиБ знаков). Общий потолок реплики этого не вмещает.
 */
export const DRAFT_TOKENS = 64 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";
/** Пауза между кусками, после которой вызов — сбой. Не срок всего ответа. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Незавершённый кадр длиннее этого отбрасывается. Предел — 64 КиБ. */
const FRAME_LIMIT = 64 * 1024;

/**
 * Класс сбоя без текста поставщика.
 * В речь и в досье попадает только этот класс, не тело ответа.
 */
export type ModelFailureDetail = "unreachable" | "auth" | "name" | "busy" | "large" | "rejected" | "cut";

/** Сбой вызова. Текст поставщика сюда не кладётся, чтобы он не стал речью. */
export class ModelFailure extends Error {
  readonly reason: "timeout" | "model";
  readonly detail?: ModelFailureDetail;

  constructor(reason: "timeout" | "model", detail?: ModelFailureDetail) {
    super(reason);
    this.name = "ModelFailure";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Реплика диалога, которую порт передаёт модели. */
export type ModelMessage = {
  role: "user" | "assistant";
  text: string;
};

/** Вызов модели тем ключом, который помнит сессия. */
export type ModelCall = {
  protocol: Protocol;
  baseAddress: string;
  modelName: string;
  secret: string;
  messages: readonly ModelMessage[];
  /** Потолок вывода этого вызова. Нет поля — потолок короткой реплики. */
  maxTokens?: number;
};

/**
 * Один порт к модели.
 * Проверка подставляет записанную модель. Живые адаптеры сидят за тем же портом.
 */
export type ModelPort = {
  complete(call: ModelCall, signal: AbortSignal): AsyncIterable<string>;
};

export type LiveModelOptions = {
  /** Пауза между кусками, миллисекунды. */
  timeoutMs?: number;
};

type ModelBody = {
  model: string;
  stream: true;
  messages: Array<{ role: ModelMessage["role"]; content: string }>;
  max_tokens?: number;
};

/** Кусок речи, конец протокола или обрыв по потолку длины. */
type StreamPiece = {
  text?: string;
  done?: boolean;
  truncated?: boolean;
};

/**
 * Живой порт: родной протокол Anthropic и протокол, совместимый с OpenAI.
 * Базовый адрес — корень без пути метода, например https://api.anthropic.com.
 * Куски речи отдаются по мере прихода. Таймаут и ошибка — ModelFailure, не текст.
 */
export function liveModel(options: LiveModelOptions = {}): ModelPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    complete(call, signal) {
      if (call.protocol !== "anthropic" && call.protocol !== "openai-compatible") {
        return rejectedProtocol();
      }
      const messages = call.messages.map((message) => ({ role: message.role, content: message.text }));
      const maxTokens = call.maxTokens ?? REPLY_TOKENS;
      if (call.protocol === "anthropic") {
        return streamReply(
          endpoint(call.baseAddress, "/v1/messages"),
          {
            "x-api-key": call.secret,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          { model: call.modelName, max_tokens: maxTokens, stream: true, messages },
          anthropicPiece,
          timeoutMs,
          signal,
        );
      }
      return streamReply(
        endpoint(call.baseAddress, "/v1/chat/completions"),
        { authorization: `Bearer ${call.secret}` },
        { model: call.modelName, max_tokens: maxTokens, stream: true, messages },
        openaiPiece,
        timeoutMs,
        signal,
      );
    },
  };
}

async function* rejectedProtocol(): AsyncGenerator<string> {
  throw new ModelFailure("model");
}

function endpoint(baseAddress: string, path: string): string {
  return `${baseAddress.trim().replace(/\/+$/, "")}${path}`;
}

/** Отмена вызывающего кода обрывает поток. Таймаут и прочий сбой становятся отказом порта. */
function failureFor(error: unknown, caller: AbortSignal, timeout: AbortSignal): ModelFailure | undefined {
  if (error instanceof ModelFailure) return error;
  if (caller.aborted && !timeout.aborted) return undefined;
  if (timeout.aborted) return new ModelFailure("timeout");
  return new ModelFailure("model");
}

/** Сбрасываемый предел тишины. activity отмечает пришедший кусок. */
function idleAbort(timeoutMs: number): { signal: AbortSignal; activity: () => void; stop: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    activity() {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

async function* streamReply(
  url: string,
  headers: Record<string, string>,
  body: ModelBody,
  readPiece: (data: string) => StreamPiece,
  timeoutMs: number,
  caller: AbortSignal,
): AsyncGenerator<string> {
  const idle = idleAbort(timeoutMs);
  const signal = AbortSignal.any([caller, idle.signal]);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const failure = failureFor(error, caller, idle.signal);
      if (failure) {
        if (failure.detail) throw failure;
        if (failure.reason === "model" && unreachable(error)) throw new ModelFailure("model", "unreachable");
        throw failure;
      }
      return;
    }

    idle.activity();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      const detail = await failureDetail(response);
      throw new ModelFailure("model", detail);
    }

    let stopped = false;
    try {
      for await (const data of sseData(response.body, idle.activity)) {
        const piece = readPiece(data);
        if (piece.truncated) {
          if (piece.text) yield piece.text;
          throw new ModelFailure("model", "cut");
        }
        if (piece.done) return;
        if (piece.text) yield piece.text;
      }
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      const failure = failureFor(error, caller, idle.signal);
      if (failure) throw failure;
      stopped = true;
    }
    if (!stopped) throw new ModelFailure("model");
  } finally {
    idle.stop();
  }
}

/** Код сетевого сбоя. Тело ответа сюда не входит: соединения ещё не было. */
function unreachable(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  );
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  if ("code" in error && typeof error.code === "string") return error.code;
  const cause = "cause" in error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") return cause.code;
  return "";
}

/** Класс отказа по статусу и типу ошибки. Текст сообщения в класс не входит. */
async function failureDetail(response: Response): Promise<ModelFailureDetail> {
  let type = "";
  let message = "";
  if (response.body) {
    try {
      const raw = (await response.text()).slice(0, 4000);
      const parsed = JSON.parse(raw) as { error?: { type?: unknown; message?: unknown } };
      const error = parsed.error;
      if (error && typeof error === "object") {
        if (typeof error.type === "string") type = error.type;
        if (typeof error.message === "string") message = error.message;
      }
    } catch {
      type = "";
    }
  }
  const status = response.status;
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") {
    return "auth";
  }
  if (status === 404 || type === "not_found_error") return "name";
  if (
    status === 429 ||
    status === 503 ||
    status === 529 ||
    type === "rate_limit_error" ||
    type === "overloaded_error"
  ) {
    return "busy";
  }
  if (status === 413 || type === "request_too_large" || /prompt is too long|too many tokens/i.test(message)) {
    return "large";
  }
  return "rejected";
}

function readJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new ModelFailure("model");
  }
}

function anthropicPiece(data: string): StreamPiece {
  const parsed = readJson(data);
  if (!parsed || typeof parsed !== "object") return {};
  const event = parsed as {
    type?: unknown;
    error?: unknown;
    delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
  };
  if (event.type === "message_stop") return { done: true };
  if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") return { truncated: true };
  if (event.type === "error" || event.error !== undefined) throw new ModelFailure("model");
  if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") return {};
  if (typeof event.delta.text !== "string") throw new ModelFailure("model");
  return { text: event.delta.text };
}

function openaiPiece(data: string): StreamPiece {
  if (data === "[DONE]") return { done: true };
  const parsed = readJson(data);
  if (!parsed || typeof parsed !== "object") return {};
  const event = parsed as { error?: unknown; choices?: unknown };
  if (event.error !== undefined) throw new ModelFailure("model");
  if (!Array.isArray(event.choices)) return {};
  const choice = event.choices[0];
  if (!choice || typeof choice !== "object") return {};
  const record = choice as { delta?: unknown; finish_reason?: unknown };
  const truncated = record.finish_reason === "length";
  const delta = record.delta;
  let text: string | undefined;
  if (delta && typeof delta === "object") {
    const content = (delta as { content?: unknown }).content;
    if (typeof content === "string") text = content;
    else if (content !== undefined && content !== null) throw new ModelFailure("model");
  }
  if (truncated) return { text, truncated: true };
  if (!text) return {};
  return { text };
}

/** Достаёт поле data из потока server-sent events. Неполное событие ждёт следующий кусок. */
async function* sseData(body: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        onActivity?.();
        buffer += decoder.decode(value, { stream: !done });
      } else if (done) {
        buffer += decoder.decode();
      }
      buffer = buffer.replaceAll("\r", "");
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt !== -1) {
        const raw = buffer.slice(0, splitAt);
        if (raw.length > FRAME_LIMIT) throw new ModelFailure("model");
        const data = eventData(raw);
        buffer = buffer.slice(splitAt + 2);
        if (data !== undefined) yield data;
        splitAt = buffer.indexOf("\n\n");
      }
      if (buffer.length > FRAME_LIMIT) throw new ModelFailure("model");
      if (done) {
        if (buffer.trim()) {
          const data = eventData(buffer);
          if (data !== undefined) yield data;
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function eventData(raw: string): string | undefined {
  const lines = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)));
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
