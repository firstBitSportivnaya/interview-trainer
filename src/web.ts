import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { KeyDraft, KeySummary, SaveKeyResult } from "./trainer.ts";

/** Ядро, которым веб пользуется тем же путём, что и проверка. */
type Trainer = {
  saveKey(draft: KeyDraft): SaveKeyResult;
  listKeys(): KeySummary[];
};

const PROTOCOL_LABEL: Record<KeySummary["protocol"], string> = {
  anthropic: "Anthropic",
  "openai-compatible": "совместимый с OpenAI",
};

const ERROR_TEXT: Record<Exclude<SaveKeyResult, { ok: true }>["reason"], string> = {
  incomplete: "Заполните протокол, базовый адрес, имя модели и секрет.",
  protocol: "Выберите протокол Anthropic или совместимый с OpenAI.",
};

/** Экранирует текст владельца, чтобы имя модели не стало разметкой. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Собирает страницу ключей. Секрет берётся только из уже скрытого списка. */
function renderPage(keys: KeySummary[], error?: string): string {
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const items =
    keys.length === 0
      ? "<p>Ключей пока нет.</p>"
      : `<ul>${keys
          .map(
            (key) =>
              `<li><span>${escapeHtml(PROTOCOL_LABEL[key.protocol])}</span> <span>${escapeHtml(key.baseAddress)}</span> <span>${escapeHtml(key.modelName)}</span> <code>${escapeHtml(key.secretPreview)}</code></li>`,
          )
          .join("")}</ul>`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Ключи</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1c1917; }
    label { display: block; margin: 0.8rem 0; }
    input, select { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.4rem; }
    button { margin-top: 0.5rem; padding: 0.45rem 0.8rem; }
    .error { color: #9f1239; }
    li { margin: 0.4rem 0; }
    code { letter-spacing: 0.04em; }
  </style>
</head>
<body>
  <h1>Ключи</h1>
  <p>Тренажёр открыт только на этом компьютере и не спрашивает пароль.</p>
  ${notice}
  <form method="post" action="/keys">
    <label>Протокол
      <select name="protocol" required>
        ${Object.entries(PROTOCOL_LABEL)
          .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
          .join("")}
      </select>
    </label>
    <label>Базовый адрес
      <input name="baseAddress" required autocomplete="off">
    </label>
    <label>Имя модели
      <input name="modelName" required autocomplete="off">
    </label>
    <label>Секрет
      <input name="secret" type="password" required autocomplete="off">
    </label>
    <button type="submit">Сохранить ключ</button>
  </form>
  <h2>Сохранённые</h2>
  ${items}
</body>
</html>`;
}

/** Читает тело формы и не держит в памяти больше 64 КБ. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendPage(response: ServerResponse, trainer: Trainer, error?: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderPage(trainer.listKeys(), error));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

/**
 * Веб-адаптер ядра.
 * Слушает только 127.0.0.1 и не проверяет пароль: дверь — учётная запись машины.
 */
export function startWeb(trainer: Trainer, port = 0): Promise<Server> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      const reason = url.searchParams.get("error");
      const error = reason === "incomplete" || reason === "protocol" ? ERROR_TEXT[reason] : undefined;
      sendPage(response, trainer, error);
      return;
    }

    if (request.method === "POST" && url.pathname === "/keys") {
      let body = "";
      try {
        body = await readBody(request);
      } catch {
        response.writeHead(413);
        response.end();
        return;
      }

      const fields = new URLSearchParams(body);
      const saved = trainer.saveKey({
        protocol: fields.get("protocol") ?? "",
        baseAddress: fields.get("baseAddress") ?? "",
        modelName: fields.get("modelName") ?? "",
        secret: fields.get("secret") ?? "",
      });
      redirect(response, saved.ok ? "/" : `/?error=${saved.reason}`);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
