import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ModelCall, type ModelPort } from "../src/model.ts";
import { openTrainer, type SpeechEvent } from "../src/trainer.ts";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

const EXECUTOR = "другой-исполнитель";
const HELD_DOSSIER = "ДЕРЖИТ-ДОСЬЕ";
const HELD_FILE = "ДЕРЖИТ-ФАЙЛ";
const LATER_DOSSIER = "НОВОЕ-ДОСЬЕ";
const LATER_FILE = "ПОЗДНИЙ-ФАЙЛ";
const FOREIGN_DOSSIER = "ЧУЖОЕ-ДОСЬЕ-КАССА";

const keyDraft = {
  protocol: "anthropic" as const,
  baseAddress: "https://api.anthropic.com",
  modelName: "claude-sonnet",
  secret: "sk-ant-api03-secret-WXYZ",
};

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-assignment-"));
  directories.push(directory);
  return directory;
}

function start(model?: ModelPort, directory = tempDirectory()) {
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

/** Записанная модель: во вход попадает то, что ядро ей отдало. */
function recorded(calls: ModelCall[]): ModelPort {
  return {
    async *complete(call) {
      calls.push({
        protocol: call.protocol,
        baseAddress: call.baseAddress,
        modelName: call.modelName,
        secret: call.secret,
        messages: call.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      yield "Как принимаете паллеты?";
    },
  };
}

function promptText(calls: ModelCall[]): string {
  return calls.map((call) => call.messages.map((message) => message.text).join("\n")).join("\n");
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prepare(
  trainer: ReturnType<typeof openTrainer>,
  title = "Внедрение склада",
  material = "Склад принимает паллеты.",
) {
  assert.deepEqual(trainer.saveKey(keyDraft), { ok: true });
  const keyId = trainer.listKeys().at(-1)?.id;
  assert.ok(keyId);
  const savedCase = trainer.saveCase({
    customerName: "Север",
    title,
    characters: ["Анна"],
  });
  assert.ok(savedCase.ok);
  const approved = trainer.approveDossier({
    caseId: savedCase.caseRecord.id,
    material,
    serviceLayer: "Маржа подрядчика 12%.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  return {
    keyId,
    caseId: savedCase.caseRecord.id,
    customerId: savedCase.caseRecord.customerId,
    dossierId: approved.dossier.id,
  };
}

function openFor(
  trainer: ReturnType<typeof openTrainer>,
  prepared: { caseId: string; dossierId: string; keyId: string },
  executorId: string,
  role = "аналитик",
) {
  return trainer.openSession({
    caseId: prepared.caseId,
    dossierId: prepared.dossierId,
    side: "заказчик",
    character: "Анна",
    role,
    executorId,
    keyId: prepared.keyId,
  });
}

test("назначенный исполнитель открывает сессию по этому проекту", () => {
  const trainer = start();
  const prepared = prepare(trainer);
  assert.deepEqual(trainer.assignExecutor({ executorId: EXECUTOR, caseId: prepared.caseId }), { ok: true });

  const openedSession = openFor(trainer, prepared, EXECUTOR);
  assert.ok(openedSession.ok);
  assert.equal(openedSession.session.status, "open");
  assert.equal(openedSession.session.executorId, EXECUTOR);
  assert.equal(openedSession.session.dossierId, prepared.dossierId);
});

test("без назначения сессия не открыта, и чужое досье не входит в модель", () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const assigned = prepare(trainer);
  const foreign = trainer.saveCase({ customerName: "Юг", title: "Касса", characters: ["Борис"] });
  assert.ok(foreign.ok);
  const foreignDossier = trainer.approveDossier({
    caseId: foreign.caseRecord.id,
    material: FOREIGN_DOSSIER,
    serviceLayer: "Чужая маржа.",
    crib: "Спросить про кассу.",
  });
  assert.ok(foreignDossier.ok);
  assert.deepEqual(trainer.assignExecutor({ executorId: EXECUTOR, caseId: assigned.caseId }), { ok: true });
  assert.deepEqual(
    trainer.assignExecutor({
      executorId: EXECUTOR,
      caseId: foreign.caseRecord.id,
      actorId: EXECUTOR,
    }),
    { ok: false, reason: "forbidden" },
  );

  const refused = trainer.openSession({
    caseId: foreign.caseRecord.id,
    dossierId: foreignDossier.dossier.id,
    side: "заказчик",
    character: "Борис",
    role: "аналитик",
    executorId: EXECUTOR,
    keyId: assigned.keyId,
  });
  assert.deepEqual(refused, { ok: false, reason: "assignment" });
  assert.equal(
    trainer.listOpenSessions().some((session) => session.caseId === foreign.caseRecord.id),
    false,
  );
  assert.equal(promptText(calls).includes(FOREIGN_DOSSIER), false);
});

test("владелец открывает сессию по своему проекту без назначения", () => {
  const trainer = start();
  const prepared = prepare(trainer);

  const openedSession = openFor(trainer, prepared, "владелец");
  assert.ok(openedSession.ok);
  assert.equal(openedSession.session.executorId, "владелец");
  assert.equal(openedSession.session.status, "open");
});

test("отзыв не трогает открытую сессию и закрывает следующее открытие", async () => {
  const calls: ModelCall[] = [];
  const trainer = start(recorded(calls));
  const prepared = prepare(trainer, "Внедрение склада", HELD_DOSSIER);
  assert.ok(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "протокол.xlsx",
      layer: "material",
      extractedText: HELD_FILE,
    }).ok,
  );
  assert.deepEqual(trainer.assignExecutor({ executorId: EXECUTOR, caseId: prepared.caseId }), { ok: true });
  const openedSession = openFor(trainer, prepared, EXECUTOR);
  assert.ok(openedSession.ok);

  assert.ok(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "позже.txt",
      layer: "material",
      extractedText: LATER_FILE,
    }).ok,
  );
  const later = trainer.approveDossier({
    caseId: prepared.caseId,
    material: LATER_DOSSIER,
    serviceLayer: LATER_DOSSIER,
    crib: LATER_DOSSIER,
  });
  assert.ok(later.ok);
  assert.deepEqual(
    trainer.revokeAssignment({ executorId: EXECUTOR, caseId: prepared.caseId, actorId: EXECUTOR }),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(trainer.revokeAssignment({ executorId: EXECUTOR, caseId: prepared.caseId }), { ok: true });

  const held = trainer.readSession(openedSession.session.id);
  assert.ok(held);
  assert.equal(held.status, "open");
  assert.equal(held.dossierId, prepared.dossierId);

  await take(trainer.openingQuestion(openedSession.session.id));
  const question = promptText(calls);
  assert.equal(question.includes(HELD_DOSSIER), true);
  assert.equal(question.includes(LATER_DOSSIER), false);

  const before = calls.length;
  const again = openFor(trainer, { ...prepared, dossierId: later.dossier.id }, EXECUTOR, "разработчик");
  assert.deepEqual(again, { ok: false, reason: "assignment" });
  assert.equal(calls.length, before);
  assert.equal(
    trainer.listOpenSessions().some((session) => session.role === "разработчик"),
    false,
  );

  const finished = await trainer.finishSession(openedSession.session.id);
  assert.ok(finished.ok);
  const review = calls.map((call) => call.messages.map((message) => message.text).join("\n")).find((text) => text.includes("Разбери законченную сессию"));
  assert.ok(review);
  assert.equal(review.includes(HELD_DOSSIER), true);
  assert.equal(review.includes(HELD_FILE), true);
  assert.equal(review.includes(LATER_DOSSIER), false);
  assert.equal(review.includes(LATER_FILE), false);
});

test("исполнитель, который не владелец, не меняет проект, слой, досье и ключ", () => {
  const trainer = start();
  const prepared = prepare(trainer);
  const casesBefore = trainer.listCases().length;
  const filesBefore = trainer.listSourceFiles(prepared.caseId).length;
  const keysBefore = trainer.listKeys().length;
  const dossierBefore = trainer.readApprovedDossier(prepared.caseId)?.id;

  assert.deepEqual(
    trainer.saveCase({ customerName: "Юг", title: "Касса", executorId: EXECUTOR }),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(
    trainer.addCase({ customerId: prepared.customerId, title: "Вторая касса", executorId: EXECUTOR }),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(
    trainer.addSourceFile({
      caseId: prepared.caseId,
      name: "чужой.txt",
      layer: "material",
      extractedText: "Чужой текст.",
      executorId: EXECUTOR,
    }),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(
    trainer.approveDossier({
      caseId: prepared.caseId,
      material: "Чужое досье.",
      serviceLayer: "Чужой слой.",
      crib: "Чужая шпаргалка.",
      executorId: EXECUTOR,
    }),
    { ok: false, reason: "forbidden" },
  );
  assert.deepEqual(
    trainer.saveKey({ ...keyDraft, secret: "sk-ant-api03-secret-FOREIGN", executorId: EXECUTOR }),
    { ok: false, reason: "forbidden" },
  );

  assert.equal(trainer.listCases().length, casesBefore);
  assert.equal(trainer.listSourceFiles(prepared.caseId).length, filesBefore);
  assert.equal(trainer.listKeys().length, keysBefore);
  assert.equal(trainer.readApprovedDossier(prepared.caseId)?.id, dossierBefore);
  assert.equal(trainer.listKeys().some((key) => key.secretPreview.includes("FORE")), false);
});
