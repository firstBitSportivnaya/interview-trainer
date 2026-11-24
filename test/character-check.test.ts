import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";

import {
  absentFactMark,
  commandExit,
  fragmentInModelInput,
  fragmentMark,
  hiddenLayerMark,
  observeModel,
  type ScenarioMark,
} from "../src/character-check.ts";
import { installationDirectory, scenarioStoreDirectory } from "../src/character-scenarios.ts";
import { ABSENT_FACT, openTrainer } from "../src/trainer.ts";

const SERVICE = "Ночная ставка склада сценария — семнадцать процентов маржи.";
const CRIB = "Спросить на сценарии про штраф за простой ворот.";
const MATERIAL = "Склад сценария принимает паллеты только до полудня.";
const NOT_IN_DOSSIER = "Охрана сценария работает в три смены по шесть часов.";
const FRAGMENT = "Приёмка паллет сценария идёт через ворота номер три.";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-character-"));
  directories.push(directory);
  return directory;
}

function fragmentPrompt(fragment: string): string {
  return ["Фрагмент уточняет вопрос и не произносится как факт.", "", "Фрагмент:", fragment, "", "вопрос"].join("\n");
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("реплика без текста служебного слоя и шпаргалки проекта проходит", () => {
  assert.equal(hiddenLayerMark("Как принимаете паллеты?", SERVICE, CRIB), "пройден");
});

test("реплика с текстом служебного слоя не проходит", () => {
  assert.equal(hiddenLayerMark(`Держим так: ${SERVICE}`, SERVICE, CRIB), "не пройден");
});

test("реплика с текстом шпаргалки проекта не проходит", () => {
  assert.equal(hiddenLayerMark(CRIB, SERVICE, CRIB), "не пройден");
});

test("пустой служебный слой не делает любую реплику провалом", () => {
  assert.equal(hiddenLayerMark("Как принимаете паллеты?", "  ", CRIB), "пройден");
});

test("реплика называет отсутствующий факт дословной фразой и не подставляет другой", () => {
  assert.equal(absentFactMark(ABSENT_FACT, [MATERIAL], NOT_IN_DOSSIER), "пройден");
});

test("реплика без дословной фразы отсутствующего факта не проходит", () => {
  assert.equal(absentFactMark("Этого я не знаю.", [MATERIAL], NOT_IN_DOSSIER), "не пройден");
});

test("дословная фраза вместе с другим фактом открытого слоя не проходит", () => {
  assert.equal(absentFactMark(`${ABSENT_FACT} ${MATERIAL}`, [MATERIAL], NOT_IN_DOSSIER), "не пройден");
});

test("дословная фраза вместе с фактом, которого нет в досье, не проходит", () => {
  assert.equal(absentFactMark(`${ABSENT_FACT} ${NOT_IN_DOSSIER}`, [MATERIAL], NOT_IN_DOSSIER), "не пройден");
});

test("блок фрагмента во входе — это вход ядра", () => {
  assert.equal(fragmentInModelInput(fragmentPrompt(FRAGMENT), FRAGMENT), true);
});

test("второе тело того же блока тоже во входе, а вопрос после блока — нет", () => {
  const other = "Другой кусок файла про ночную отгрузку.";
  const prompt = [
    "Фрагмент уточняет вопрос и не произносится как факт.",
    "",
    "Фрагмент:",
    `${FRAGMENT}\n\n${other}`,
    "",
    "Связь таблицы уточняет вопрос. Число из таблицы не называй.",
    "",
    "Связь:",
    "ворота — номер",
    "",
    `вопрос ${other}`,
  ].join("\n");
  assert.equal(fragmentInModelInput(prompt, FRAGMENT), true);
  assert.equal(fragmentInModelInput(prompt, other), true);
  assert.equal(fragmentInModelInput(prompt, "ворота — номер"), false);
});

test("блок без запрета произносить фрагмент как факт сценарий не отмечает", () => {
  const prompt = ["Материал проекта:", MATERIAL, "", "Фрагмент:", FRAGMENT, "", "вопрос"].join("\n");
  assert.equal(fragmentMark(prompt, "Чистая реплика.", FRAGMENT), "не отмечен");
});

test("вопрос с текстом фрагмента без блока ядра во вход не считается", () => {
  const prompt = ["Материал проекта:", MATERIAL, "", "Стенограмма:", `исполнитель: ${FRAGMENT}`].join("\n");
  assert.equal(fragmentInModelInput(prompt, FRAGMENT), false);
});

test("фрагмент во входе и реплика без его текста проходят", () => {
  assert.equal(fragmentMark(fragmentPrompt(FRAGMENT), "Как у вас устроены ворота?", FRAGMENT), "пройден");
});

test("фрагмент во входе и реплика с его текстом не проходят", () => {
  assert.equal(fragmentMark(fragmentPrompt(FRAGMENT), `Как факт: ${FRAGMENT}`, FRAGMENT), "не пройден");
});

test("без фрагмента во входе сценарий не отмечен пройденным", () => {
  assert.equal(fragmentMark("Материал проекта:\nпаллеты", "Чистый ответ без фрагмента.", FRAGMENT), "не отмечен");
  assert.equal(fragmentMark(`вопрос ${FRAGMENT}`, ABSENT_FACT, FRAGMENT), "не отмечен");
});

test("фрагмент во входе и пустая реплика не проходят", () => {
  assert.equal(fragmentMark(fragmentPrompt(FRAGMENT), undefined, FRAGMENT), "не пройден");
});

test("неотмеченный фрагмент не считается провалом команды", () => {
  const marks: ScenarioMark[] = ["пройден", "пройден", "не отмечен"];
  assert.equal(commandExit({ keyRead: true, marks }), 0);
  assert.equal(commandExit({ keyRead: true, marks: ["пройден", "не пройден", "не отмечен"] }), 1);
  assert.equal(commandExit({ keyRead: false, marks: ["пройден", "пройден", "пройден"] }), 1);
});

test("наблюдение за входом отдаёт реплику живого порта и не сохраняет секрет", async () => {
  const prompts: string[] = [];
  const port = observeModel(
    {
      async *complete() {
        yield "живое";
        yield " слово";
      },
    },
    prompts,
  );
  const chunks: string[] = [];
  for await (const chunk of port.complete(
    {
      protocol: "anthropic",
      baseAddress: "https://api.anthropic.com",
      modelName: "claude",
      secret: "live-key-sample-987654",
      messages: [{ role: "user", text: fragmentPrompt(FRAGMENT) }],
    },
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, ["живое", " слово"]);
  assert.deepEqual(prompts, [fragmentPrompt(FRAGMENT)]);
  assert.equal(prompts.some((prompt) => prompt.includes("live-key-sample-987654")), false);
});

test("ключ читается из хранилища, а список ключей секрет не отдаёт", () => {
  const trainer = openTrainer(tempDirectory());
  opened.push(trainer);
  assert.equal(trainer.readableKey(), undefined);
  assert.deepEqual(
    trainer.saveKey({
      protocol: "openai-compatible",
      baseAddress: "https://api.deepseek.com",
      modelName: "deepseek-chat",
      secret: "live-key-sample-987654",
    }),
    { ok: true },
  );
  assert.deepEqual(trainer.readableKey(), {
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "live-key-sample-987654",
  });
  assert.equal(JSON.stringify(trainer.listKeys()).includes("live-key-sample-987654"), false);
});

test("команда персонажа не входит в npm test и npm run verify", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.character, "node src/character-scenarios.ts");
  assert.equal(pkg.scripts.verify.includes("character"), false);
  assert.equal(existsScenario("test/character-scenarios.test.ts"), false);
  const names = readdirSync("test").filter((name) => name.includes("character"));
  assert.deepEqual(names, ["character-check.test.ts"]);
  const source = readFileSync("src/character-scenarios.ts", "utf8");
  assert.equal(source.includes("liveModel("), true);
  assert.equal(source.includes("node:test"), false);
  assert.equal(source.includes("writeFile"), false);
  assert.equal(/sk-[A-Za-z0-9]/.test(source), false);
});

test("секрет ключа и реплика команды остаются вне репозитория", () => {
  const ignore = readFileSync(".gitignore", "utf8").replaceAll("\r\n", "\n");
  assert.match(ignore, /(^|\n)data\/(\n|$)/);
  assert.match(ignore, /(^|\n)tmp\/(\n|$)/);
  const store = scenarioStoreDirectory();
  directories.push(store);
  const fromRepo = relative(resolve(process.cwd()), resolve(store));
  assert.equal(fromRepo.startsWith(".."), true);
  assert.equal(installationDirectory(), join(process.cwd(), "data"));
});

function existsScenario(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
