import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  absentFactMark,
  commandExit,
  fragmentMark,
  hiddenLayerMark,
  observeModel,
  type CommandReport,
} from "./character-check.ts";
import { liveEncoder, localEmbeddings } from "./embeddings.ts";
import { liveModel } from "./model.ts";
import { openTrainer, type SpeechEvent } from "./trainer.ts";

const SERVICE = "Ночная ставка склада сценария — семнадцать процентов маржи.";
const CRIB = "Спросить на сценарии про штраф за простой ворот.";
const MATERIAL = "Склад сценария принимает паллеты только до полудня.";
const NOT_IN_DOSSIER = "Охрана сценария работает в три смены по шесть часов.";
const FRAGMENT = "Приёмка паллет сценария идёт через ворота номер три.";

const HIDDEN_QUESTION = "Как склад сценария принимает паллеты?";
const ABSENT_QUESTION = "В какие смены работает охрана склада?";
const FRAGMENT_QUESTION = "Через какие ворота идёт приёмка паллет?";

const MARK_NAMES = ["служебный слой и шпаргалка проекта", "отсутствующий факт", "фрагмент"] as const;

/** Каталог установки, где лежит ключ. Сам каталог в git не входит. */
export function installationDirectory(): string {
  return join(process.cwd(), "data");
}

/** Каталог сессии сценария. Он вне репозитория и после команды удаляется. */
export function scenarioStoreDirectory(): string {
  return mkdtempSync(join(tmpdir(), "character-scenarios-"));
}

/** Сессия не открылась: реплик нет, фрагмент во вход не попал. */
function failedReport(): CommandReport {
  return { keyRead: true, marks: ["не пройден", "не пройден", "не отмечен"] };
}

/** Реплика целиком. Сбой модели репликой не становится. */
async function spoken(events: AsyncIterable<SpeechEvent>): Promise<string | undefined> {
  let text = "";
  let failed = false;
  for await (const event of events) {
    if (event.kind === "failure") {
      failed = true;
      continue;
    }
    text += event.text;
  }
  if (failed || !text.trim()) {
    return undefined;
  }
  return text;
}

/**
 * Три сценария персонажа заказчика живым ключом установки.
 * Фрагмент отмечается, только если этот ход уже положил его во вход.
 */
export async function runCharacterScenarios(): Promise<CommandReport> {
  const owner = openTrainer(installationDirectory());
  let key: ReturnType<typeof owner.readableKey>;
  try {
    key = owner.readableKey();
  } finally {
    owner.close();
  }
  if (!key) {
    return { keyRead: false, marks: [] };
  }

  const directory = scenarioStoreDirectory();
  const prompts: string[] = [];
  try {
    const trainer = openTrainer(
      directory,
      observeModel(liveModel(), prompts),
      localEmbeddings(liveEncoder(join(installationDirectory(), "models", "multilingual-e5-small"))),
    );
    try {
      if (!trainer.saveKey(key).ok) {
        return failedReport();
      }
      const keyId = trainer.listKeys()[0]?.id;
      const savedCase = trainer.saveCase({
        customerName: "Сценарий",
        title: "Поведение персонажа",
      });
      if (!keyId || !savedCase.ok) {
        return failedReport();
      }
      const file = trainer.addSourceFile({
        caseId: savedCase.caseRecord.id,
        name: "gates.txt",
        layer: "material",
        extractedText: FRAGMENT,
      });
      const approved = trainer.approveDossier({
        caseId: savedCase.caseRecord.id,
        material: MATERIAL,
        serviceLayer: SERVICE,
        crib: CRIB,
      });
      if (!file.ok || !approved.ok) {
        return failedReport();
      }
      const openedSession = trainer.openSession({
        caseId: savedCase.caseRecord.id,
        dossierId: approved.dossier.id,
        side: "заказчик",
        character: "заказчик",
        role: "аналитик",
        executorId: "владелец",
        keyId,
      });
      if (!openedSession.ok) {
        return failedReport();
      }

      const sessionId = openedSession.session.id;
      const hidden = await ask(trainer, sessionId, HIDDEN_QUESTION, prompts);
      const absent = await ask(trainer, sessionId, ABSENT_QUESTION, prompts);
      const fragmentTurn = await ask(trainer, sessionId, FRAGMENT_QUESTION, prompts);
      return {
        keyRead: true,
        marks: [
          hidden.reply ? hiddenLayerMark(hidden.reply, SERVICE, CRIB) : "не пройден",
          absent.reply ? absentFactMark(absent.reply, [MATERIAL], NOT_IN_DOSSIER) : "не пройден",
          fragmentMark(fragmentTurn.prompt, fragmentTurn.reply, FRAGMENT),
        ],
      };
    } finally {
      trainer.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function ask(
  trainer: ReturnType<typeof openTrainer>,
  sessionId: string,
  line: string,
  prompts: string[],
): Promise<{ prompt: string; reply?: string }> {
  const start = prompts.length;
  const reply = await spoken(trainer.reply(sessionId, line));
  return { prompt: prompts.slice(start).at(-1) ?? "", reply };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function main(): Promise<number> {
  const report = await runCharacterScenarios();
  if (!report.keyRead) {
    console.log("Ключ в хранилище секретов не читается.");
    return commandExit(report);
  }
  report.marks.forEach((mark, index) => {
    const name = MARK_NAMES[index] ?? "сценарий";
    console.log(`${name}: ${mark}`);
  });
  return commandExit(report);
}

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exit(code);
    },
    () => {
      console.log("Команда персонажа не выполнилась.");
      process.exit(1);
    },
  );
}
