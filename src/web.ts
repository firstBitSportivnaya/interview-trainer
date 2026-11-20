import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  customerVoices,
  type ApproveDossierResult,
  type CaseRecord,
  type CustomerRecord,
  type DossierLayers,
  type DossierRecord,
  type DraftDossierResult,
  type KeyDraft,
  type KeySummary,
  type OwnerProfile,
  type SaveCaseResult,
  type SaveKeyResult,
} from "./trainer.ts";

/** Ядро, которым веб пользуется тем же путём, что и проверка. */
type Trainer = {
  saveKey(draft: KeyDraft): SaveKeyResult;
  listKeys(): KeySummary[];
  saveCase(draft: { customerName: string; title: string; characters?: string[] }): SaveCaseResult;
  addCase(draft: { customerId: string; title: string; characters?: string[] }): SaveCaseResult;
  listCustomers(): CustomerRecord[];
  listCases(): CaseRecord[];
  readCase(caseId: string): CaseRecord | undefined;
  saveProfile(draft: OwnerProfile): void;
  readProfile(): OwnerProfile;
  draftDossier(draft: { caseId: string; keyId: string } & DossierLayers): Promise<DraftDossierResult>;
  approveDossier(draft: { caseId: string } & DossierLayers): ApproveDossierResult;
  readApprovedDossier(caseId: string): DossierRecord | undefined;
};

type CaseAction = "draft" | "approve";

const PROTOCOL_LABEL: Record<KeySummary["protocol"], string> = {
  anthropic: "Anthropic",
  "openai-compatible": "совместимый с OpenAI",
};

const KEY_ERROR: Record<Exclude<SaveKeyResult, { ok: true }>["reason"], string> = {
  incomplete: "Заполните протокол, базовый адрес, имя модели и секрет.",
  protocol: "Выберите протокол Anthropic или совместимый с OpenAI.",
};

const CASE_ERROR: Record<Exclude<SaveCaseResult, { ok: true }>["reason"], string> = {
  incomplete: "Укажите заказчика и название дела.",
  missing: "Заказчик не найден.",
};

const DRAFT_ERROR: Record<Exclude<DraftDossierResult, { ok: true }>["reason"], string> = {
  incomplete: "Вставьте текст хотя бы одного слоя и выберите ключ.",
  missing: "Дело или ключ не найдены.",
  timeout: "Модель не ответила вовремя.",
  model: "Модель не собрала черновик.",
  secret: "Секрет ключа не читается.",
};

const KEY_BODY_LIMIT = 64 * 1024;
const TEXT_BODY_LIMIT = 1024 * 1024;

/** Экранирует текст владельца, чтобы вставленный слой не стал разметкой. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1c1917; }
    label { display: block; margin: 0.8rem 0; }
    input, select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.4rem; }
    textarea { min-height: 6rem; }
    button { margin-top: 0.5rem; padding: 0.45rem 0.8rem; }
    .error { color: #9f1239; }
    nav a { margin-right: 1rem; }
    li { margin: 0.4rem 0; }
    pre { white-space: pre-wrap; font: inherit; }
    code { letter-spacing: 0.04em; }
    section { margin: 1.5rem 0; }
  </style>
</head>
<body>
  <nav><a href="/">Ключи</a><a href="/cases">Дела</a></nav>
  ${body}
</body>
</html>`;
}

function notice(error?: string): string {
  return error ? `<p class="error">${escapeHtml(error)}</p>` : "";
}

function characterLines(value: string): string[] {
  return value.split(/\r\n|\n|\r/);
}

function layersFrom(fields: URLSearchParams): DossierLayers {
  return {
    material: fields.get("material") ?? "",
    serviceLayer: fields.get("serviceLayer") ?? "",
    crib: fields.get("crib") ?? "",
  };
}

function casePath(id: string, suffix = ""): string {
  return `/cases/${encodeURIComponent(id)}${suffix}`;
}

/** Собирает страницу ключей. Секрет берётся только из уже скрытого списка. */
function renderKeys(keys: KeySummary[], error?: string): string {
  const items =
    keys.length === 0
      ? "<p>Ключей пока нет.</p>"
      : `<ul>${keys
          .map(
            (key) =>
              `<li><span>${escapeHtml(PROTOCOL_LABEL[key.protocol])}</span> <span>${escapeHtml(key.baseAddress)}</span> <span>${escapeHtml(key.modelName)}</span> <code>${escapeHtml(key.secretPreview)}</code></li>`,
          )
          .join("")}</ul>`;

  return page(
    "Ключи",
    `<h1>Ключи</h1>
  <p>Тренажёр открыт только на этом компьютере и не спрашивает пароль.</p>
  ${notice(error)}
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
  ${items}`,
  );
}

function renderProfile(profile: OwnerProfile): string {
  return `<section>
    <h2>Профиль</h2>
    <p>Резюме, портфолио и кейсы одни на владельца и общие для всех дел.</p>
    <form method="post" action="/profile">
      <label>Резюме
        <textarea name="resume">${escapeHtml(profile.resume)}</textarea>
      </label>
      <label>Портфолио
        <textarea name="portfolio">${escapeHtml(profile.portfolio)}</textarea>
      </label>
      <label>Кейсы
        <textarea name="cases">${escapeHtml(profile.cases)}</textarea>
      </label>
      <button type="submit">Сохранить профиль</button>
    </form>
  </section>`;
}

function renderCases(trainer: Trainer, error?: string): string {
  const customers = trainer.listCustomers();
  const cases = trainer.listCases();
  const items =
    cases.length === 0
      ? "<p>Дел пока нет.</p>"
      : `<ul>${cases
          .map(
            (item) =>
              `<li>${escapeHtml(item.customerName)} — <a href="${escapeHtml(casePath(item.id))}">${escapeHtml(item.title)}</a></li>`,
          )
          .join("")}</ul>`;
  const addCase =
    customers.length === 0
      ? "<p>Сначала заведите заказчика.</p>"
      : `<form method="post" action="/cases">
          <label>Заказчик
            <select name="customerId" required>
              ${customers
                .map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`)
                .join("")}
            </select>
          </label>
          <label>Название дела
            <input name="title" required>
          </label>
          <label>Персонажи заказчика, по одному в строке
            <textarea name="characters"></textarea>
          </label>
          <button type="submit">Добавить дело</button>
        </form>`;

  return page(
    "Дела",
    `<h1>Дела</h1>
    <p>Заказчик и первое дело заводятся вместе. Следующее дело остаётся у того же заказчика.</p>
    ${notice(error)}
    ${renderProfile(trainer.readProfile())}
    <section>
      <h2>Новый заказчик</h2>
      <form method="post" action="/customers">
        <label>Заказчик
          <input name="customerName" required>
        </label>
        <label>Название первого дела
          <input name="title" required>
        </label>
        <label>Персонажи заказчика, по одному в строке
          <textarea name="characters"></textarea>
        </label>
        <button type="submit">Завести заказчика и дело</button>
      </form>
    </section>
    <section>
      <h2>Ещё одно дело</h2>
      ${addCase}
    </section>
    <h2>Все дела</h2>
    ${items}`,
  );
}

function layerAreas(layers: DossierLayers): string {
  return `<label>Материал дела
      <textarea name="material">${escapeHtml(layers.material)}</textarea>
    </label>
    <label>Служебный слой
      <textarea name="serviceLayer">${escapeHtml(layers.serviceLayer)}</textarea>
    </label>
    <label>Шпаргалка дела
      <textarea name="crib">${escapeHtml(layers.crib)}</textarea>
    </label>`;
}

function approvedBlock(dossier: DossierRecord | undefined): string {
  if (!dossier) {
    return "<p>Утверждённого досье ещё нет. Сессия не открывается.</p>";
  }
  return `<section>
    <h2>Утверждённое досье</h2>
    <p>Сессия ещё не открывается. В диалог позже попадёт только этот текст.</p>
    <h3>Материал дела</h3>
    <pre>${escapeHtml(dossier.material)}</pre>
    <h3>Служебный слой</h3>
    <pre>${escapeHtml(dossier.serviceLayer)}</pre>
    <h3>Шпаргалка дела</h3>
    <pre>${escapeHtml(dossier.crib)}</pre>
  </section>`;
}

function renderCase(trainer: Trainer, item: CaseRecord, error?: string, paste?: DossierLayers & { keyId: string }): string {
  const keys = trainer.listKeys();
  const draftForm =
    keys.length === 0
      ? "<p>Сначала сохраните ключ.</p>"
      : `<form method="post" action="${escapeHtml(casePath(item.id, "/draft"))}">
          ${layerAreas(paste ?? { material: "", serviceLayer: "", crib: "" })}
          <label>Ключ
            <select name="keyId" required>
              ${keys
                .map(
                  (key) =>
                    `<option value="${escapeHtml(key.id)}"${key.id === paste?.keyId ? " selected" : ""}>${escapeHtml(PROTOCOL_LABEL[key.protocol])} — ${escapeHtml(key.modelName)}</option>`,
                )
                .join("")}
            </select>
          </label>
          <button type="submit">Собрать черновик</button>
        </form>`;

  return page(
    item.title,
    `<h1>${escapeHtml(item.customerName)} — ${escapeHtml(item.title)}</h1>
    <p>${escapeHtml(`Голоса заказчика: ${customerVoices(item.characters).join(", ")}`)}</p>
    <p>${escapeHtml(item.portfolioSent ? "Отметка «портфолио уже отправлено» стоит." : "Отметка «портфолио уже отправлено» снята.")}</p>
    ${notice(error)}
    ${approvedBlock(trainer.readApprovedDossier(item.id))}
    <section>
      <h2>Черновик</h2>
      <p>Вставьте тексты слоёв и выберите ключ. Черновик сессия не читает.</p>
      ${draftForm}
    </section>`,
  );
}

/** Страница правки. Утверждение записывает текст из этих полей, не ответ модели сам по себе. */
function renderDraft(item: CaseRecord, draft: DossierLayers): string {
  return page(
    item.title,
    `<h1>${escapeHtml(item.customerName)} — ${escapeHtml(item.title)}</h1>
    <p>Черновик. Сессия его не читает, пока текст не поправлен и не утверждён.</p>
    <form method="post" action="${escapeHtml(casePath(item.id, "/approve"))}">
      ${layerAreas(draft)}
      <button type="submit">Утвердить досье</button>
    </form>`,
  );
}

/** Читает тело формы и не держит в памяти больше заданного предела. */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

function knownKeyError(reason: string | null): string | undefined {
  if (reason === "incomplete" || reason === "protocol") {
    return KEY_ERROR[reason];
  }
  return undefined;
}

function knownCaseError(reason: string | null): string | undefined {
  if (reason === "incomplete" || reason === "missing") {
    return CASE_ERROR[reason];
  }
  return undefined;
}

function knownDraftError(reason: string | null): string | undefined {
  if (
    reason === "incomplete" ||
    reason === "missing" ||
    reason === "timeout" ||
    reason === "model" ||
    reason === "secret"
  ) {
    return DRAFT_ERROR[reason];
  }
  return undefined;
}

/** Страницу открывают только с этого компьютера, по адресу, который реально слушает сервер. */
function allowsHost(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== "string") {
    return false;
  }
  const value = host.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

/** Свой Origin и запрос без Origin проходят. Чужой Origin запись не делает. */
function allowsFormPost(origin: string | string[] | undefined, port: number): boolean {
  if (origin === undefined) {
    return true;
  }
  if (Array.isArray(origin)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const originPort = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return (
    url.protocol === "http:" &&
    originPort === String(port) &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  );
}

function caseTarget(pathname: string): { id: string; action?: CaseAction } | undefined {
  const match = pathname.match(/^\/cases\/([^/]+)(?:\/(draft|approve))?$/);
  const id = match?.[1];
  if (!id) {
    return undefined;
  }
  const action = match?.[2];
  if (action !== undefined && action !== "draft" && action !== "approve") {
    return undefined;
  }
  return { id: decodeURIComponent(id), action };
}

function refuse(request: IncomingMessage, response: ServerResponse, status: number): void {
  request.resume();
  response.writeHead(status);
  response.end();
}

/** Отвечает на ключи, дела и утверждение досье. Чужой Host и чужой Origin запись не открывают. */
async function handle(server: Server, trainer: Trainer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const address = server.address();
  const listenPort = address && typeof address === "object" ? address.port : undefined;
  if (listenPort === undefined || !allowsHost(request.headers.host, listenPort)) {
    refuse(request, response, 403);
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const target = caseTarget(url.pathname);

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, renderKeys(trainer.listKeys(), knownKeyError(url.searchParams.get("error"))));
    return;
  }

  if (request.method === "GET" && url.pathname === "/cases") {
    sendHtml(response, renderCases(trainer, knownCaseError(url.searchParams.get("error"))));
    return;
  }

  if (request.method === "GET" && target && target.action === undefined) {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    sendHtml(response, renderCase(trainer, item, knownDraftError(url.searchParams.get("error"))));
    return;
  }

  if (request.method !== "POST") {
    refuse(request, response, 404);
    return;
  }

  if (!allowsFormPost(request.headers.origin, listenPort)) {
    refuse(request, response, 403);
    return;
  }

  const limit = url.pathname === "/keys" ? KEY_BODY_LIMIT : TEXT_BODY_LIMIT;
  let body = "";
  try {
    body = await readBody(request, limit);
  } catch {
    response.writeHead(413);
    response.end();
    return;
  }
  const fields = new URLSearchParams(body);

  if (url.pathname === "/keys") {
    const saved = trainer.saveKey({
      protocol: fields.get("protocol") ?? "",
      baseAddress: fields.get("baseAddress") ?? "",
      modelName: fields.get("modelName") ?? "",
      secret: fields.get("secret") ?? "",
    });
    redirect(response, saved.ok ? "/" : `/?error=${saved.reason}`);
    return;
  }

  if (url.pathname === "/profile") {
    trainer.saveProfile({
      resume: fields.get("resume") ?? "",
      portfolio: fields.get("portfolio") ?? "",
      cases: fields.get("cases") ?? "",
    });
    redirect(response, "/cases");
    return;
  }

  if (url.pathname === "/customers") {
    const saved = trainer.saveCase({
      customerName: fields.get("customerName") ?? "",
      title: fields.get("title") ?? "",
      characters: characterLines(fields.get("characters") ?? ""),
    });
    redirect(response, saved.ok ? casePath(saved.caseRecord.id) : "/cases?error=incomplete");
    return;
  }

  if (url.pathname === "/cases") {
    const saved = trainer.addCase({
      customerId: fields.get("customerId") ?? "",
      title: fields.get("title") ?? "",
      characters: characterLines(fields.get("characters") ?? ""),
    });
    redirect(response, saved.ok ? casePath(saved.caseRecord.id) : `/cases?error=${saved.reason}`);
    return;
  }

  if (target?.action === "draft") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const paste = { ...layersFrom(fields), keyId: fields.get("keyId") ?? "" };
    const drafted = await trainer.draftDossier({ caseId: item.id, ...paste });
    if (!drafted.ok) {
      sendHtml(response, renderCase(trainer, item, DRAFT_ERROR[drafted.reason], paste));
      return;
    }
    sendHtml(response, renderDraft(item, drafted.draft));
    return;
  }

  if (target?.action === "approve") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const approved = trainer.approveDossier({ caseId: item.id, ...layersFrom(fields) });
    if (!approved.ok) {
      refuse(request, response, 404);
      return;
    }
    redirect(response, casePath(item.id));
    return;
  }

  refuse(request, response, 404);
}

/**
 * Веб-адаптер ядра.
 * Слушает только 127.0.0.1 и не проверяет пароль: дверь — учётная запись машины.
 * Сессию не открывает: после правки показывает утверждённое досье.
 */
export function startWeb(trainer: Trainer, port = 0): Promise<Server> {
  const server = createServer((request, response) => {
    handle(server, trainer, request, response).catch(() => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Не удалось записать.");
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
