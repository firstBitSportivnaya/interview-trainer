import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { acceptProjectFile, readProjectFile } from "../src/project-file.ts";
import { openTrainer } from "../src/trainer.ts";

const PHRASE = "Приёмка паллет на рампе";
const HEADER = "Вес паллеты";
const VALUE = "840";

const directories: string[] = [];
const opened: Array<ReturnType<typeof openTrainer>> = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "project-file-"));
  directories.push(directory);
  return directory;
}

function start(): { trainer: ReturnType<typeof openTrainer>; caseId: string } {
  const trainer = openTrainer(tempDirectory());
  opened.push(trainer);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);
  const approved = trainer.approveDossier({
    caseId: saved.caseRecord.id,
    material: "Склад принимает паллеты.",
    serviceLayer: "Маржа подрядчика.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  return { trainer, caseId: saved.caseRecord.id };
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** ZIP со сжатием, как у файла офиса. Читатель не должен принимать только несжатый архив. */
function zip(entries: Record<string, string>): Buffer {
  const names = Object.keys(entries);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const raw = Buffer.from(entries[name] ?? "", "utf8");
    const compressed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, compressed]);
    locals.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function docx(text: string): Buffer {
  return zip({
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p></w:body>
</w:document>`,
  });
}

function pptx(slides: readonly string[]): Buffer {
  const entries: Record<string, string> = {};
  slides.forEach((text, index) => {
    entries[`ppt/slides/slide${index + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
  });
  return zip(entries);
}

function xlsx(header: string, value: string): Buffer {
  return zip({
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>${xmlEscape(header)}</t></si>
</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>${value}</v></c></row></sheetData>
</worksheet>`,
  });
}

/** PDF, который наш читатель разбирает по операторам текста, без внешнего разборщика. */
function pdf(content: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  objects.forEach((object, index) => {
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  return Buffer.from(body, "utf8");
}

after(() => {
  for (const trainer of opened) {
    trainer.close();
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DOCX попадает в материал проекта, который назвал владелец", () => {
  const { trainer, caseId } = start();
  const before = trainer.readApprovedDossier(caseId);
  const name = "паллеты.docx";

  const unread = acceptProjectFile(trainer, {
    caseId,
    name,
    bytes: Buffer.from(PHRASE, "utf8"),
    layer: "материал проекта",
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(JSON.stringify(trainer.listSourceFiles(caseId)).includes(PHRASE), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === name), true);

  const taken = acceptProjectFile(trainer, {
    caseId,
    name,
    bytes: docx(PHRASE),
    layer: "материал проекта",
  });
  assert.equal(taken.ok, true);
  assert.equal(taken.ready, true);
  assert.equal(taken.filed, true);
  if (!taken.ok || !taken.ready || !taken.filed) {
    return;
  }
  assert.equal(taken.file.layer, "material");
  assert.equal(taken.file.extractedText.includes(PHRASE), true);
  assert.equal(trainer.listSourceFiles(caseId).some((file) => file.extractedText.includes(PHRASE)), true);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === name), false);
  assert.deepEqual(trainer.readApprovedDossier(caseId), before);
});

test("PPTX сохраняет фразу и номер слайда", () => {
  const { trainer, caseId } = start();
  const taken = acceptProjectFile(trainer, {
    caseId,
    name: "слайды.pptx",
    bytes: pptx(["Титул", PHRASE]),
    layer: "материал проекта",
  });
  assert.equal(taken.ok, true);
  assert.equal(taken.ready, true);
  assert.equal(taken.filed, true);
  if (!taken.ok || !taken.ready || !taken.filed) {
    return;
  }
  assert.equal(taken.file.extractedText.includes(PHRASE), true);
  assert.equal(taken.file.places.some((place) => place.slide === 2), true);
  const stored = trainer.listSourceFiles(caseId)[0];
  assert.equal(stored?.places.some((place) => place.slide === 2), true);
  assert.equal(stored?.extractedText.includes(PHRASE), true);
});

test("XLSX отдаёт заголовок столбца и значение", () => {
  const read = readProjectFile("вес.xlsx", xlsx(HEADER, VALUE));
  assert.equal(read.ready, true);
  if (!read.ready) {
    return;
  }
  assert.equal(read.text.includes(HEADER), true);
  assert.equal(read.text.includes(VALUE), true);
});

test("TXT в понятной кодировке читается, а неразборчивый не готов", () => {
  const { trainer, caseId } = start();
  const encoded = acceptProjectFile(trainer, {
    caseId,
    name: "заметка.txt",
    bytes: Buffer.from(`\uFEFF${PHRASE}`, "utf8"),
    layer: "материал проекта",
  });
  assert.equal(encoded.ok, true);
  assert.equal(encoded.ready, true);
  assert.equal(encoded.filed, true);
  if (encoded.ok && encoded.ready && encoded.filed) {
    assert.equal(encoded.file.extractedText.includes(PHRASE), true);
  }

  const windows1251 = Uint8Array.from([
    0xcf, 0xf0, 0xe8, 0xb8, 0xec, 0xea, 0xe0, 0x20, 0xef, 0xe0, 0xeb, 0xeb, 0xe5, 0xf2, 0x20, 0xed, 0xe0, 0x20, 0xf0,
    0xe0, 0xec, 0xef, 0xe5,
  ]);
  const legacy = readProjectFile("заметка-1251.txt", windows1251);
  assert.equal(legacy.ready, true);
  if (legacy.ready) {
    assert.equal(legacy.text.includes(PHRASE), true);
  }

  const garbage = Uint8Array.from([0xff, 0x00, 0x80]);
  const read = readProjectFile("битый.txt", garbage);
  assert.equal(read.ready, false);
  assert.equal(JSON.stringify(read).includes(PHRASE), false);

  const unread = acceptProjectFile(trainer, {
    caseId,
    name: "битый.txt",
    bytes: garbage,
    layer: "материал проекта",
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(trainer.listSourceFiles(caseId).some((file) => file.name === "битый.txt"), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === "битый.txt"), true);

  const empty = acceptProjectFile(trainer, {
    caseId,
    name: "пустой.txt",
    bytes: new Uint8Array(),
    layer: "материал проекта",
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.ready, false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === "пустой.txt"), true);
  assert.equal(JSON.stringify(empty).includes(PHRASE), false);
});

test("PDF без текстового слоя не прочитан и абзац не выдуман", () => {
  const { trainer, caseId } = start();
  const before = trainer.readApprovedDossier(caseId);
  const withText = readProjectFile("текст.pdf", pdf(`BT (${PHRASE}) Tj ET`));
  assert.equal(withText.ready, true);
  if (withText.ready) {
    assert.equal(withText.text.includes(PHRASE), true);
  }

  const refused = acceptProjectFile(trainer, {
    caseId,
    name: "скан.pdf",
    bytes: pdf("0 0 10 10 re f"),
    layer: "материал проекта",
    executorId: "чужой",
  });
  assert.deepEqual(refused, { ok: false, reason: "forbidden" });
  assert.deepEqual(trainer.listUnreadFiles(caseId), []);

  const unread = acceptProjectFile(trainer, {
    caseId,
    name: "скан.pdf",
    bytes: pdf("0 0 10 10 re f"),
    layer: "материал проекта",
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(JSON.stringify(unread).includes(PHRASE), false);
  assert.equal(JSON.stringify(trainer.listSourceFiles(caseId)).includes(PHRASE), false);
  assert.equal(trainer.listSourceFiles(caseId).some((file) => file.name === "скан.pdf"), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === "скан.pdf"), true);
  assert.deepEqual(trainer.readApprovedDossier(caseId), before);
});

test("прочитанный файл без названного слоя ни в один слой не входит", () => {
  const { trainer, caseId } = start();
  const taken = acceptProjectFile(trainer, {
    caseId,
    name: "служебный-слой.docx",
    bytes: docx(PHRASE),
  });
  assert.equal(taken.ok, true);
  assert.equal(taken.ready, true);
  assert.equal(taken.filed, false);
  if (taken.ok && taken.ready && !taken.filed) {
    assert.equal(taken.text.includes(PHRASE), true);
  }
  assert.deepEqual(trainer.listSourceFiles(caseId), []);
  assert.deepEqual(trainer.listUnreadFiles(caseId), []);
  for (const layer of ["material", "serviceLayer", "crib"] as const) {
    assert.equal(trainer.listSourceFiles(caseId).some((file) => file.layer === layer), false);
  }
});
