import { inflateRawSync } from "node:zlib";

import {
  DOSSIER_LAYER_NAMES,
  type AddSourceFileResult,
  type DossierLayerName,
  type NoteUnreadFileResult,
  type SourceFileRecord,
  type SourcePlace,
  type UnreadFileRecord,
} from "./trainer.ts";

/**
 * Чтение файла проекта вне ядра.
 * Ядро получает текст и слой, который назвал владелец.
 * Пустой и нечитаемый файл остаётся без текста: абзац не сочиняется.
 */

export type ReadProjectFileResult =
  | { ready: true; text: string; places: SourcePlace[] }
  | { ready: false };

export type AcceptProjectFileResult =
  | { ok: true; ready: true; filed: true; file: SourceFileRecord }
  | { ok: true; ready: true; filed: false; text: string; places: SourcePlace[] }
  | { ok: true; ready: false; file: UnreadFileRecord }
  | { ok: false; reason: "incomplete" | "missing" | "forbidden" };

type ProjectFileStore = {
  addSourceFile(draft: {
    caseId: string;
    name: string;
    layer: string;
    extractedText: string;
    places?: readonly SourcePlace[];
    executorId?: string;
  }): AddSourceFileResult;
  noteUnreadFile(draft: { caseId: string; name: string; executorId?: string }): NoteUnreadFileResult;
};

const LAYER_LABEL: Record<DossierLayerName, string> = {
  material: "материал проекта",
  serviceLayer: "служебный слой",
  crib: "шпаргалка проекта",
};

/** Читает DOCX, PPTX, XLSX, TXT или PDF. Чужой формат и пустой текст неготовы. */
export function readProjectFile(name: string, bytes: Uint8Array): ReadProjectFileResult {
  try {
    switch (extension(name)) {
      case ".docx":
        return readOfficeText(bytes, readDocx);
      case ".pptx":
        return readOfficeText(bytes, readPptx);
      case ".xlsx":
        return readOfficeText(bytes, readXlsx);
      case ".txt":
        return readTxt(bytes);
      case ".pdf":
        return readPdf(bytes);
      default:
        return { ready: false };
    }
  } catch {
    return { ready: false };
  }
}

/**
 * Кладёт прочитанный файл в названный слой.
 * Без слоя файл никуда не входит. Непрочитанный остаётся без текста.
 */
export function acceptProjectFile(
  store: ProjectFileStore,
  draft: { caseId: string; name: string; bytes: Uint8Array; layer?: string; executorId?: string },
): AcceptProjectFileResult {
  const name = draft.name.trim();
  if (!name) {
    return { ok: false, reason: "incomplete" };
  }
  const read = readProjectFile(name, draft.bytes);
  if (!read.ready) {
    const noted = store.noteUnreadFile({ caseId: draft.caseId, name, executorId: draft.executorId });
    if (!noted.ok) {
      return noted;
    }
    return { ok: true, ready: false, file: noted.file };
  }
  const layer = ownerLayer(draft.layer);
  if (!layer) {
    return { ok: true, ready: true, filed: false, text: read.text, places: read.places };
  }
  const saved = store.addSourceFile({
    caseId: draft.caseId,
    name,
    layer,
    extractedText: read.text,
    places: read.places,
    executorId: draft.executorId,
  });
  if (!saved.ok) {
    if (saved.reason === "layer") {
      return { ok: true, ready: true, filed: false, text: read.text, places: read.places };
    }
    const reason: "incomplete" | "missing" | "forbidden" = saved.reason;
    return { ok: false, reason };
  }
  return { ok: true, ready: true, filed: true, file: saved.file };
}

/** Имя слоя от владельца. Имя файла слой не выбирает. */
function ownerLayer(layer: string | undefined): DossierLayerName | undefined {
  if (!layer) {
    return undefined;
  }
  const name = layer.trim().toLocaleLowerCase("ru-RU");
  if (!name) {
    return undefined;
  }
  for (const code of DOSSIER_LAYER_NAMES) {
    if (name === code.toLocaleLowerCase("ru-RU") || name === LAYER_LABEL[code]) {
      return code;
    }
  }
  return undefined;
}

function extension(name: string): string {
  const base = name.trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return base.slice(dot);
}

function readyText(text: string, places: SourcePlace[] = []): ReadProjectFileResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ready: false };
  }
  return { ready: true, text: trimmed, places };
}

function readOfficeText(
  bytes: Uint8Array,
  read: (files: Map<string, Uint8Array>) => ReadProjectFileResult,
): ReadProjectFileResult {
  const files = unzip(bytes);
  if (!files) {
    return { ready: false };
  }
  return read(files);
}

function readDocx(files: Map<string, Uint8Array>): ReadProjectFileResult {
  const xml = files.get("word/document.xml");
  if (!xml) {
    return { ready: false };
  }
  return readyText(docxText(decodeXmlBytes(xml)));
}

function readPptx(files: Map<string, Uint8Array>): ReadProjectFileResult {
  const slides = [...files.keys()]
    .map((name) => ({ name, slide: slideNumber(name) }))
    .filter((item): item is { name: string; slide: number } => item.slide !== undefined)
    .sort((left, right) => left.slide - right.slide);
  const lines: string[] = [];
  const places: SourcePlace[] = [];
  for (const slide of slides) {
    const xml = files.get(slide.name);
    if (!xml) {
      continue;
    }
    const text = xmlTexts(decodeXmlBytes(xml), "t").join("");
    if (!text.trim()) {
      continue;
    }
    lines.push(text);
    places.push({ slide: slide.slide });
  }
  return readyText(lines.join("\n"), places);
}

function readXlsx(files: Map<string, Uint8Array>): ReadProjectFileResult {
  const shared = sharedStrings(files.get("xl/sharedStrings.xml"));
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => sheetNumber(left) - sheetNumber(right));
  const lines: string[] = [];
  for (const name of sheets) {
    const xml = files.get(name);
    if (!xml) {
      continue;
    }
    lines.push(...sheetLines(decodeXmlBytes(xml), shared));
  }
  return readyText(lines.join("\n"));
}

function readTxt(bytes: Uint8Array): ReadProjectFileResult {
  const decoded = decodeText(bytes);
  if (decoded === undefined) {
    return { ready: false };
  }
  return readyText(decoded);
}

function readPdf(bytes: Uint8Array): ReadProjectFileResult {
  const parts: string[] = [];
  for (const stream of pdfStreams(Buffer.from(bytes))) {
    const text = textFromPdfContent(stream);
    if (text.trim()) {
      parts.push(text);
    }
  }
  return readyText(parts.join("\n"));
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2 !== 0) {
      return undefined;
    }
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2 !== 0) {
      return undefined;
    }
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1] ?? 0;
      swapped[index - 1] = bytes[index] ?? 0;
    }
    return swapped.toString("utf16le");
  }
  return decodeUtf8(bytes) ?? decodeWindows1251(bytes);
}

/** Windows-1251, если байты не UTF-8. Управляющие байты — это не текст, фразу из них не собираем. */
function decodeWindows1251(bytes: Uint8Array): string | undefined {
  let text = "";
  try {
    text = new TextDecoder("windows-1251").decode(bytes);
  } catch {
    return undefined;
  }
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      return undefined;
    }
  }
  return text;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function slideNumber(name: string): number | undefined {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 1) {
    return undefined;
  }
  return number;
}

function sheetNumber(name: string): number {
  const match = /sheet(\d+)\.xml$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function docxText(xml: string): string {
  const lines: string[] = [];
  for (const paragraph of xml.split(/<\/(?:[\w-]+:)?p>/)) {
    const line = xmlTexts(paragraph, "t").join("");
    if (line) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function sharedStrings(bytes: Uint8Array | undefined): string[] {
  if (!bytes) {
    return [];
  }
  const items: string[] = [];
  for (const part of decodeXmlBytes(bytes).split(/<\/(?:[\w-]+:)?si>/)) {
    if (!/<(?:[\w-]+:)?si[\s>]/.test(part)) {
      continue;
    }
    items.push(xmlTexts(part, "t").join(""));
  }
  return items;
}

function sheetLines(xml: string, shared: readonly string[]): string[] {
  const byRow = new Map<number, { column: number; text: string }[]>();
  for (const cell of xml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1] ?? "";
    const inner = cell[2] ?? "";
    const ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
    const row = ref ? Number(ref[2]) : 0;
    const column = ref ? columnIndex(ref[1] ?? "") : 0;
    const text = cellText(attrs, inner, shared);
    if (!text) {
      continue;
    }
    const line = byRow.get(row) ?? [];
    line.push({ column, text });
    byRow.set(row, line);
  }
  return [...byRow.keys()]
    .sort((left, right) => left - right)
    .map((row) =>
      (byRow.get(row) ?? [])
        .sort((left, right) => left.column - right.column)
        .map((cell) => cell.text)
        .join("\t"),
    );
}

function cellText(attrs: string, inner: string, shared: readonly string[]): string {
  const kind = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
  if (kind === "s") {
    const index = Number(/<v>(\d+)<\/v>/.exec(inner)?.[1] ?? "");
    return shared[index] ?? "";
  }
  if (kind === "inlineStr") {
    return xmlTexts(inner, "t").join("");
  }
  const value = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "";
  return decodeXml(value);
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

function xmlTexts(xml: string, localName: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${localName}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${localName}>`,
    "g",
  );
  const texts: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    texts.push(decodeXml(match[1] ?? ""));
  }
  return texts;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function decodeXmlBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** Центральный каталог ZIP. Несжатые и deflate-записи, без ZIP64. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  const data = Buffer.from(bytes);
  if (data.length < 22) {
    return undefined;
  }
  let eocd = -1;
  const start = Math.max(0, data.length - 22 - 0xffff);
  for (let index = data.length - 22; index >= start; index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    return undefined;
  }
  const count = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  const files = new Map<string, Uint8Array>();
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) {
      return undefined;
    }
    const method = data.readUInt16LE(cursor + 10);
    const compSize = data.readUInt32LE(cursor + 20);
    const nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30);
    const commentLen = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      return undefined;
    }
    const name = data.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
      return undefined;
    }
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > data.length) {
      return undefined;
    }
    const compressed = data.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      files.set(name, compressed);
    } else if (method === 8) {
      files.set(name, inflateRawSync(compressed));
    } else {
      return undefined;
    }
  }
  return files;
}

function pdfStreams(data: Buffer): Buffer[] {
  const latin = data.toString("latin1");
  const streams: Buffer[] = [];
  let from = 0;
  while (from < latin.length) {
    const at = latin.indexOf("stream", from);
    if (at < 0) {
      break;
    }
    if (at >= 3 && latin.slice(at - 3, at) === "end") {
      from = at + "stream".length;
      continue;
    }
    const before = latin.slice(Math.max(0, at - 300), at);
    let start = at + "stream".length;
    if (latin[start] === "\r") {
      start += 1;
    }
    if (latin[start] === "\n") {
      start += 1;
    }
    const end = latin.indexOf("endstream", start);
    if (end < 0) {
      break;
    }
    let raw = data.subarray(start, end);
    if (raw[raw.length - 1] === 0x0a) {
      raw = raw.subarray(0, raw.length - 1);
    }
    if (raw[raw.length - 1] === 0x0d) {
      raw = raw.subarray(0, raw.length - 1);
    }
    if (before.includes("/Image")) {
      from = end + "endstream".length;
      continue;
    }
    if (before.includes("FlateDecode")) {
      try {
        streams.push(inflateRawSync(raw));
      } catch {
        streams.push(raw);
      }
    } else {
      streams.push(raw);
    }
    from = end + "endstream".length;
  }
  return streams;
}

function textFromPdfContent(content: Buffer): string {
  const parts: string[] = [];
  let index = 0;
  while (index < content.length) {
    const byte = content[index];
    if (byte === 0x28) {
      const parsed = readPdfLiteral(content, index);
      if (!parsed) {
        break;
      }
      index = parsed.next;
      if (hasOperator(content, index, ["Tj", "'", '"'])) {
        parts.push(parsed.text);
      }
      continue;
    }
    if (byte === 0x3c && content[index + 1] !== 0x3c) {
      const parsed = readPdfHex(content, index);
      if (!parsed) {
        index += 1;
        continue;
      }
      index = parsed.next;
      if (hasOperator(content, index, ["Tj", "'", '"'])) {
        parts.push(parsed.text);
      }
      continue;
    }
    if (byte === 0x5b) {
      const parsed = readPdfArray(content, index);
      if (!parsed) {
        index += 1;
        continue;
      }
      index = parsed.next;
      if (hasOperator(content, index, ["TJ"])) {
        parts.push(parsed.text);
      }
      continue;
    }
    index += 1;
  }
  return parts.join("");
}

function readPdfLiteral(content: Buffer, start: number): { text: string; next: number } | undefined {
  const out: number[] = [];
  let index = start + 1;
  let depth = 1;
  while (index < content.length && depth > 0) {
    const byte = content[index] ?? 0;
    if (byte === 0x5c) {
      const next = content[index + 1];
      if (next === undefined) {
        return undefined;
      }
      if (next >= 0x30 && next <= 0x37) {
        let value = 0;
        let count = 0;
        while (
          count < 3 &&
          index + 1 < content.length &&
          (content[index + 1] ?? 0) >= 0x30 &&
          (content[index + 1] ?? 0) <= 0x37
        ) {
          value = value * 8 + ((content[index + 1] ?? 0) - 0x30);
          index += 1;
          count += 1;
        }
        out.push(value & 0xff);
        index += 1;
        continue;
      }
      const escaped: Record<number, number> = {
        0x6e: 0x0a,
        0x72: 0x0d,
        0x74: 0x09,
        0x62: 0x08,
        0x66: 0x0c,
        0x28: 0x28,
        0x29: 0x29,
        0x5c: 0x5c,
      };
      out.push(escaped[next] ?? next);
      index += 2;
      continue;
    }
    if (byte === 0x28) {
      depth += 1;
    }
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) {
        return { text: decodePdfBytes(Buffer.from(out)), next: index + 1 };
      }
    }
    out.push(byte);
    index += 1;
  }
  return undefined;
}

function readPdfHex(content: Buffer, start: number): { text: string; next: number } | undefined {
  let index = start + 1;
  let hex = "";
  while (index < content.length && content[index] !== 0x3e) {
    const byte = content[index] ?? 0;
    if (!isPdfSpace(byte)) {
      hex += String.fromCharCode(byte);
    }
    index += 1;
  }
  if (content[index] !== 0x3e || !/^[0-9A-Fa-f]*$/.test(hex)) {
    return undefined;
  }
  if (hex.length % 2 === 1) {
    hex += "0";
  }
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let pair = 2; pair + 1 < bytes.length; pair += 2) {
      swapped[pair - 2] = bytes[pair + 1] ?? 0;
      swapped[pair - 1] = bytes[pair] ?? 0;
    }
    return { text: swapped.toString("utf16le"), next: index + 1 };
  }
  return { text: decodePdfBytes(bytes), next: index + 1 };
}

function readPdfArray(content: Buffer, start: number): { text: string; next: number } | undefined {
  const parts: string[] = [];
  let index = start + 1;
  while (index < content.length) {
    const byte = content[index];
    if (byte === 0x5d) {
      return { text: parts.join(""), next: index + 1 };
    }
    if (byte === 0x28) {
      const parsed = readPdfLiteral(content, index);
      if (!parsed) {
        return undefined;
      }
      parts.push(parsed.text);
      index = parsed.next;
      continue;
    }
    if (byte === 0x3c) {
      const parsed = readPdfHex(content, index);
      if (!parsed) {
        return undefined;
      }
      parts.push(parsed.text);
      index = parsed.next;
      continue;
    }
    index += 1;
  }
  return undefined;
}

function hasOperator(content: Buffer, index: number, operators: readonly string[]): boolean {
  let cursor = index;
  while (cursor < content.length && isPdfSpace(content[cursor] ?? 0)) {
    cursor += 1;
  }
  const rest = content.toString("latin1", cursor, Math.min(content.length, cursor + 3));
  return operators.some((operator) => {
    if (!rest.startsWith(operator)) {
      return false;
    }
    const next = rest[operator.length] ?? "";
    return !/[A-Za-z]/.test(next);
  });
}

function isPdfSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c || byte === 0x00;
}

function decodePdfBytes(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}
