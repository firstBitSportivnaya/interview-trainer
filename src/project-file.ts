import { join } from "node:path";
import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";

import { installationRecognizer, type PageRecognizer } from "./recognize.ts";
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
 * Скан и картинка отдают байты локальному распознавателю. Чужой службе файл не уходит.
 */

export type ReadProjectFileResult =
  | { ready: true; text: string; places: SourcePlace[]; recognized: boolean }
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
    recognized?: boolean;
    executorId?: string;
  }): AddSourceFileResult;
  noteUnreadFile(draft: { caseId: string; name: string; executorId?: string }): NoteUnreadFileResult;
};

/** Каталог установки тот же, что у весов модели: data/models/tesseract. */
const defaultRecognizer = installationRecognizer(join(process.cwd(), "data"));

const LAYER_LABEL: Record<DossierLayerName, string> = {
  material: "материал проекта",
  serviceLayer: "служебный слой",
  crib: "шпаргалка проекта",
};

/** Читает DOCX, PPTX, XLSX, TXT, PDF или картинку. Чужой формат и пустой текст неготовы. */
export async function readProjectFile(
  name: string,
  bytes: Uint8Array,
  recognize: PageRecognizer = defaultRecognizer,
): Promise<ReadProjectFileResult> {
  try {
    const ext = extension(name);
    switch (ext) {
      case ".docx":
        return readOfficeText(bytes, readDocx);
      case ".pptx":
        return readOfficeText(bytes, readPptx);
      case ".xlsx":
        return readOfficeText(bytes, readXlsx);
      case ".txt":
        return readTxt(bytes);
      case ".pdf":
        return await readPdf(bytes, recognize);
      default:
        if (isImageName(ext)) {
          return await readImage(bytes, recognize);
        }
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
export async function acceptProjectFile(
  store: ProjectFileStore,
  draft: { caseId: string; name: string; bytes: Uint8Array; layer?: string; executorId?: string },
  recognize?: PageRecognizer,
): Promise<AcceptProjectFileResult> {
  const name = draft.name.trim();
  if (!name) {
    return { ok: false, reason: "incomplete" };
  }
  const read = recognize
    ? await readProjectFile(name, draft.bytes, recognize)
    : await readProjectFile(name, draft.bytes);
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
    recognized: read.recognized,
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

function isImageName(ext: string): boolean {
  return (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".webp" ||
    ext === ".gif" ||
    ext === ".bmp" ||
    ext === ".tif" ||
    ext === ".tiff"
  );
}

/** Картинка целиком. Без распознавателя и без надписи файл неготов. */
async function readImage(bytes: Uint8Array, recognize: PageRecognizer | undefined): Promise<ReadProjectFileResult> {
  if (!recognize || bytes.length === 0 || bytes.length > TEXT_LIMIT) {
    return { ready: false };
  }
  const text = (await recognize.recognize(bytes)).trim();
  return readyText(text, [], true);
}

function readyText(text: string, places: SourcePlace[] = [], recognized = false): ReadProjectFileResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ready: false };
  }
  return { ready: true, text: trimmed, places, recognized };
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
  const slides = slideOrder(files);
  const lines: string[] = [];
  const places: SourcePlace[] = [];
  for (const slide of slides) {
    const xml = files.get(slide.name);
    if (!xml) {
      continue;
    }
    const text = docxText(decodeXmlBytes(xml));
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
    for (const row of sheetLines(decodeXmlBytes(xml), shared)) {
      lines.push(row);
    }
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

async function readPdf(bytes: Uint8Array, recognize: PageRecognizer | undefined): Promise<ReadProjectFileResult> {
  const data = Buffer.from(bytes);
  const parts: string[] = [];
  for (const stream of pdfStreams(data)) {
    const text = textFromPdfContent(stream);
    if (text.trim()) {
      parts.push(text);
    }
  }
  const textLayer = readyText(parts.join("\n"));
  if (textLayer.ready || !recognize) {
    return textLayer;
  }
  const lines: string[] = [];
  for (const image of pdfImages(data)) {
    try {
      const text = (await recognize.recognize(image)).trim();
      if (text) {
        lines.push(text);
      }
    } catch {
      // Сбой распознавания надписью не становится.
    }
  }
  return readyText(lines.join("\n"), [], true);
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return readableText(decodeUtf8(bytes.subarray(3)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2 !== 0) {
      return undefined;
    }
    return readableText(Buffer.from(bytes.subarray(2)).toString("utf16le"));
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
    return readableText(swapped.toString("utf16le"));
  }
  return readableText(decodeUtf8(bytes) ?? decodeWindows1251(bytes));
}

/** Текст без NUL и прочих управляющих байт. Таб, перевод строки и возврат каретки остаются. */
function readableText(text: string | undefined): string | undefined {
  if (text === undefined) {
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

/** Windows-1251, если байты не UTF-8. Проверку управляющих байт делает readableText. */
function decodeWindows1251(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("windows-1251").decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Порядок показа. Без списка презентации остаётся номер из имени части. Пустой слайд место занимает. */
function slideOrder(files: Map<string, Uint8Array>): { name: string; slide: number }[] {
  const listed = presentationSlides(files);
  if (listed) {
    return listed;
  }
  return [...files.keys()]
    .map((name) => ({ name, slide: slideNumber(name) }))
    .filter((item): item is { name: string; slide: number } => item.slide !== undefined)
    .sort((left, right) => left.slide - right.slide);
}

function presentationSlides(files: Map<string, Uint8Array>): { name: string; slide: number }[] | undefined {
  const presentation = files.get("ppt/presentation.xml");
  const rels = files.get("ppt/_rels/presentation.xml.rels");
  if (!presentation || !rels) {
    return undefined;
  }
  const targets = new Map<string, string>();
  for (const rel of decodeXmlBytes(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = rel[1] ?? "";
    const id = /Id="([^"]+)"/.exec(attrs)?.[1];
    const target = /Target="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) {
      targets.set(id, slidePath(target));
    }
  }
  const slides: { name: string; slide: number }[] = [];
  for (const item of decodeXmlBytes(presentation).matchAll(/<[^>\s]*sldId\b([^>]*)\/?>/g)) {
    const relId = /r:id="([^"]+)"/.exec(item[1] ?? "")?.[1];
    const name = relId ? targets.get(relId) : undefined;
    if (!name || !Number.isSafeInteger(slides.length + 1)) {
      continue;
    }
    slides.push({ name, slide: slides.length + 1 });
  }
  return slides.length > 0 ? slides : undefined;
}

function slidePath(target: string): string {
  const clean = target.replaceAll("\\", "/").replace(/^\//, "");
  if (clean.startsWith("ppt/")) {
    return clean;
  }
  return `ppt/${clean.replace(/^\.\//, "")}`;
}

function slideNumber(name: string): number | undefined {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) {
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
  for (const cell of readCells(xml)) {
    const ref = /r="([A-Z]+)(\d+)"/.exec(cell.attrs);
    const row = ref ? Number(ref[2]) : 0;
    const column = ref ? columnIndex(ref[1] ?? "") : 0;
    const text = cellText(cell.attrs, cell.inner, shared);
    if (!text) {
      continue;
    }
    const line = byRow.get(row) ?? [];
    line.push({ column, text });
    byRow.set(row, line);
  }
  return [...byRow.keys()]
    .sort((left, right) => left - right)
    .map((row) => {
      const cells = (byRow.get(row) ?? []).sort((left, right) => left.column - right.column);
      const width = cells.at(-1)?.column ?? 0;
      const slots = Array.from({ length: width }, () => "");
      for (const cell of cells) {
        if (cell.column >= 1) {
          slots[cell.column - 1] = cell.text;
        }
      }
      return slots.join("\t");
    });
}

/** Самозакрытая ячейка не захватывает следующую. */
function readCells(xml: string): { attrs: string; inner: string }[] {
  const cells: { attrs: string; inner: string }[] = [];
  let index = 0;
  while (index < xml.length) {
    const at = xml.indexOf("<c", index);
    if (at < 0) {
      break;
    }
    const next = xml[at + 2];
    if (next !== " " && next !== ">" && next !== "/" && next !== "\n" && next !== "\r" && next !== "\t") {
      index = at + 2;
      continue;
    }
    const close = xml.indexOf(">", at);
    if (close < 0) {
      break;
    }
    const head = xml.slice(at, close + 1);
    const selfClosing = /\/\s*>$/.test(head);
    const attrs = head.slice(2, selfClosing ? head.lastIndexOf("/") : head.length - 1);
    if (selfClosing) {
      cells.push({ attrs, inner: "" });
      index = close + 1;
      continue;
    }
    const end = xml.indexOf("</c>", close);
    if (end < 0) {
      break;
    }
    cells.push({ attrs, inner: xml.slice(close + 1, end) });
    index = end + "</c>".length;
  }
  return cells;
}

function cellText(attrs: string, inner: string, shared: readonly string[]): string {
  const kind = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
  if (kind === "s") {
    const matched = /<v>(\d+)<\/v>/.exec(inner);
    if (!matched) {
      return "";
    }
    return shared[Number(matched[1])] ?? "";
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
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (entity, body: string) => {
    if (body === "lt") {
      return "<";
    }
    if (body === "gt") {
      return ">";
    }
    if (body === "quot") {
      return '"';
    }
    if (body === "apos") {
      return "'";
    }
    if (body === "amp") {
      return "&";
    }
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
      return entity;
    }
    return String.fromCodePoint(code);
  });
}

function decodeXmlBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** Предел распакованного текста одного файла. Картинки и прочие части не читаются. */
const TEXT_LIMIT = 8 * 1024 * 1024;

function neededOfficePart(name: string): boolean {
  return (
    name === "word/document.xml" ||
    name === "ppt/presentation.xml" ||
    name === "ppt/_rels/presentation.xml.rels" ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
    name === "xl/sharedStrings.xml" ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
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
  let total = 0;
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
    if (!neededOfficePart(name)) {
      continue;
    }
    const decoded = inflateZip(method, compressed);
    if (!decoded || total + decoded.length > TEXT_LIMIT) {
      return undefined;
    }
    total += decoded.length;
    files.set(name, decoded);
  }
  return files;
}

function inflateZip(method: number, compressed: Buffer): Uint8Array | undefined {
  if (method === 0) {
    return compressed.length <= TEXT_LIMIT ? compressed : undefined;
  }
  if (method !== 8) {
    return undefined;
  }
  try {
    const inflated = inflateRawSync(compressed, { maxOutputLength: TEXT_LIMIT });
    return inflated.length <= TEXT_LIMIT ? inflated : undefined;
  } catch {
    return undefined;
  }
}

/** Потоки PDF в порядке файла. Граница берётся из /Length, если она есть. */
function pdfRawStreams(data: Buffer): { dictionary: string; raw: Buffer }[] {
  const latin = data.toString("latin1");
  const objects: { dictionary: string; raw: Buffer }[] = [];
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
    const dictionary = streamDictionary(latin, at);
    let start = at + "stream".length;
    if (latin[start] === "\r") {
      start += 1;
    }
    if (latin[start] === "\n") {
      start += 1;
    }
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary)?.[1];
    const end = length ? start + Number(length) : latin.indexOf("endstream", start);
    if (end < start || end > data.length) {
      break;
    }
    objects.push({ dictionary, raw: data.subarray(start, end) });
    from = length ? end : end + "endstream".length;
  }
  return objects;
}

/** Картинки страницы. Текстовый поток сюда не входит. */
function pdfImages(data: Buffer): Buffer[] {
  const images: Buffer[] = [];
  for (const object of pdfRawStreams(data)) {
    if (!isPdfImage(object.dictionary)) {
      continue;
    }
    const decoded = pdfImageBytes(object.dictionary, object.raw);
    if (decoded && decoded.length > 0) {
      images.push(decoded);
    }
  }
  return images;
}

/** JPEG остаётся как в файле. Восьмибитные точки становятся PNG. Чужой фильтр картинкой не считается. */
function pdfImageBytes(dictionary: string, raw: Buffer): Buffer | undefined {
  const flate = dictionary.includes("FlateDecode");
  const jpeg = dictionary.includes("DCTDecode");
  if (jpeg && !flate) {
    return raw.length <= TEXT_LIMIT ? raw : undefined;
  }
  if (flate && !jpeg && !dictionary.includes("JPXDecode") && !dictionary.includes("CCITTFaxDecode")) {
    try {
      const inflated = inflateSync(raw, { maxOutputLength: TEXT_LIMIT });
      return pngFromPdfSamples(dictionary, inflated);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isPdfImage(dictionary: string): boolean {
  return /\/Subtype\s*\/Image\b/.test(dictionary);
}

/** Сырые точки без ширины и числа каналов распознавателю не отдаются. */
function pngFromPdfSamples(dictionary: string, samples: Buffer): Buffer | undefined {
  const width = pdfDictionaryNumber(dictionary, "Width");
  const height = pdfDictionaryNumber(dictionary, "Height");
  const bits = pdfDictionaryNumber(dictionary, "BitsPerComponent");
  const channels = dictionary.includes("/DeviceGray") ? 1 : dictionary.includes("/DeviceRGB") ? 3 : 0;
  if (!width || !height || bits !== 8 || channels === 0) {
    return undefined;
  }
  if (samples.length !== width * height * channels) {
    return undefined;
  }
  return png(width, height, channels, samples);
}

function pdfDictionaryNumber(dictionary: string, name: string): number | undefined {
  const match = new RegExp(`/${name}\\s+(\\d+)`).exec(dictionary);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function png(width: number, height: number, channels: 1 | 3, samples: Buffer): Buffer | undefined {
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (row + 1)] = 0;
    samples.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  const body = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return body.length <= TEXT_LIMIT ? body : undefined;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pdfStreams(data: Buffer): Buffer[] {
  const streams: Buffer[] = [];
  for (const object of pdfRawStreams(data)) {
    if (isPdfImage(object.dictionary)) {
      continue;
    }
    if (object.dictionary.includes("FlateDecode")) {
      try {
        streams.push(inflateSync(object.raw, { maxOutputLength: TEXT_LIMIT }));
      } catch {
        continue;
      }
    } else {
      streams.push(object.raw);
    }
  }
  return streams;
}

/** Словарь этого потока целиком, вместе с вложенным /DecodeParms. Чужой объект не захватывается. */
function streamDictionary(latin: string, streamAt: number): string {
  const close = latin.lastIndexOf(">>", streamAt);
  if (close < 0) {
    return "";
  }
  let depth = 0;
  let index = close + 1;
  while (index >= 1) {
    if (latin[index] === ">" && latin[index - 1] === ">") {
      depth += 1;
      index -= 2;
      continue;
    }
    if (latin[index] === "<" && latin[index - 1] === "<") {
      depth -= 1;
      if (depth === 0) {
        return latin.slice(index - 1, close + 2);
      }
      index -= 2;
      continue;
    }
    index -= 1;
  }
  return "";
}

function textFromPdfContent(content: Buffer): string {
  const parts: string[] = [];
  let index = 0;
  while (index < content.length) {
    const byte = content[index];
    if (byte === 0x25) {
      index += 1;
      while (index < content.length && content[index] !== 0x0a && content[index] !== 0x0d) {
        index += 1;
      }
      continue;
    }
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
        const text = decodePdfBytes(Buffer.from(out));
        return text === undefined ? { text: "", next: index + 1 } : { text, next: index + 1 };
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
  const text = decodePdfBytes(bytes);
  return { text: text ?? "", next: index + 1 };
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

/** Байты без кодировки Unicode текстом не становятся: чужой глиф не подменяется. */
function decodePdfBytes(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
