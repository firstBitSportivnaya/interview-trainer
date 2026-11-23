import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  customerVoices,
  DRAFT_LIMIT,
  PERFORMER_ROLES,
  type ApproveDossierResult,
  type CaseRecord,
  type CustomerRecord,
  type AddSourceFileResult,
  type DossierLayerName,
  type DossierLayers,
  type DossierRecord,
  type DraftDossierResult,
  type KeyDraft,
  type KeySummary,
  type AcceptProposalResult,
  type DismissPreparationResult,
  type FinishSessionResult,
  type OpenSessionResult,
  type OwnerProfile,
  type PreparationEntry,
  type ReviewRecord,
  type SaveCaseResult,
  type SaveKeyResult,
  type SessionRecord,
  type SetPortfolioSentResult,
  type SourceFileRecord,
  type SpeechEvent,
  type TranscriptLine,
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
  addSourceFile(draft: {
    caseId: string;
    name: string;
    layer: string;
    extractedText: string;
  }): AddSourceFileResult;
  listSourceFiles(caseId: string): SourceFileRecord[];
  draftDossier(draft: { caseId: string; keyId: string } & DossierLayers): Promise<DraftDossierResult>;
  approveDossier(draft: { caseId: string } & DossierLayers): ApproveDossierResult;
  readApprovedDossier(caseId: string): DossierRecord | undefined;
  openSession(draft: {
    caseId: string;
    dossierId: string;
    side: string;
    character: string;
    role: string;
    executorId: string;
    keyId: string;
  }): OpenSessionResult;
  readSession(sessionId: string): SessionRecord | undefined;
  readTranscript(sessionId: string): TranscriptLine[] | undefined;
  readReview(sessionId: string): ReviewRecord | undefined;
  finishSession(sessionId: string): Promise<FinishSessionResult>;
  listSessions(): SessionRecord[];
  openingQuestion(sessionId: string, signal?: AbortSignal): AsyncIterable<SpeechEvent>;
  reply(sessionId: string, line: string, signal?: AbortSignal): AsyncIterable<SpeechEvent>;
  listOpenSessions(): SessionRecord[];
  setPortfolioSent(caseId: string, sent: boolean): SetPortfolioSentResult;
  readPreparationEntries(caseId: string, role: string, executorId: string): PreparationEntry[];
  readPreparationEntry(entryId: string): PreparationEntry | undefined;
  dismissPreparation(entryId: string): DismissPreparationResult;
  acceptProposal(entryId: string): AcceptProposalResult;
};

type CaseAction = "draft" | "approve" | "session" | "file" | "portfolio" | "preparation";
type SessionAction = "opening" | "ask" | "finish";

const PROTOCOL_LABEL: Record<KeySummary["protocol"], string> = {
  anthropic: "Anthropic",
  "openai-compatible": "совместимый с OpenAI",
};

const KEY_ERROR: Record<Exclude<SaveKeyResult, { ok: true }>["reason"], string> = {
  incomplete: "Заполните протокол, базовый адрес, имя модели и секрет.",
  protocol: "Выберите протокол Anthropic или совместимый с OpenAI.",
};

const CASE_ERROR: Record<Exclude<SaveCaseResult, { ok: true }>["reason"], string> = {
  incomplete: "Укажите заказчика и название проекта.",
  missing: "Заказчик не найден.",
};

const SESSION_ERROR: Record<Exclude<OpenSessionResult, { ok: true }>["reason"] | "character", string> = {
  incomplete: "Заполните проект, сторону, персонажа, роль исполнителя и ключ.",
  missing: "Проект, досье или ключ не найдены.",
  role: "Выберите роль исполнителя.",
  side: "Сессия этой страницы открывается на стороне заказчика.",
  open: "Сессия этой тройки уже открыта.",
  character: "Выберите персонажа заказчика.",
};

const DRAFT_ERROR: Record<Exclude<DraftDossierResult, { ok: true }>["reason"], string> = {
  incomplete: "Вставьте текст хотя бы одного слоя и выберите ключ.",
  missing: "Проект или ключ не найдены.",
  timeout: "Модель не ответила вовремя.",
  model: "Модель не собрала черновик.",
  secret: "Секрет ключа не читается.",
};

const FILE_ERROR: Record<Exclude<AddSourceFileResult, { ok: true }>["reason"], string> = {
  layer: "Выберите слой. Тренажёр слой не назначает сам.",
  incomplete: "Укажите имя файла и извлечённый текст.",
  missing: "Проект не найден.",
};

const LAYER_LABEL: Record<DossierLayerName, string> = {
  material: "Материал проекта",
  serviceLayer: "Служебный слой",
  crib: "Шпаргалка проекта",
};

const KEY_BODY_LIMIT = 64 * 1024;
/** Байт на знак в теле формы: три байта UTF-8, каждый как `%XX`. Плюс имена полей. */
const FORM_CHAR_BYTES = 9;
const FORM_OVERHEAD = 512;
/** Тело утверждения вмещает любой черновик, который ядро согласилось показать. */
export const TEXT_BODY_LIMIT = DRAFT_LIMIT * FORM_CHAR_BYTES + FORM_OVERHEAD;

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
    pre, #live { white-space: pre-wrap; font: inherit; }
    code { letter-spacing: 0.04em; }
    section { margin: 1.5rem 0; }
    ol { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <nav><a href="/">Ключи</a><a href="/cases">Проекты</a></nav>
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
    <p>Резюме, портфолио и кейсы одни на владельца и общие для всех проектов.</p>
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
      ? "<p>Проектов пока нет.</p>"
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
          <label>Название проекта
            <input name="title" required>
          </label>
          <label>Персонажи заказчика, по одному в строке
            <textarea name="characters"></textarea>
          </label>
          <button type="submit">Добавить проект</button>
        </form>`;

  return page(
    "Проекты",
    `<h1>Проекты</h1>
    <p>Заказчик и первый проект заводятся вместе. Следующий проект остаётся у того же заказчика.</p>
    ${notice(error)}
    ${renderProfile(trainer.readProfile())}
    <section>
      <h2>Новый заказчик</h2>
      <form method="post" action="/customers">
        <label>Заказчик
          <input name="customerName" required>
        </label>
        <label>Название первого проекта
          <input name="title" required>
        </label>
        <label>Персонажи заказчика, по одному в строке
          <textarea name="characters"></textarea>
        </label>
        <button type="submit">Завести заказчика и проект</button>
      </form>
    </section>
    <section>
      <h2>Ещё один проект</h2>
      ${addCase}
    </section>
    <h2>Все проекты</h2>
    ${items}`,
  );
}

function layerAreas(layers: DossierLayers): string {
  return `<label>Материал проекта
      <textarea name="material">${escapeHtml(layers.material)}</textarea>
    </label>
    <label>Служебный слой
      <textarea name="serviceLayer">${escapeHtml(layers.serviceLayer)}</textarea>
    </label>
    <label>Шпаргалка проекта
      <textarea name="crib">${escapeHtml(layers.crib)}</textarea>
    </label>`;
}

function approvedBlock(trainer: Trainer, item: CaseRecord, sessionError?: string): string {
  const dossier = trainer.readApprovedDossier(item.id);
  if (!dossier) {
    return "<p>Утверждённого досье ещё нет. Сессия не открывается.</p>";
  }
  const keys = trainer.listKeys();
  const voices = customerVoices(item.characters);
  const sessions = trainer.listSessions().filter((session) => session.caseId === item.id);
  const links =
    sessions.length === 0
      ? ""
      : `<ul>${sessions
          .map((session) => {
            const label = session.status === "finished" ? "Разбор" : "Стенограмма";
            return `<li><a href="/sessions/${encodeURIComponent(session.id)}">${label}: ${escapeHtml(session.character)}, ${escapeHtml(session.role)}</a></li>`;
          })
          .join("")}</ul>`;
  const form =
    keys.length === 0
      ? "<p>Сначала сохраните ключ.</p>"
      : `<form method="post" action="${escapeHtml(casePath(item.id, "/session"))}">
          <label>Сторона
            <select name="side" required>
              <option value="заказчик">заказчик</option>
            </select>
          </label>
          <label>Персонаж
            <select name="character" required>
              ${voices.map((voice) => `<option value="${escapeHtml(voice)}">${escapeHtml(voice)}</option>`).join("")}
            </select>
          </label>
          <label>Роль исполнителя
            <select name="role" required>
              ${PERFORMER_ROLES.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`).join("")}
            </select>
          </label>
          <label>Ключ
            <select name="keyId" required>
              ${keys
                .map(
                  (key) =>
                    `<option value="${escapeHtml(key.id)}">${escapeHtml(PROTOCOL_LABEL[key.protocol])} — ${escapeHtml(key.modelName)}</option>`,
                )
                .join("")}
            </select>
          </label>
          <button type="submit">Открыть сессию</button>
        </form>`;
  return `<section>
    <h2>Утверждённое досье</h2>
    <h3>Материал проекта</h3>
    <pre>${escapeHtml(dossier.material)}</pre>
    <h3>Служебный слой</h3>
    <pre>${escapeHtml(dossier.serviceLayer)}</pre>
    <h3>Шпаргалка проекта</h3>
    <pre>${escapeHtml(dossier.crib)}</pre>
    <h2>Сессия</h2>
    <p>Сессия читает это досье. Персонаж заказчика отвечает по материалу проекта.</p>
    ${notice(sessionError)}
    ${form}
    ${links}
  </section>`;
}

const ENTRY_LABEL: Record<PreparationEntry["kind"], string> = {
  gap: "Пробел",
  watch: "Сигнал следить",
  divergence: "Расхождение",
  line: "Линия",
  proposal: "Правка",
};

/** Ход владельца по ролям. Снять можно сигнал и расхождение. Правку можно принять. */
function preparationBlock(trainer: Trainer, item: CaseRecord): string {
  const rows: string[] = [];
  for (const role of PERFORMER_ROLES) {
    const entries = trainer
      .readPreparationEntries(item.id, role, "владелец")
      .filter((entry) => entry.status === "open");
    for (const entry of entries) {
      const label = entry.layer === "serviceLayer" ? "Правка служебного слоя" : ENTRY_LABEL[entry.kind];
      const action =
        entry.kind === "watch" || entry.kind === "divergence"
          ? `<form method="post" action="${escapeHtml(casePath(item.id, "/preparation"))}">
              <input type="hidden" name="entryId" value="${escapeHtml(entry.id)}">
              <button type="submit" name="act" value="dismiss">Снять</button>
            </form>`
          : entry.kind === "proposal"
            ? `<form method="post" action="${escapeHtml(casePath(item.id, "/preparation"))}">
              <input type="hidden" name="entryId" value="${escapeHtml(entry.id)}">
              <button type="submit" name="act" value="accept">Принять правку</button>
            </form>`
            : "";
      rows.push(
        `<li><span>${escapeHtml(role)}</span> <span>${escapeHtml(label)}</span> <span>${escapeHtml(entry.text)}</span> ${action}</li>`,
      );
    }
  }
  const list = rows.length === 0 ? "<p>Ход подготовки пока пуст.</p>" : `<ul id="preparation">${rows.join("")}</ul>`;
  return `<section>
    <h2>Ход подготовки</h2>
    <p>Сигнал следить и расхождение снимает владелец. Пробел закрывает поздний разбор. Правка входит в досье после приёмки.</p>
    ${list}
  </section>`;
}

function transcriptList(lines: TranscriptLine[]): string {
  if (lines.length === 0) {
    return `<p id="empty-transcript">Стенограмма пока пуста.</p>`;
  }
  return `<ol id="transcript">${lines
    .map((line) => {
      const who = line.speaker === "персонаж" ? "Персонаж" : "Исполнитель";
      return `<li><span>${who}</span> ${escapeHtml(line.text)}</li>`;
    })
    .join("")}</ol>`;
}

/** Поток первого вопроса и вопрос исполнителя. Текст реплики в скрипт не подставляется. */
function sessionScript(sessionId: string, needsOpening: boolean): string {
  return `<script>
    const openingBox = document.getElementById("opening");
    const live = document.getElementById("live");
    const form = document.getElementById("ask");
    const field = form.querySelector("textarea");
    const openingUrl = ${JSON.stringify(`/sessions/${encodeURIComponent(sessionId)}/opening`)};
    let asking = false;
    function remember(who, text) {
      if (!text) return;
      const empty = document.getElementById("empty-transcript");
      if (empty) empty.remove();
      let list = document.getElementById("transcript");
      if (!list) {
        list = document.createElement("ol");
        list.id = "transcript";
        openingBox.before(list);
      }
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = who;
      item.append(name, document.createTextNode(" " + text));
      list.append(item);
    }
    function consume(buffer, onEvent) {
      const parts = buffer.split("\\n\\n");
      const rest = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let name = "message";
        const data = [];
        for (const line of part.split("\\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        onEvent(name, data.join("\\n"));
      }
      return rest;
    }
    ${
      needsOpening
        ? `const source = new EventSource(openingUrl);
    let openingFailed = false;
    source.onmessage = (event) => openingBox.append(document.createTextNode(event.data));
    source.addEventListener("failure", (event) => {
      openingFailed = true;
      source.close();
      openingBox.textContent = event.data;
    });
    source.addEventListener("done", () => {
      source.close();
      if (openingFailed) return;
      const spoken = openingBox.textContent;
      openingBox.textContent = "";
      remember("Персонаж", spoken);
    });`
        : ""
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (asking) return;
      asking = true;
      const question = field.value;
      const body = new URLSearchParams(new FormData(form));
      fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/event-stream" },
        body,
      }).then(async (response) => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let failed = false;
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          pending += decoder.decode(step.value, { stream: true });
          pending = consume(pending, (name, data) => {
            if (name === "failure") {
              failed = true;
              live.textContent = data;
            } else if (name === "message") live.append(document.createTextNode(data));
          });
        }
        if (!failed) {
          remember("Исполнитель", question);
          const answer = live.textContent;
          live.textContent = "";
          remember("Персонаж", answer);
          field.value = "";
        }
        asking = false;
      }).catch(() => {
        asking = false;
      });
    });
  </script>`;
}

function renderSession(trainer: Trainer, session: SessionRecord, error?: string): string {
  const item = trainer.readCase(session.caseId);
  const lines = trainer.readTranscript(session.id) ?? [];
  const review = trainer.readReview(session.id);
  const key = trainer.listKeys().find((itemKey) => itemKey.id === session.keyId);
  const keyLabel = key ? `${PROTOCOL_LABEL[key.protocol]} — ${key.modelName}` : "ключ сессии не найден";
  const open = session.status === "open";
  const needsOpening = open && session.side === "заказчик" && !lines.some((line) => line.kind === "вопрос");
  const title = item ? `${item.customerName} — ${item.title}` : "Сессия";
  const talk = open
    ? `<div id="opening"></div>
    <div id="live"></div>
    <form id="ask" method="post" action="/sessions/${encodeURIComponent(session.id)}/ask">
      <label>Вопрос
        <textarea name="line" required></textarea>
      </label>
      <button type="submit">Спросить</button>
    </form>
    <form method="post" action="/sessions/${encodeURIComponent(session.id)}/finish">
      <button type="submit">Закончить сессию</button>
    </form>`
    : "";
  const reviewText = review
    ? `<h2>Разбор</h2>
    <pre id="review">${escapeHtml(review.text)}</pre>`
    : "";
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(`Сторона: ${session.side}. Персонаж: ${session.character}. Роль исполнителя: ${session.role}.`)}</p>
    <p>${escapeHtml(`Сессия помнит ключ: ${keyLabel}`)}</p>
    ${notice(error)}
    <h2>Стенограмма</h2>
    ${transcriptList(lines)}
    ${talk}
    ${reviewText}
    ${item ? `<p><a href="${escapeHtml(casePath(item.id))}">К проекту</a></p>` : ""}
    ${open ? sessionScript(session.id, needsOpening) : ""}`,
  );
}

/** Список файлов и форма слоя. Первый пункт списка пустой: слой не выбран заранее. */
function renderSourceFiles(trainer: Trainer, item: CaseRecord, error?: string): string {
  const files = trainer.listSourceFiles(item.id);
  const items =
    files.length === 0
      ? "<p>Файлов проекта пока нет.</p>"
      : `<ul>${files
          .map((file) => `<li>${escapeHtml(file.name)} — ${escapeHtml(LAYER_LABEL[file.layer])}</li>`)
          .join("")}</ul>`;
  const options = (Object.entries(LAYER_LABEL) as [DossierLayerName, string][])
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("");
  return `<section>
    <h2>Файлы проекта</h2>
    <p>Слой назначает владелец. Новый файл не меняет утверждённое досье и в сессию не попадает.</p>
    ${notice(error)}
    ${items}
    <form method="post" action="${escapeHtml(casePath(item.id, "/file"))}">
      <label>Имя файла
        <input name="name" required>
      </label>
      <label>Слой
        <select name="layer" required>
          <option value="">Выберите слой</option>
          ${options}
        </select>
      </label>
      <label>Извлечённый текст
        <textarea name="extractedText" required></textarea>
      </label>
      <button type="submit">Добавить файл</button>
    </form>
  </section>`;
}

function renderCase(
  trainer: Trainer,
  item: CaseRecord,
  error?: string,
  paste?: DossierLayers & { keyId: string },
  sessionError?: string,
  fileError?: string,
): string {
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
    <form method="post" action="${escapeHtml(casePath(item.id, "/portfolio"))}">
      <button type="submit" name="sent" value="1">Поставить отметку «портфолио уже отправлено»</button>
      <button type="submit" name="sent" value="0">Снять отметку «портфолио уже отправлено»</button>
    </form>
    ${notice(error)}
    ${renderSourceFiles(trainer, item, fileError)}
    ${preparationBlock(trainer, item)}
    ${approvedBlock(trainer, item, sessionError)}
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

function knownSessionError(reason: string | null): string | undefined {
  if (
    reason === "incomplete" ||
    reason === "missing" ||
    reason === "role" ||
    reason === "side" ||
    reason === "open" ||
    reason === "character"
  ) {
    return SESSION_ERROR[reason];
  }
  return undefined;
}

function knownFileError(reason: string | null): string | undefined {
  if (reason === "layer" || reason === "incomplete" || reason === "missing") {
    return FILE_ERROR[reason];
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
  const match = pathname.match(/^\/cases\/([^/]+)(?:\/(draft|approve|session|file|portfolio|preparation))?$/);
  const id = match?.[1];
  if (!id) {
    return undefined;
  }
  const action = match?.[2];
  if (
    action !== undefined &&
    action !== "draft" &&
    action !== "approve" &&
    action !== "session" &&
    action !== "file" &&
    action !== "portfolio" &&
    action !== "preparation"
  ) {
    return undefined;
  }
  return { id: decodeURIComponent(id), action };
}

function sessionTarget(pathname: string): { id: string; action?: SessionAction } | undefined {
  const match = pathname.match(/^\/sessions\/([^/]+)(?:\/(opening|ask|finish))?$/);
  const id = match?.[1];
  if (!id) {
    return undefined;
  }
  const action = match?.[2];
  if (action !== undefined && action !== "opening" && action !== "ask" && action !== "finish") {
    return undefined;
  }
  return { id: decodeURIComponent(id), action };
}

function wantsStream(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return value.includes("text/event-stream");
}

/** Пишет речь кусками. Отказ модели остаётся отдельным событием, не репликой. */
async function writeSpeech(
  response: ServerResponse,
  events: AsyncIterable<SpeechEvent>,
  signal: AbortSignal,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (!signal.aborted && !response.destroyed) {
      const step = await iterator.next();
      if (step.done || signal.aborted || response.destroyed) {
        break;
      }
      const event = step.value;
      const payload =
        event.kind === "speech"
          ? `${event.text.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`
          : `event: failure\ndata: ${event.message.replaceAll("\n", " ")}\n\n`;
      response.write(payload);
    }
    if (!signal.aborted && !response.writableEnded && !response.destroyed) {
      response.write("event: done\ndata: pause\n\n");
      response.end();
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Отдаёт поток речи и обрывает модель, когда клиент закрыл соединение.
 * Обычное завершение соединение закрывает само и модель повторно не обрывает.
 */
async function speak(
  request: IncomingMessage,
  response: ServerResponse,
  eventsFor: (signal: AbortSignal) => AsyncIterable<SpeechEvent>,
): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  request.on("aborted", stop);
  response.on("close", stop);
  try {
    await writeSpeech(response, eventsFor(controller.signal), controller.signal);
  } finally {
    request.off("aborted", stop);
    response.off("close", stop);
  }
}

function refuse(request: IncomingMessage, response: ServerResponse, status: number): void {
  request.resume();
  response.writeHead(status);
  response.end();
}

/** Отвечает на ключи, проекты и утверждение досье. Чужой Host и чужой Origin запись не открывают. */
async function handle(server: Server, trainer: Trainer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const address = server.address();
  const listenPort = address && typeof address === "object" ? address.port : undefined;
  if (listenPort === undefined || !allowsHost(request.headers.host, listenPort)) {
    refuse(request, response, 403);
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const target = caseTarget(url.pathname);
  const session = sessionTarget(url.pathname);

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
    sendHtml(
      response,
      renderCase(
        trainer,
        item,
        knownDraftError(url.searchParams.get("error")),
        undefined,
        knownSessionError(url.searchParams.get("sessionError")),
        knownFileError(url.searchParams.get("fileError")),
      ),
    );
    return;
  }

  if (request.method === "GET" && session?.action === "opening") {
    const open = trainer.readSession(session.id);
    if (!open) {
      refuse(request, response, 404);
      return;
    }
    await speak(request, response, (signal) => trainer.openingQuestion(open.id, signal));
    return;
  }

  if (request.method === "GET" && session && session.action === undefined) {
    const open = trainer.readSession(session.id);
    if (!open) {
      refuse(request, response, 404);
      return;
    }
    const failure = url.searchParams.get("error");
    const message =
      failure === "timeout" || failure === "model" || failure === "missing" || failure === "secret"
        ? {
            timeout: "Модель не ответила вовремя.",
            model: "Модель вернула ошибку.",
            missing: "Сессия не найдена.",
            secret: "Секрет ключа не читается.",
          }[failure]
        : undefined;
    sendHtml(response, renderSession(trainer, open, message));
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

  if (target?.action === "file") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const saved = trainer.addSourceFile({
      caseId: item.id,
      name: fields.get("name") ?? "",
      layer: fields.get("layer") ?? "",
      extractedText: fields.get("extractedText") ?? "",
    });
    redirect(response, saved.ok ? casePath(item.id) : `${casePath(item.id)}?fileError=${saved.reason}`);
    return;
  }

  if (target?.action === "portfolio") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const sent = fields.get("sent");
    if (sent === "1" || sent === "0") {
      trainer.setPortfolioSent(item.id, sent === "1");
    }
    redirect(response, casePath(item.id));
    return;
  }

  if (target?.action === "preparation") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const entry = trainer.readPreparationEntry((fields.get("entryId") ?? "").trim());
    const act = fields.get("act");
    if (entry && entry.caseId === item.id && entry.executorId === "владелец") {
      if (act === "dismiss") {
        trainer.dismissPreparation(entry.id);
      }
      if (act === "accept") {
        trainer.acceptProposal(entry.id);
      }
    }
    redirect(response, casePath(item.id));
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

  if (target?.action === "session") {
    const item = trainer.readCase(target.id);
    const dossier = item ? trainer.readApprovedDossier(item.id) : undefined;
    if (!item || !dossier) {
      refuse(request, response, 404);
      return;
    }
    const character = (fields.get("character") ?? "").trim();
    if (!customerVoices(item.characters).includes(character)) {
      redirect(response, `${casePath(item.id)}?sessionError=character`);
      return;
    }
    if ((fields.get("side") ?? "").trim() !== "заказчик") {
      redirect(response, `${casePath(item.id)}?sessionError=side`);
      return;
    }
    const opened = trainer.openSession({
      caseId: item.id,
      dossierId: dossier.id,
      side: "заказчик",
      character,
      role: fields.get("role") ?? "",
      executorId: "владелец",
      keyId: fields.get("keyId") ?? "",
    });
    redirect(response, opened.ok ? `/sessions/${encodeURIComponent(opened.session.id)}` : `${casePath(item.id)}?sessionError=${opened.reason}`);
    return;
  }

  if (session?.action === "finish") {
    const current = trainer.readSession(session.id);
    if (!current) {
      refuse(request, response, 404);
      return;
    }
    const finished = await trainer.finishSession(current.id);
    redirect(
      response,
      finished.ok || finished.reason === "finished"
        ? `/sessions/${encodeURIComponent(current.id)}`
        : `/sessions/${encodeURIComponent(current.id)}?error=${finished.reason}`,
    );
    return;
  }

  if (session?.action === "ask") {
    const open = trainer.readSession(session.id);
    if (!open) {
      refuse(request, response, 404);
      return;
    }
    const line = fields.get("line") ?? "";
    if (wantsStream(request.headers.accept)) {
      await speak(request, response, (signal) => trainer.reply(open.id, line, signal));
      return;
    }
    let failureReason: "timeout" | "model" | "missing" | "secret" | undefined;
    for await (const event of trainer.reply(open.id, line)) {
      if (event.kind === "failure") {
        failureReason = event.reason;
      }
    }
    redirect(
      response,
      failureReason
        ? `/sessions/${encodeURIComponent(open.id)}?error=${failureReason}`
        : `/sessions/${encodeURIComponent(open.id)}`,
    );
    return;
  }

  refuse(request, response, 404);
}

/**
 * Веб-адаптер ядра.
 * Слушает только 127.0.0.1 и не проверяет пароль: дверь — учётная запись машины.
 * Открывает сессию стороны заказчика и отдаёт речь модели потоком.
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
