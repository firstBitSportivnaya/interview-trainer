import type { Protocol } from "./trainer.ts";

/** Сколько текста одна реплика может попросить у Anthropic. Протокол требует предел. */
const REPLY_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Сбой вызова. Текст поставщика сюда не кладётся, чтобы он не стал речью. */
export class ModelFailure extends Error {
  readonly reason: "timeout" | "model";

  constructor(reason: "timeout" | "model") {
    super(reason);
    this.name = "ModelFailure";
    this.reason = reason;
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
};

/**
 * Один порт к модели.
 * Проверка подставляет записанную модель. Живые адаптеры сидят за тем же портом.
 */
export type ModelPort = {
  complete(call: ModelCall, signal: AbortSignal): AsyncIterable<string>;
};

export type LiveModelOptions = {
  /** Предел ожидания ответа, миллисекунды. */
  timeoutMs?: number;
};

type ModelBody = {
  model: string;
  stream: true;
  messages: Array<{ role: ModelMessage["role"]; content: string }>;
  max_tokens?: number;
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
      if (call.protocol === "anthropic") {
        return streamReply(
          endpoint(call.baseAddress, "/v1/messages"),
          {
            "x-api-key": call.secret,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          { model: call.modelName, max_tokens: REPLY_TOKENS, stream: true, messages },
          anthropicText,
          timeoutMs,
          signal,
        );
      }
      return streamReply(
        endpoint(call.baseAddress, "/v1/chat/completions"),
        { authorization: `Bearer ${call.secret}` },
        { model: call.modelName, stream: true, messages },
        openaiText,
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

async function* streamReply(
  url: string,
  headers: Record<string, string>,
  body: ModelBody,
  take: (data: string) => string | undefined,
  timeoutMs: number,
  caller: AbortSignal,
): AsyncGenerator<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([caller, timeout]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const failure = failureFor(error, caller, timeout);
    if (failure) throw failure;
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelFailure("model");
  }

  try {
    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") return;
      const text = take(data);
      if (text) yield text;
    }
  } catch (error) {
    const failure = failureFor(error, caller, timeout);
    if (failure) throw failure;
  }
}

function readJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new ModelFailure("model");
  }
}

function anthropicText(data: string): string | undefined {
  const parsed = readJson(data);
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = parsed as {
    type?: unknown;
    error?: unknown;
    delta?: { type?: unknown; text?: unknown };
  };
  if (event.type === "error" || event.error !== undefined) throw new ModelFailure("model");
  if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") return undefined;
  if (typeof event.delta.text !== "string") throw new ModelFailure("model");
  return event.delta.text;
}

function openaiText(data: string): string | undefined {
  const parsed = readJson(data);
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = parsed as { error?: unknown; choices?: unknown };
  if (event.error !== undefined) throw new ModelFailure("model");
  if (!Array.isArray(event.choices)) return undefined;
  const choice = event.choices[0];
  if (!choice || typeof choice !== "object") return undefined;
  const delta = (choice as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return undefined;
  const content = (delta as { content?: unknown }).content;
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "string") throw new ModelFailure("model");
  return content;
}

/** Достаёт поле data из потока server-sent events. Неполное событие ждёт следующий кусок. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      } else if (done) {
        buffer += decoder.decode();
      }
      buffer = buffer.replaceAll("\r", "");
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt !== -1) {
        const data = eventData(buffer.slice(0, splitAt));
        buffer = buffer.slice(splitAt + 2);
        if (data !== undefined) yield data;
        splitAt = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim()) {
          const data = eventData(buffer);
          if (data !== undefined) yield data;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
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
