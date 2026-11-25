import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { acceptProjectFile } from "./project-file.ts";

import {
  customerVoices,
  DRAFT_LIMIT,
  OWNER_EXECUTOR_ID,
  PERFORMER_ROLES,
  type ApproveDossierResult,
  type CaseRecord,
  type CustomerRecord,
  type AddSourceFileResult,
  type NoteUnreadFileResult,
  type DossierLayerName,
  type DossierLayers,
  type DossierRecord,
  type DraftDossierResult,
  type KeyDraft,
  type KeySummary,
  type AcceptProposalResult,
  type AssignExecutorResult,
  type AssignmentRecord,
  type DismissPreparationResult,
  type FinishSessionResult,
  type OpenSessionResult,
  type OwnerProfile,
  type PreparationEntry,
  type ReviewRecord,
  type RevokeAssignmentResult,
  type SaveCaseResult,
  type SaveKeyResult,
  type SessionRecord,
  type SetPortfolioSentResult,
  type SourceFileRecord,
  type SpeechEvent,
  type TranscriptLine,
  type UnreadFileRecord,
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
  noteUnreadFile(draft: { caseId: string; name: string; executorId?: string }): NoteUnreadFileResult;
  listSourceFiles(caseId: string): SourceFileRecord[];
  draftDossier(
    draft: { caseId: string; keyId: string } & DossierLayers,
    onText?: (received: number) => void,
  ): Promise<DraftDossierResult>;
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
  assignExecutor(draft: { executorId: string; caseId: string; actorId?: string }): AssignExecutorResult;
  revokeAssignment(draft: { executorId: string; caseId: string; actorId?: string }): RevokeAssignmentResult;
  listUnreadFiles(caseId: string): UnreadFileRecord[];
  listAssignments(caseId: string): AssignmentRecord[];
};

type CaseAction = "draft" | "approve" | "session" | "file" | "portfolio" | "preparation" | "assignment";
type SessionAction = "opening" | "ask" | "finish";

const PROTOCOL_LABEL: Record<KeySummary["protocol"], string> = {
  anthropic: "Anthropic",
  "openai-compatible": "совместимый с OpenAI",
};

const KEY_ERROR: Record<Exclude<SaveKeyResult, { ok: true }>["reason"], string> = {
  incomplete: "Заполните протокол, базовый адрес, имя модели и секрет.",
  protocol: "Выберите протокол Anthropic или совместимый с OpenAI.",
  forbidden: "Ключ записывает владелец.",
};

const CASE_ERROR: Record<Exclude<SaveCaseResult, { ok: true }>["reason"], string> = {
  incomplete: "Укажите заказчика и название проекта.",
  missing: "Заказчик не найден.",
  forbidden: "Проект создаёт владелец.",
};

const SESSION_ERROR: Record<Exclude<OpenSessionResult, { ok: true }>["reason"] | "character", string> = {
  incomplete: "Заполните проект, сторону, персонажа, роль исполнителя и ключ.",
  missing: "Проект, досье или ключ не найдены.",
  role: "Выберите роль исполнителя.",
  side: "Сессия этой страницы открывается на стороне заказчика.",
  open: "Сессия этой тройки уже открыта.",
  assignment: "Назначения на этот проект нет.",
  character: "Выберите персонажа заказчика.",
};

const DRAFT_ERROR: Record<Exclude<DraftDossierResult, { ok: true }>["reason"], string> = {
  incomplete: "Вставьте текст хотя бы одного слоя и выберите ключ. Пустые поля и файлы без текста черновик не собирают.",
  missing: "Проект или ключ не найдены. Черновик не собирался.",
  timeout:
    "Модель не ответила вовремя: пауза между кусками ответа длиннее срока ожидания. Черновик не собран, досье не изменилось.",
  model:
    "Вызов не дошёл до текста черновика. Проверьте базовый адрес, имя модели и секрет на странице ключей, затем соберите черновик ещё раз. Текст ответа на страницу не выводится. Черновик не собран, досье не изменилось.",
  secret: "Секрет ключа не читается. Черновик не собирался.",
  limit: `Ответ модели длиннее ${DRAFT_LIMIT / 1024} КиБ. Черновик такой длины не записывается. Досье не изменилось.`,
  shape:
    "Ответ модели не является JSON с тремя строками: материал проекта, служебный слой и шпаргалка проекта. Текст ответа на страницу не выводится. Черновик не собран, досье не изменилось.",
};

const FILE_ERROR: Record<Exclude<AddSourceFileResult, { ok: true }>["reason"], string> = {
  layer: "Выберите слой. Тренажёр слой не назначает сам.",
  forbidden: "Слой файла называет владелец.",
  incomplete: "Выберите файл.",
  missing: "Проект не найден.",
};

const ASSIGNMENT_ERROR: Record<Exclude<AssignExecutorResult, { ok: true }>["reason"], string> = {
  incomplete: "Укажите исполнителя.",
  missing: "Назначения на этот проект нет.",
  forbidden: "Назначение записывает владелец.",
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
    .layers { list-style: none; padding: 0; margin: 1rem 0; }
    .layers li { display: grid; gap: 0.15rem; margin: 0; padding: 0.75rem 0; border-top: 1px solid #e7e5e4; overflow-wrap: anywhere; }
    .layers .meta { color: #57534e; }
    .steps { list-style: none; display: flex; gap: 0.5rem; padding: 0; margin: 0.4rem 0 0.8rem; }
    .steps li { flex: 1; margin: 0; padding: 0.55rem 0.7rem; border: 1px solid #d6d3d1; border-radius: 0.45rem; background: #fafaf9; color: #78716c; }
    .steps li.done { color: #44403c; border-color: #a8a29e; }
    .steps li.current { color: #1c1917; border-color: #1c1917; background: #fff; }
    .steps li.bad { color: #9f1239; border-color: #fda4af; background: #fff1f2; }
    #draft-count { font-variant-numeric: tabular-nums; color: #44403c; }
    .error-box { white-space: pre-wrap; margin: 0.8rem 0; padding: 0.8rem 1rem; border: 1px solid #fecdd3; border-radius: 0.45rem; background: #fff1f2; color: #9f1239; }
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
  const readNames = new Set(files.map((file) => file.name));
  // Имя в названном слое уже прочитано. Поздняя отметка без текста страницу не перебивает и текст слоя не стирает.
  const unread = trainer.listUnreadFiles(item.id).filter((file) => !readNames.has(file.name));
  const items =
    files.length === 0 && unread.length === 0
      ? "<p>Файлов проекта пока нет.</p>"
      : (Object.entries(LAYER_LABEL) as [DossierLayerName, string][])
          .map(([layer, label]) => {
            const own = files.filter((file) => file.layer === layer);
            const list =
              own.length === 0
                ? "<p>В этом слое файлов нет.</p>"
                : `<ul>${own
                    .map(
                      (file) =>
                        `<li>${escapeHtml(file.name)} — ${escapeHtml(label)}, ${file.extractedText.length} знаков</li>`,
                    )
                    .join("")}</ul>`;
            return `<h3>${escapeHtml(label)}</h3>${list}`;
          })
          .join("");
  const unreadItems =
    unread.length === 0
      ? ""
      : `<h3>Не прочитаны</h3><ul id="unread-files">${unread
          .map((file) => `<li>${escapeHtml(file.name)} — не прочитан</li>`)
          .join("")}</ul>`;
  const options = (Object.entries(LAYER_LABEL) as [DossierLayerName, string][])
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("");
  return `<section>
    <h2>Файлы проекта</h2>
    <p>Слой назначает владелец. Новый файл не меняет утверждённое досье и в сессию не попадает.</p>
    ${notice(error)}
    ${unreadItems}
    ${items}
    <form method="post" action="${escapeHtml(casePath(item.id, "/file"))}" enctype="multipart/form-data">
      <label>Файл
        <input name="file" type="file" required>
      </label>
      <label>Слой
        <select name="layer">
          <option value="">Выберите слой</option>
          ${options}
        </select>
      </label>
      <button type="submit">Добавить файл</button>
    </form>
  </section>`;
}

/** Запись и отзыв назначения. Строку хранит ядро, страница второго списка не заводит. */
function assignmentBlock(trainer: Trainer, item: CaseRecord, error?: string): string {
  const assignments = trainer.listAssignments(item.id);
  const items =
    assignments.length === 0
      ? "<p>Назначений пока нет.</p>"
      : `<ul id="assignments">${assignments
          .map((assignment) => `<li>${escapeHtml(assignment.executorId)}</li>`)
          .join("")}</ul>`;
  return `<section>
    <h2>Назначение</h2>
    <p>Владелец записывает назначение исполнителя на этот проект. Сессию по своему проекту владелец открывает без назначения. Отдельного входа для исполнителя, который не владелец, нет.</p>
    ${notice(error)}
    ${items}
    <form method="post" action="${escapeHtml(casePath(item.id, "/assignment"))}">
      <label>Исполнитель
        <input name="executorId" autocomplete="off">
      </label>
      <button type="submit" name="act" value="assign">Записать назначение</button>
      <button type="submit" name="act" value="revoke">Отозвать назначение</button>
    </form>
  </section>`;
}

function draftLines(trainer: Trainer, caseId: string, paste?: DossierLayers): string {
  const files = trainer.listSourceFiles(caseId);
  return (Object.entries(LAYER_LABEL) as [DossierLayerName, string][])
    .map(([layer, label]) => {
      const own = files.filter((file) => file.layer === layer);
      const pasted = (paste?.[layer] ?? "").trim().length;
      const fromFiles = own.reduce((sum, file) => sum + file.extractedText.length, 0);
      const names = own.length === 0 ? "файлов нет" : own.map((file) => file.name).join(", ");
      return `${label}: ${names}. Вставленный текст ${pasted} знаков, файлы ${fromFiles} знаков.`;
    })
    .join("\n");
}

function draftInventory(trainer: Trainer, caseId: string, paste?: DossierLayers): string {
  const files = trainer.listSourceFiles(caseId);
  const items = (Object.entries(LAYER_LABEL) as [DossierLayerName, string][])
    .map(([layer, label]) => {
      const own = files.filter((file) => file.layer === layer);
      const pasted = (paste?.[layer] ?? "").trim().length;
      const fromFiles = own.reduce((sum, file) => sum + file.extractedText.length, 0);
      const names = own.length === 0 ? "Файлов в этом слое нет." : own.map((file) => file.name).join(", ");
      return `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(names)}</span><span class="meta">Вставленный текст ${pasted} знаков. Файлы ${fromFiles} знаков.</span></li>`;
    })
    .join("");
  return `<ul class="layers" id="draft-plan">${items}</ul>`;
}

function draftFailureText(result: Exclude<DraftDossierResult, { ok: true }>, baseAddress?: string): string {
  if (result.reason !== "model" || !result.detail) return DRAFT_ERROR[result.reason];
  if (result.detail === "unreachable") {
    const address = baseAddress?.trim();
    const where = address ? `с базовым адресом ${address}` : "с базовым адресом ключа";
    return `Машина не соединилась ${where}: срок ожидания соединения вышел, ответа не было. Проверьте этот адрес на странице ключей и что с этой машины он открывается. Черновик не собран, досье не изменилось.`;
  }
  if (result.detail === "auth") {
    return "Секрет ключа не принят. Откройте страницу ключей и запишите секрет заново. Черновик не собран, досье не изменилось.";
  }
  if (result.detail === "name") {
    return "Имя модели или базовый адрес не найдены. Проверьте оба поля на странице ключей. Черновик не собран, досье не изменилось.";
  }
  if (result.detail === "busy") {
    return "Адрес ключа ответил, что сейчас занят. Подождите и соберите черновик ещё раз. Досье не изменилось.";
  }
  if (result.detail === "large") {
    return "Текст слоёв слишком большой для одного вызова. Уберите часть файлов или сократите вставленный текст и соберите черновик снова. Досье не изменилось.";
  }
  if (result.detail === "cut") {
    return "Ответ оборвался на потолке длины вывода. Черновик не собран, досье не изменилось.";
  }
  return "Вызов не принят. Проверьте имя модели и базовый адрес на странице ключей. Если они верны, сократите текст слоёв и соберите черновик снова. Досье не изменилось.";
}

/** Ход сборки черновика. Текст модели в страницу не подставляется. */
function draftScript(): string {
  return `<script>
    const draftForm = document.getElementById("draft");
    const draftRun = document.getElementById("draft-run");
    const draftStatus = document.getElementById("draft-status");
    const draftCount = document.getElementById("draft-count");
    const draftError = document.getElementById("draft-error");
    const draftButton = draftForm.querySelector("button");
    const steps = Array.from(document.querySelectorAll("#draft-steps li"));
    function mark(name) {
      let before = true;
      for (const step of steps) {
        step.classList.remove("current", "done", "bad");
        if (step.dataset.step === name) {
          step.classList.add("current");
          before = false;
        } else if (before) step.classList.add("done");
      }
    }
    function showFailure(text) {
      const current = steps.find((step) => step.classList.contains("current"));
      if (current) current.classList.add("bad");
      draftError.hidden = false;
      draftError.textContent = text;
      draftButton.disabled = false;
    }
    function takeEvents(buffer, onEvent) {
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
    draftForm.addEventListener("submit", (event) => {
      event.preventDefault();
      draftButton.disabled = true;
      draftRun.hidden = false;
      draftError.hidden = true;
      draftError.textContent = "";
      draftCount.hidden = true;
      draftCount.textContent = "";
      mark("pack");
      draftStatus.textContent = "Отправляю тексты слоёв.";
      const body = new URLSearchParams(new FormData(draftForm));
      fetch(draftForm.action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/event-stream" },
        body,
      }).then(async (response) => {
        if (!response.body) throw new Error("empty");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          pending += decoder.decode(step.value, { stream: true });
          pending = takeEvents(pending, (name, data) => {
            if (name === "status" && data.includes("Жду ответ")) {
              mark("wait");
              draftStatus.textContent = data;
            } else if (name === "progress") {
              mark("read");
              draftStatus.textContent = "Ответ идёт.";
              draftCount.hidden = false;
              draftCount.textContent = data;
            } else if (name === "failure") showFailure(data);
            else if (name === "page") {
              document.open();
              document.write(data);
              document.close();
            }
          });
        }
      }).catch(() => {
        showFailure("Страница не дождалась ответа. Соединение оборвалось. Черновик не собран, досье не изменилось.");
      });
    });
  </script>`;
}

function sse(response: ServerResponse, name: string, data: string): void {
  const lines = data.split("\n").map((line) => `data: ${line}`).join("\n");
  response.write(`event: ${name}\n${lines}\n\n`);
}

async function streamDraft(
  response: ServerResponse,
  trainer: Trainer,
  item: CaseRecord,
  paste: DossierLayers & { keyId: string },
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  sse(response, "status", draftLines(trainer, item.id, paste));
  sse(response, "status", "Жду ответ модели.");
  try {
    const drafted = await trainer.draftDossier({ caseId: item.id, ...paste }, (received) => {
      sse(response, "progress", `Ответ модели: ${received} знаков.`);
    });
    if (!drafted.ok) {
      const baseAddress = trainer.listKeys().find((key) => key.id === paste.keyId)?.baseAddress;
      sse(response, "failure", draftFailureText(drafted, baseAddress));
      response.end();
      return;
    }
    sse(response, "page", renderDraft(item, drafted.draft));
    response.end();
  } catch {
    if (!response.writableEnded) {
      sse(response, "failure", DRAFT_ERROR.model);
      response.end();
    }
  }
}

function renderCase(
  trainer: Trainer,
  item: CaseRecord,
  error?: string,
  paste?: DossierLayers & { keyId: string },
  sessionError?: string,
  fileError?: string,
  assignmentError?: string,
): string {
  const keys = trainer.listKeys();
  const draftForm =
    keys.length === 0
      ? "<p>Сначала сохраните ключ.</p>"
      : `<form id="draft" method="post" action="${escapeHtml(casePath(item.id, "/draft"))}">
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
        </form>
        ${draftScript()}`;

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
    ${assignmentBlock(trainer, item, assignmentError)}
    ${renderSourceFiles(trainer, item, fileError)}
    ${preparationBlock(trainer, item)}
    ${approvedBlock(trainer, item, sessionError)}
    <section>
      <h2>Черновик</h2>
      <p>В модель уходит вставленный текст и текст файлов того же слоя. Черновик сессия не читает.</p>
      ${draftInventory(trainer, item.id, paste)}
      <div id="draft-run" hidden>
        <ol id="draft-steps" class="steps">
          <li data-step="pack">Слои</li>
          <li data-step="wait">Ответ</li>
          <li data-step="read">Текст</li>
        </ol>
        <p id="draft-status"></p>
        <p id="draft-count" hidden></p>
        <p id="draft-error" class="error-box" hidden></p>
      </div>
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

/** Читает тело запроса и не держит в памяти больше заданного предела. */
async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

type UploadedForm = {
  fields: Map<string, string>;
  filename?: string;
  bytes: Buffer;
};

/** Разбирает одну форму с файлом. Чужой разборщик не подключается. */
function parseMultipart(body: Buffer, contentType: string): UploadedForm | undefined {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  let filename: string | undefined;
  let bytes = Buffer.alloc(0);
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    let cursor = start + delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString("utf8") === "--") break;
    if (body.subarray(cursor, cursor + 2).toString("utf8") === "\r\n") cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd < 0) return undefined;
    const headers = body.subarray(cursor, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next < 0) return undefined;
    const dataEnd = body.subarray(next - 2, next).toString("utf8") === "\r\n" ? next - 2 : next;
    const data = body.subarray(dataStart, dataEnd);
    const name = /name="([^"]*)"/.exec(headers)?.[1] ?? "";
    const fileName = partFilename(headers);
    if (fileName !== undefined) {
      filename = fileName;
      bytes = Buffer.from(data);
    } else if (name) {
      fields.set(name, data.toString("utf8"));
    }
    start = next;
  }
  return { fields, filename, bytes };
}

function partFilename(headers: string): string | undefined {
  const encoded = /filename\*=UTF-8''([^;\r\n]+)/i.exec(headers)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  const quoted = /filename="([^"]*)"/.exec(headers)?.[1];
  if (quoted !== undefined) return quoted;
  return undefined;
}

/** Кладёт файл страницы через чтение проекта. Слой берётся только из поля владельца. */
async function receiveProjectFile(
  trainer: Trainer,
  response: ServerResponse,
  caseId: string,
  raw: Buffer,
  contentType: string,
): Promise<void> {
  const item = trainer.readCase(caseId);
  if (!item) {
    response.writeHead(404);
    response.end();
    return;
  }
  const form = contentType.toLowerCase().includes("multipart/form-data") ? parseMultipart(raw, contentType) : undefined;
  const name = form?.filename?.trim() ?? "";
  if (!form || !name) {
    redirect(response, `${casePath(item.id)}?fileError=incomplete`);
    return;
  }
  const saved = await acceptProjectFile(trainer, {
    caseId: item.id,
    name,
    bytes: Uint8Array.from(form.bytes),
    layer: form.fields.get("layer") ?? "",
  });
  if (!saved.ok) {
    redirect(response, `${casePath(item.id)}?fileError=${saved.reason}`);
    return;
  }
  if (saved.ready && !saved.filed) {
    redirect(response, `${casePath(item.id)}?fileError=layer`);
    return;
  }
  redirect(response, casePath(item.id));
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
  if (reason === "incomplete" || reason === "protocol" || reason === "forbidden") {
    return KEY_ERROR[reason];
  }
  return undefined;
}

function knownCaseError(reason: string | null): string | undefined {
  if (reason === "incomplete" || reason === "missing" || reason === "forbidden") {
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
    reason === "assignment" ||
    reason === "character"
  ) {
    return SESSION_ERROR[reason];
  }
  return undefined;
}

function knownFileError(reason: string | null): string | undefined {
  if (reason === "layer" || reason === "incomplete" || reason === "missing" || reason === "forbidden") {
    return FILE_ERROR[reason];
  }
  return undefined;
}

function knownAssignmentError(reason: string | null): string | undefined {
  if (reason === "incomplete" || reason === "missing" || reason === "forbidden") {
    return ASSIGNMENT_ERROR[reason];
  }
  return undefined;
}

function knownDraftError(reason: string | null): string | undefined {
  if (
    reason === "incomplete" ||
    reason === "missing" ||
    reason === "timeout" ||
    reason === "model" ||
    reason === "secret" ||
    reason === "limit" ||
    reason === "shape"
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
  const match = pathname.match(
    /^\/cases\/([^/]+)(?:\/(draft|approve|session|file|portfolio|preparation|assignment))?$/,
  );
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
    action !== "preparation" &&
    action !== "assignment"
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
        knownAssignmentError(url.searchParams.get("assignmentError")),
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
  let raw: Buffer;
  try {
    raw = await readRawBody(request, limit);
  } catch {
    response.writeHead(413);
    response.end();
    return;
  }

  if (target?.action === "file") {
    await receiveProjectFile(trainer, response, target.id, raw, request.headers["content-type"] ?? "");
    return;
  }

  const fields = new URLSearchParams(raw.toString("utf8"));

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

  if (target?.action === "assignment") {
    const item = trainer.readCase(target.id);
    if (!item) {
      refuse(request, response, 404);
      return;
    }
    const executorId = fields.get("executorId") ?? "";
    const act = fields.get("act");
    if (act === "assign") {
      const assigned = trainer.assignExecutor({ executorId, caseId: item.id });
      redirect(
        response,
        assigned.ok ? casePath(item.id) : `${casePath(item.id)}?assignmentError=${assigned.reason}`,
      );
      return;
    }
    if (act === "revoke") {
      const revoked = trainer.revokeAssignment({ executorId, caseId: item.id });
      redirect(
        response,
        revoked.ok ? casePath(item.id) : `${casePath(item.id)}?assignmentError=${revoked.reason}`,
      );
      return;
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
    if (wantsStream(request.headers.accept)) {
      await streamDraft(response, trainer, item, paste);
      return;
    }
    const drafted = await trainer.draftDossier({ caseId: item.id, ...paste });
    if (!drafted.ok) {
      const baseAddress = trainer.listKeys().find((key) => key.id === paste.keyId)?.baseAddress;
      sendHtml(response, renderCase(trainer, item, draftFailureText(drafted, baseAddress), paste));
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
      executorId: OWNER_EXECUTOR_ID,
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
