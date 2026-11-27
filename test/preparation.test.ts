import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, type ModelPort } from "../src/model.ts";
import { openTrainer, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

const keyDraft = {
  protocol: "anthropic" as const,
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

const SERVICE = "Маржа подрядчика 12%.";
const WATCH = "СИГНАЛ-СЛЕДИТЬ: внутренняя оценка сроков";
const GAP = "Спросить про сроки.";
const LINE = `Давить на срок. ${WATCH}`;
const MATERIAL_FIX = "Склад принимает европаллеты.";
const SERVICE_FIX = "ПРАВКА-СЛУЖЕБНОГО: не называть маржу вслух";

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-preparation-"));
  directories.push(directory);
  return directory;
}

function start(model: ModelPort | undefined, directory = tempDirectory()) {
  const trainer = openTrainer(directory, model);
  opened.push(trainer);
  return trainer;
}

async function take(events: AsyncIterable<SpeechEvent>): Promise<SpeechEvent[]> {
  const list: SpeechEvent[] = [];
  for await (const event of events) {
    list.push(event);
  }
  return list;
}

function reviewText(facts: {
  gaps?: string[];
  covered?: string[];
  watch?: string[];
  divergence?: string[];
  line?: string;
  proposals?: { layer: "material" | "serviceLayer"; text: string }[];
}): string {
  return `Разбор без числовой оценки.\nХОД\n${JSON.stringify({
    gaps: facts.gaps ?? [],
    covered: facts.covered ?? [],
    watch: facts.watch ?? [],
    divergence: facts.divergence ?? [],
    line: facts.line ?? "",
    proposals: facts.proposals ?? [],
  })}`;
}

/** Записанная модель: разбор берётся из очереди, реплика персонажа — короткая. */
function recorded(calls: ModelCall[], reviews: string[]): ModelPort {
  return {
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      const text = call.messages[0]?.text ?? "";
      if (text.startsWith("Собери линию поведения персонажа заказчика.")) {
        const draft = text.split("\nЧерновик линии:\n")[1] ?? "";
        yield draft.trim();
        return;
      }
      if (text.includes("Разбери законченную сессию")) {
        yield reviews.shift() ?? reviewText({});
        return;
      }
      yield "Склад принимает паллеты.";
    },
  };
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prepare(trainer: ReturnType<typeof openTrainer>) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const savedCase = trainer.saveCase({
    customerName: "Север",
    title: "Внедрение склада",
    characters: ["Анна"],
  });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: SERVICE,
    crib: GAP,
  });
  assert.ok(approved.ok);
  return { keyId, caseId: savedCase.caseRecord.id, dossierId: approved.dossier.id };
}

async function rehearse(
  trainer: ReturnType<typeof openTrainer>,
  prepared: { keyId: string; caseId: string; dossierId: string },
  role: "аналитик" | "разработчик",
  side: "заказчик" | "внутренняя команда",
  line: string,
) {
  const openedSession = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side,
    character: side === "заказчик" ? "Анна" : "функциональный архитектор",
    role,
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(openedSession.ok);
  await take(trainer.reply(openedSession.session.id, line));
  const finished = await trainer.finishSession(openedSession.session.id);
  assert.ok(finished.ok);
  return openedSession.session.id;
}

test("ход подготовки отдельный у каждой тройки, чужая роль остаётся пустой", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(
    recorded(calls, [
      reviewText({
        gaps: [GAP],
        watch: [WATCH],
        divergence: ["Склад назван закрытым."],
        line: "Давить на срок.",
      }),
    ]),
  );
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "ПРОШЛАЯ-РЕПЛИКА");

  const analyst = trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец");
  assert.equal(analyst.some((entry) => entry.kind === "gap" && entry.text === GAP && entry.status === "open"), true);
  assert.deepEqual(trainer.readPreparationEntries(prepared.caseId, "разработчик", "владелец"), []);
  assert.deepEqual(trainer.readPreparationEntries(prepared.caseId, "аналитик", "другой"), []);
  assert.equal(trainer.readPreparation(prepared.caseId, "разработчик", "владелец"), undefined);

  const other = trainer.saveCase({ customerName: "Юг", title: "Касса" });
  assert.ok(other.ok);
  assert.deepEqual(trainer.readPreparationEntries(other.caseRecord.id, "аналитик", "владелец"), []);
});

test("следующая сессия читает ход и не получает прошлую стенограмму", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls, [reviewText({ line: "Давить на срок.", gaps: [GAP] })]));
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "ПРОШЛАЯ-РЕПЛИКА");

  const next = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(next.ok);
  await take(trainer.openingQuestion(next.session.id));
  const prompt = calls.at(-1)?.messages[0]?.text ?? "";
  assert.equal(prompt.includes("Давить на срок."), true);
  assert.equal(prompt.includes("ПРОШЛАЯ-РЕПЛИКА"), false);
  assert.equal(prompt.includes("Стенограмма:\nпока пусто"), true);
});

test("пробел закрывает поздний разбор, сигнал и расхождение остаются", async () => {
  const reviews: string[] = [
    reviewText({ gaps: [GAP], watch: [WATCH], divergence: ["Склад назван закрытым."] }),
  ];
  const trainer = start({
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (!text.includes("Разбери законченную сессию")) {
        yield "Склад принимает паллеты.";
        return;
      }
      const next = reviews.shift();
      if (next) {
        yield next;
        return;
      }
      const gapId = text.match(/Открытые пробелы:\n([0-9a-f-]+):/)?.[1];
      const watchId = text.match(/([0-9a-f-]{36})/)?.[1];
      if (!reviews.length && gapId && text.includes("Срок назван.")) {
        yield reviewText({ covered: ["Назвать срок внедрения.", gapId, watchId ?? ""] });
        return;
      }
      yield reviewText({ covered: ["Назвать срок внедрения."] });
    },
  });
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Срок не назван.");
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Другая формулировка.");
  assert.equal(
    trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец").find((entry) => entry.kind === "gap")?.status,
    "open",
  );
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Срок назван.");

  const entries = trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец");
  assert.equal(entries.find((entry) => entry.kind === "gap")?.status, "closed");
  assert.equal(entries.find((entry) => entry.kind === "watch")?.status, "open");
  assert.equal(entries.find((entry) => entry.kind === "divergence")?.status, "open");

  const watch = entries.find((entry) => entry.kind === "watch");
  const divergence = entries.find((entry) => entry.kind === "divergence");
  const gap = entries.find((entry) => entry.kind === "gap");
  assert.ok(watch && divergence && gap);
  assert.deepEqual(trainer.dismissPreparation(gap.id), { ok: false, reason: "kind" });
  assert.equal(trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец").find((entry) => entry.id === gap.id)?.status, "closed");
  assert.equal(trainer.dismissPreparation(watch.id).ok, true);
  assert.equal(trainer.dismissPreparation(divergence.id).ok, true);
  const left = trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец");
  assert.equal(left.find((entry) => entry.id === watch.id)?.status, "closed");
  assert.equal(left.find((entry) => entry.id === divergence.id)?.status, "closed");
  assert.deepEqual(trainer.dismissPreparation("нет-такой-записи"), { ok: false, reason: "missing" });
});

test("заказчик получает линию без служебного слоя, внутренняя команда читает ход целиком", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(
    recorded(calls, [
      reviewText({
        line: `${LINE} ${SERVICE_FIX}`,
        watch: [WATCH],
        gaps: [GAP],
        divergence: ["Склад назван закрытым."],
        proposals: [{ layer: "serviceLayer", text: SERVICE_FIX }],
      }),
      reviewText({}),
    ]),
  );
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "ПРОШЛАЯ-РЕПЛИКА");

  const customer = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(customer.ok);
  await take(trainer.openingQuestion(customer.session.id));
  const customerPrompt = calls.at(-1)?.messages[0]?.text ?? "";
  assert.equal(customerPrompt.includes("Давить на срок."), true);
  assert.equal(customerPrompt.includes(WATCH), false);
  assert.equal(customerPrompt.includes(SERVICE), false);
  assert.equal(customerPrompt.includes(SERVICE_FIX), false);
  assert.equal(customerPrompt.includes(GAP), false);

  const finished = await trainer.finishSession(customer.session.id);
  assert.ok(finished.ok);

  const internal = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "внутренняя команда",
    character: "функциональный архитектор",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(internal.ok);
  await take(trainer.openingQuestion(internal.session.id));
  const internalPrompt = calls.at(-1)?.messages[0]?.text ?? "";
  const log = internalPrompt.split("Ход подготовки:\n")[1]?.split("\n\nСлужебный слой:")[0] ?? "";
  assert.equal(log.includes("Давить на срок."), true);
  assert.equal(log.includes(WATCH), true);
  assert.equal(log.includes(SERVICE_FIX), true);
  assert.equal(log.includes(GAP), true);
  assert.equal(log.includes("Склад назван закрытым."), true);
});

test("правка входит в досье только после приёмки и не меняет открытую сессию", async () => {
  let modelCalls = 0;
  const trainer = start({
    async *complete(call) {
      modelCalls += 1;
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        yield reviewText({
          proposals: [
            { layer: "material", text: MATERIAL_FIX },
            { layer: "serviceLayer", text: SERVICE_FIX },
          ],
        });
        return;
      }
      yield "Склад принимает паллеты.";
    },
  });
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Паллета другая.");
  const callsAfterReview = modelCalls;

  const approvedBefore = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(approvedBefore);
  assert.equal(approvedBefore.material.includes(MATERIAL_FIX), false);
  assert.equal(approvedBefore.serviceLayer.includes(SERVICE_FIX), false);

  const open = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(open.ok);

  const entries = trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец");
  const material = entries.find((entry) => entry.kind === "proposal" && entry.layer === "material");
  const service = entries.find((entry) => entry.kind === "proposal" && entry.layer === "serviceLayer");
  assert.ok(material && service);
  assert.deepEqual(trainer.acceptProposal(material.id).ok, true);
  assert.equal(modelCalls, callsAfterReview);

  const accepted = trainer.readApprovedDossier(prepared.caseId);
  assert.ok(accepted);
  assert.notEqual(accepted.id, prepared.dossierId);
  assert.equal(accepted.material.includes("Склад принимает паллеты."), true);
  assert.equal(accepted.material.includes(MATERIAL_FIX), true);
  assert.equal(accepted.serviceLayer, SERVICE);
  assert.equal(trainer.readDossier(open.session.dossierId)?.material, "Склад принимает паллеты.");
  assert.equal(trainer.readSession(open.session.id)?.dossierId, prepared.dossierId);

  assert.equal(trainer.acceptProposal(service.id).ok, true);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.serviceLayer.includes(SERVICE_FIX), true);
  assert.equal(trainer.readDossier(open.session.dossierId)?.serviceLayer, SERVICE);
  assert.equal(modelCalls, callsAfterReview);
  assert.deepEqual(trainer.acceptProposal(material.id), { ok: false, reason: "kind" });
  assert.deepEqual(trainer.acceptProposal("нет-такой-записи"), { ok: false, reason: "missing" });
});

test("линия заказчика теряет отдельное предложение служебного слоя и после приёмки", async () => {
  const privateSentence = "Внутренняя оценка сроков секретна.";
  const proposal = "ПРАВКА-СЛУЖЕБНОГО: не называть маржу вслух.";
  const calls: ModelCall[] = [];
  const trainer = start({
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      const text = call.messages[0]?.text ?? "";
      if (text.startsWith("Собери линию поведения персонажа заказчика.")) {
        yield (text.split("\nЧерновик линии:\n")[1] ?? "").trim();
        return;
      }
      if (text.includes("Разбери законченную сессию")) {
        yield reviewText({
          line: `Давить на срок. ${privateSentence} ${proposal}`,
          proposals: [{ layer: "serviceLayer", text: proposal }],
        });
        return;
      }
      yield "Склад принимает паллеты.";
    },
  });
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);
  const savedCase = trainer.saveCase({ customerName: "Север", title: "Внедрение склада", characters: ["Анна"] });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: `Маржа подрядчика 12%. ${privateSentence}`,
    crib: GAP,
  });
  assert.ok(approved.ok);
  const prepared = { keyId, caseId: savedCase.caseRecord.id, dossierId: approved.dossier.id };
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Срок не назван.");

  const open = trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: prepared.keyId,
  });
  assert.ok(open.ok);
  await take(trainer.openingQuestion(open.session.id));
  const opening = calls.at(-1)?.messages[0]?.text ?? "";
  assert.equal(opening.includes("Давить на срок."), true);
  assert.equal(opening.includes(privateSentence), false);
  assert.equal(opening.includes(proposal), false);

  const entry = trainer
    .readPreparationEntries(prepared.caseId, "аналитик", "владелец")
    .find((item) => item.kind === "proposal");
  assert.ok(entry);
  assert.equal(trainer.acceptProposal(entry.id).ok, true);
  await take(trainer.reply(open.session.id, "Какой срок?"));
  const later = calls.at(-1)?.messages[0]?.text ?? "";
  assert.equal(later.includes(privateSentence), false);
  assert.equal(later.includes(proposal), false);
  assert.equal(later.includes("Давить на срок."), true);
  assert.equal(trainer.readSession(open.session.id)?.dossierId, prepared.dossierId);
});

test("разбор без блока хода и сбой разбора ход не меняют", async () => {
  const trainer = start({
    async *complete(call) {
      const text = call.messages[0]?.text ?? "";
      if (text.includes("Разбери законченную сессию")) {
        yield "Прозвучало служебное. Числовой оценки нет.";
        return;
      }
      yield "Склад принимает паллеты.";
    },
  });
  const prepared = prepare(trainer);
  await rehearse(trainer, prepared, "аналитик", "заказчик", "Коротко.");
  assert.deepEqual(trainer.readPreparationEntries(prepared.caseId, "аналитик", "владелец"), []);

  const broken = start({
    async *complete() {
      throw new Error("модель недоступна");
    },
  });
  const again = prepare(broken);
  const openedSession = broken.openSession({
    caseId: again.caseId,
    dossierId: again.dossierId,
    side: "заказчик",
    character: "Анна",
    role: "аналитик",
    executorId: "владелец",
    keyId: again.keyId,
  });
  assert.ok(openedSession.ok);
  const failed = await broken.finishSession(openedSession.session.id);
  assert.equal(failed.ok, false);
  assert.deepEqual(broken.readPreparationEntries(again.caseId, "аналитик", "владелец"), []);
  assert.equal(broken.readSession(openedSession.session.id)?.status, "open");
});
