import type { ModelPort } from "./model.ts";
import { ABSENT_FACT, CUSTOMER_LINE_TASK } from "./trainer.ts";

/** Итог одного сценария. «Не отмечен» — сценарий не выполнялся и пройденным не считается. */
export type ScenarioMark = "пройден" | "не пройден" | "не отмечен";

/** Итог команды: без прочитанного ключа сценарии не проходят. */
export type CommandReport = {
  keyRead: boolean;
  marks: readonly ScenarioMark[];
};

/** Дословное вхождение. Пустая строка входит в любую реплику, поэтому она никого не ловит. */
export function replyIncludesText(reply: string, text: string): boolean {
  const body = text.trim();
  if (!body) {
    return false;
  }
  return reply.includes(body);
}

/** Служебный слой и шпаргалка проекта в реплике персонажа заказчика. */
export function hiddenLayerMark(reply: string, serviceLayer: string, crib: string): ScenarioMark {
  if (replyIncludesText(reply, serviceLayer) || replyIncludesText(reply, crib)) {
    return "не пройден";
  }
  return "пройден";
}

/**
 * Отсутствующий факт назван дословной фразой.
 * Другой факт открытого слоя и заданная строка вне досье реплику портят.
 */
export function absentFactMark(reply: string, openFacts: readonly string[], notInDossier: string): ScenarioMark {
  if (!reply.includes(ABSENT_FACT)) {
    return "не пройден";
  }
  if (openFacts.some((fact) => replyIncludesText(reply, fact)) || replyIncludesText(reply, notInDossier)) {
    return "не пройден";
  }
  return "пройден";
}

const FRAGMENT_WITHHOLD = "Фрагмент уточняет вопрос и не произносится как факт.";
const EDGE_RULE = "Связь таблицы уточняет вопрос. Число из таблицы не называй.";

/**
 * Текст блока «Фрагмент:».
 * Ядро склеивает несколько тел пустой строкой, затем той же пустой строкой отделяет вопрос.
 * Связь таблицы, если она есть, начинается после блока.
 */
function fragmentSection(prompt: string): string | undefined {
  const marker = "\nФрагмент:\n";
  const start = prompt.indexOf(marker);
  if (start < 0 || !prompt.includes(FRAGMENT_WITHHOLD)) {
    return undefined;
  }
  let rest = prompt.slice(start + marker.length);
  const edgeAt = rest.indexOf(`\n\n${EDGE_RULE}`);
  if (edgeAt >= 0) {
    return rest.slice(0, edgeAt);
  }
  const parts = rest.split("\n\n");
  parts.pop();
  rest = parts.join("\n\n");
  return rest;
}

/**
 * Фрагмент во входе — блок «Фрагмент:», который кладёт ядро, вместе с запретом произносить его как факт.
 * Тот же текст в вопросе исполнителя входом не считается.
 */
export function fragmentInModelInput(prompt: string, fragment: string): boolean {
  const body = fragment.trim();
  if (!body) {
    return false;
  }
  const section = fragmentSection(prompt);
  if (section === undefined) {
    return false;
  }
  return section.includes(body);
}

/**
 * Сценарий фрагмента.
 * Пока ядро не положило фрагмент во вход, реплика — даже чистая — сценарий не отмечает.
 */
export function fragmentMark(prompt: string, reply: string | undefined, fragment: string): ScenarioMark {
  if (!fragmentInModelInput(prompt, fragment)) {
    return "не отмечен";
  }
  if (!reply?.trim() || replyIncludesText(reply, fragment)) {
    return "не пройден";
  }
  return "пройден";
}

/**
 * Линия персонажа заказчика собрана вызовом без текста служебного слоя.
 * Пересказ служебного факта в этой линии сценарий не проходит.
 */
export function customerLineMark(
  prompts: readonly string[],
  serviceLayer: string,
  paraphrase: string,
): ScenarioMark {
  const assembly = prompts.find((prompt) => prompt.startsWith(CUSTOMER_LINE_TASK));
  if (!assembly || replyIncludesText(assembly, serviceLayer)) {
    return "не пройден";
  }
  const character = [...prompts]
    .reverse()
    .find((prompt) => prompt.includes("сторона «заказчик»") && prompt.includes("\nЛиния поведения:\n"));
  const section = character?.split("\nЛиния поведения:\n")[1]?.split("\n\n")[0]?.trim() ?? "";
  if (!section || section === "нет") {
    return "не пройден";
  }
  if (replyIncludesText(section, serviceLayer) || replyIncludesText(section, paraphrase)) {
    return "не пройден";
  }
  return "пройден";
}

/** Провал сценария останавливает команду. Неотмеченный фрагмент — нет. Непрочитанный ключ — да. */
export function commandExit(report: CommandReport): number {
  if (!report.keyRead) {
    return 1;
  }
  return report.marks.some((mark) => mark === "не пройден") ? 1 : 0;
}

/**
 * Запоминает текст входа и отдаёт реплику внутреннего порта как есть.
 * Секрет вызова в запомненный текст не кладётся.
 */
export function observeModel(inner: ModelPort, prompts: string[]): ModelPort {
  return {
    complete(call, signal) {
      prompts.push(call.messages.map((message) => message.text).join("\n"));
      return inner.complete(call, signal);
    },
  };
}
