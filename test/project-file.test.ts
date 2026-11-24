import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { deflateRawSync, deflateSync, inflateSync } from "node:zlib";

import { type ModelPort } from "../src/model.ts";
import { acceptProjectFile, readProjectFile } from "../src/project-file.ts";
import { openTrainer } from "../src/trainer.ts";

const PHRASE = "Приёмка паллет на рампе";
const SCAN = "склад принимает паллеты";
const PAGE = Uint8Array.of(0x53, 0x43, 0x41, 0x4e, 0x01, 0x02, 0x03, 0x04);
const BLANK = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
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

test("DOCX попадает в материал проекта, который назвал владелец", async () => {
  const { trainer, caseId } = start();
  const before = trainer.readApprovedDossier(caseId);
  const name = "паллеты.docx";

  const unread = await acceptProjectFile(trainer, {
    caseId,
    name,
    bytes: Buffer.from(PHRASE, "utf8"),
    layer: "материал проекта",
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(JSON.stringify(trainer.listSourceFiles(caseId)).includes(PHRASE), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === name), true);

  const taken = await acceptProjectFile(trainer, {
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

test("PPTX сохраняет фразу и номер слайда", async () => {
  const { trainer, caseId } = start();
  const taken = await acceptProjectFile(trainer, {
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

test("XLSX отдаёт заголовок столбца и значение", async () => {
  const read = await readProjectFile("вес.xlsx", xlsx(HEADER, VALUE));
  assert.equal(read.ready, true);
  if (!read.ready) {
    return;
  }
  assert.equal(read.text.includes(HEADER), true);
  assert.equal(read.text.includes(VALUE), true);
});

test("TXT в понятной кодировке читается, а неразборчивый не готов", async () => {
  const { trainer, caseId } = start();
  const encoded = await acceptProjectFile(trainer, {
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
  const legacy = await readProjectFile("заметка-1251.txt", windows1251);
  assert.equal(legacy.ready, true);
  if (legacy.ready) {
    assert.equal(legacy.text.includes(PHRASE), true);
  }

  const garbage = Uint8Array.from([0xff, 0x00, 0x80]);
  const read = await readProjectFile("битый.txt", garbage);
  assert.equal(read.ready, false);
  assert.equal(JSON.stringify(read).includes(PHRASE), false);

  const unread = await acceptProjectFile(trainer, {
    caseId,
    name: "битый.txt",
    bytes: garbage,
    layer: "материал проекта",
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(trainer.listSourceFiles(caseId).some((file) => file.name === "битый.txt"), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === "битый.txt"), true);

  const empty = await acceptProjectFile(trainer, {
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

test("PDF без текстового слоя не прочитан и абзац не выдуман", async () => {
  const { trainer, caseId } = start();
  const before = trainer.readApprovedDossier(caseId);
  const withText = await readProjectFile("текст.pdf", pdf(`BT (${PHRASE}) Tj ET`));
  assert.equal(withText.ready, true);
  if (withText.ready) {
    assert.equal(withText.text.includes(PHRASE), true);
  }

  const refused = await acceptProjectFile(trainer, {
    caseId,
    name: "скан.pdf",
    bytes: pdf("0 0 10 10 re f"),
    layer: "материал проекта",
    executorId: "чужой",
  });
  assert.deepEqual(refused, { ok: false, reason: "forbidden" });
  assert.deepEqual(trainer.listUnreadFiles(caseId), []);

  const unread = await acceptProjectFile(trainer, {
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

test("прочитанный файл без названного слоя ни в один слой не входит", async () => {
  const { trainer, caseId } = start();
  const taken = await acceptProjectFile(trainer, {
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

test("TXT с управляющим байтом не готов", async () => {
  assert.equal((await readProjectFile("nul.txt", Uint8Array.of(0))).ready, false);
  assert.equal((await readProjectFile("nul.txt", Buffer.from("а\0б", "utf8"))).ready, false);
});

test("XLSX не сдвигает значение и не берёт чужую строку", async () => {
  const read = await readProjectFile(
    "вес.xlsx",
    zip({
      "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>ЧУЖОЙ</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Длина</t></is></c><c r="B1" t="inlineStr"><is><t>Вес</t></is></c></row>
<row r="2"><c r="A2" t="s" s="1"/><c r="B2"><v>840</v></c></row>
</sheetData></worksheet>`,
    }),
  );
  assert.equal(read.ready, true);
  if (!read.ready) {
    return;
  }
  assert.equal(read.text.includes("ЧУЖОЙ"), false);
  assert.equal(read.text.split("\n")[1], "\t840");
  assert.equal(read.text.includes("Длина"), true);
  assert.equal(read.text.includes("Вес"), true);
});

test("DOCX читает числовую ссылку один раз", async () => {
  const read = await readProjectFile(
    "ссылка.docx",
    zip({
      "word/document.xml": `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Приёмка &#x26; паллет</w:t></w:r></w:p></w:body></w:document>`,
    }),
  );
  assert.equal(read.ready, true);
  if (read.ready) {
    assert.equal(read.text.includes("Приёмка & паллет"), true);
    assert.equal(read.text.includes("&#x26;"), false);
  }
});

test("PPTX держит абзацы и порядок показа", async () => {
  const paragraphs = await readProjectFile(
    "абзацы.pptx",
    zip({ "ppt/slides/slide1.xml": slideXml(["Net", "weight"]) }),
  );
  assert.equal(paragraphs.ready, true);
  if (paragraphs.ready) {
    assert.equal(paragraphs.text, "Net\nweight");
  }

  const ordered = await readProjectFile(
    "порядок.pptx",
    zip({
      "ppt/slides/slide1.xml": slideXml([PHRASE]),
      "ppt/slides/slide2.xml": slideXml(["Титул"]),
      "ppt/presentation.xml": `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`,
    }),
  );
  assert.equal(ordered.ready, true);
  if (!ordered.ready) {
    return;
  }
  assert.equal(ordered.text, `Титул\n${PHRASE}`);
  assert.deepEqual(ordered.places, [{ slide: 1 }, { slide: 2 }]);
});

test("PDF не берёт комментарий и сжатый текст, картинка рядом не гасит страницу", async () => {
  const commented = await readProjectFile("комментарий.pdf", pdf(`% (Выдуманный абзац) Tj\nBT (${PHRASE}) Tj ET`));
  assert.equal(commented.ready, true);
  if (commented.ready) {
    assert.equal(commented.text.includes(PHRASE), true);
    assert.equal(commented.text.includes("Выдуманный абзац"), false);
  }

  const content = Buffer.from(`BT (${PHRASE}) Tj ET`, "utf8");
  const compressed = deflateSync(content);
  const inflated = await readProjectFile(
    "сжатый.pdf",
    Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
      compressed,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );
  assert.equal(inflated.ready, true);
  if (inflated.ready) {
    assert.equal(inflated.text.includes(PHRASE), true);
  }

  const page = Buffer.from(`BT (${PHRASE}) Tj ET`, "utf8");
  const besideImage = await readProjectFile(
    "рядом.pdf",
    Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Length 4 >>\nstream\nXXXX\nendstream\nendobj\n2 0 obj\n"),
      Buffer.from(`<< /Length ${page.length} >>\nstream\n`),
      page,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );
  assert.equal(besideImage.ready, true);
  if (besideImage.ready) {
    assert.equal(besideImage.text.includes(PHRASE), true);
  }
});

test("номер слайда, который не помещается в хранилище, не записывается", async () => {
  const { trainer, caseId } = start();
  const saved = trainer.addSourceFile({
    caseId,
    name: "слайд.pptx",
    layer: "material",
    extractedText: PHRASE,
    places: [{ slide: 9007199254740992 }, { slide: 2 }],
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.deepEqual(saved.file.places, [{ slide: 2 }]);
  }
  assert.deepEqual(trainer.listSourceFiles(caseId)[0]?.places, [{ slide: 2 }]);
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Надпись знает только распознаватель и только по байтам этой картинки. В файле фразы нет. */
function recognizePage(image: Uint8Array, text: string) {
  return {
    async recognize(page: Uint8Array) {
      return sameBytes(page, image) ? text : "";
    },
  };
}

function pdfFlateImage(samples: Buffer, width: number, height: number, gray: boolean): Buffer {
  const compressed = deflateSync(samples);
  const color = gray ? "/DeviceGray" : "/DeviceRGB";
  const content = Buffer.from("q 10 0 0 10 0 0 cm /Im0 Do Q");
  const dictionary = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${color} /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`;
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n${dictionary}\nstream\n`),
    compressed,
    Buffer.from(`\nendstream\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
}

function pngSample(image: Uint8Array): number | undefined {
  const data = Buffer.from(image);
  if (data[0] !== 0x89 || data[1] !== 0x50) {
    return undefined;
  }
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") {
      return inflateSync(chunk)[1];
    }
    offset += 12 + length;
  }
  return undefined;
}

/** PDF без текстового слоя: картинка страницы и оператор показа, без Tj. */
function pdfImage(image: Uint8Array): Buffer {
  const pixels = Buffer.from(image);
  const content = Buffer.from("q 100 0 0 100 0 0 cm /Im0 Do Q");
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${pixels.length} >>\nstream\n`,
    ),
    pixels,
    Buffer.from(`\nendstream\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
}

function recordingModel(seen: string[]): ModelPort {
  return {
    async *complete(call) {
      seen.push(call.messages.map((message) => message.text).join("\n"));
      yield JSON.stringify({ material: "Черновик.", serviceLayer: "", crib: "" });
    },
  };
}

test("скан pdf с надписью входит в черновик названного слоя", async () => {
  const seen: string[] = [];
  const trainer = openTrainer(tempDirectory(), recordingModel(seen));
  opened.push(trainer);
  const saved = trainer.saveCase({ customerName: "Север", title: "Внедрение склада" });
  assert.ok(saved.ok);
  const caseId = saved.caseRecord.id;
  const approved = trainer.approveDossier({
    caseId,
    material: "Другой факт.",
    serviceLayer: "Маржа подрядчика.",
    crib: "Спросить про сроки.",
  });
  assert.ok(approved.ok);
  assert.deepEqual(trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  }), { ok: true });
  const keyId = trainer.listKeys()[0]?.id;
  assert.ok(keyId);

  const read = await readProjectFile("скан.pdf", pdfImage(PAGE), recognizePage(PAGE, SCAN));
  assert.equal(read.ready, true);
  if (read.ready) {
    assert.equal(read.text.includes(SCAN), true);
    assert.equal(read.recognized, true);
  }
  assert.equal(Buffer.from(pdfImage(PAGE)).toString("utf8").includes(SCAN), false);

  const taken = await acceptProjectFile(
    trainer,
    { caseId, name: "скан.pdf", bytes: pdfImage(PAGE), layer: "материал проекта" },
    recognizePage(PAGE, SCAN),
  );
  assert.equal(taken.ok, true);
  assert.equal(taken.ready, true);
  assert.equal(taken.filed, true);
  if (taken.ok && taken.ready && taken.filed) {
    assert.equal(taken.file.extractedText.includes(SCAN), true);
    assert.equal(taken.file.layer, "material");
    assert.equal(taken.file.recognized, true);
  }

  const drafted = await trainer.draftDossier({
    caseId,
    keyId,
    material: "Другой факт.",
    serviceLayer: "",
    crib: "",
  });
  assert.equal(drafted.ok, true);
  assert.equal(seen[0]?.includes(SCAN), true);
  assert.equal(seen[0]?.includes("Другой факт."), true);
});

test("картинка без надписи не прочитана и абзац не выдуман", async () => {
  const { trainer, caseId } = start();
  const before = trainer.readApprovedDossier(caseId);
  const read = await readProjectFile("пустая.png", BLANK, recognizePage(PAGE, SCAN));
  assert.equal(read.ready, false);
  assert.equal(JSON.stringify(read).includes(SCAN), false);

  const unread = await acceptProjectFile(
    trainer,
    { caseId, name: "пустая.png", bytes: BLANK, layer: "материал проекта" },
    recognizePage(PAGE, SCAN),
  );
  assert.equal(unread.ok, true);
  assert.equal(unread.ready, false);
  assert.equal(JSON.stringify(unread).includes(SCAN), false);
  assert.equal(trainer.listSourceFiles(caseId).some((file) => file.name === "пустая.png"), false);
  assert.equal(trainer.listUnreadFiles(caseId).some((file) => file.name === "пустая.png"), true);
  assert.deepEqual(trainer.readApprovedDossier(caseId), before);

  const drawing = await readProjectFile("рисунок.pdf", pdf("0 0 10 10 re f"), recognizePage(PAGE, SCAN));
  assert.equal(drawing.ready, false);
  assert.equal(JSON.stringify(drawing).includes(SCAN), false);
});

test("распознанный скан без названного слоя ни в один слой не входит", async () => {
  const { trainer, caseId } = start();
  const taken = await acceptProjectFile(
    trainer,
    { caseId, name: "скан.pdf", bytes: pdfImage(PAGE) },
    recognizePage(PAGE, SCAN),
  );
  assert.equal(taken.ok, true);
  assert.equal(taken.ready, true);
  assert.equal(taken.filed, false);
  if (taken.ok && taken.ready && !taken.filed) {
    assert.equal(taken.text.includes(SCAN), true);
  }
  assert.deepEqual(trainer.listSourceFiles(caseId), []);
  assert.deepEqual(trainer.listUnreadFiles(caseId), []);
});

test("текст pdf не подменяется распознаванием, pptx из рисунка не читается", async () => {
  const inventsParagraph = {
    async recognize() {
      return "Выдуманный абзац";
    },
  };
  const text = await readProjectFile("текст.pdf", pdf(`BT (${PHRASE}) Tj ET`), inventsParagraph);
  assert.equal(text.ready, true);
  if (text.ready) {
    assert.equal(text.text.includes(PHRASE), true);
    assert.equal(text.text.includes("Выдуманный абзац"), false);
    assert.equal(text.recognized, false);
  }

  const slide = await readProjectFile("рисунок.pptx", pptx([""]), inventsParagraph);
  assert.equal(slide.ready, false);
  assert.equal(JSON.stringify(slide).includes("Выдуманный абзац"), false);
  const sheet = await readProjectFile("рисунок.xlsx", xlsx("", ""), inventsParagraph);
  assert.equal(sheet.ready, false);
});

test("вложенный словарь картинки не прячет надпись", async () => {
  const pixels = Buffer.from(PAGE);
  const content = Buffer.from("q 100 0 0 100 0 0 cm /Im0 Do Q");
  const dictionary = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /DecodeParms << /Predictor 1 >> /Length ${pixels.length} >>`;
  const bytes = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n${dictionary}\nstream\n`),
    pixels,
    Buffer.from(`\nendstream\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const read = await readProjectFile("вложенный.pdf", bytes, recognizePage(PAGE, SCAN));
  assert.equal(read.ready, true);
  if (read.ready) {
    assert.equal(read.text.includes(SCAN), true);
  }
});

test("сжатые точки страницы приходят распознавателю картинкой", async () => {
  const seen: Uint8Array[] = [];
  const read = await readProjectFile("точки.pdf", pdfFlateImage(Buffer.of(255), 1, 1, true), {
    async recognize(image) {
      seen.push(image);
      return image[0] === 0x89 && image[1] === 0x50 ? SCAN : "";
    },
  });
  assert.equal(read.ready, true);
  if (read.ready) {
    assert.equal(read.text.includes(SCAN), true);
    assert.equal(read.recognized, true);
  }
  assert.equal(seen.length, 1);
  assert.equal(pngSample(seen[0] ?? new Uint8Array()), 255);

  const broken = await readProjectFile("битые-точки.pdf", pdfFlateImage(Buffer.of(1, 2, 3, 4), 1, 1, true), {
    async recognize() {
      return SCAN;
    },
  });
  assert.equal(broken.ready, false);
  assert.equal(JSON.stringify(broken).includes(SCAN), false);
});

test("прежний файл остаётся и без отметки распознавания", async () => {
  const directory = tempDirectory();
  const database = new DatabaseSync(join(directory, "store.sqlite"));
  database.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE cases (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      title TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_files (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id),
      name TEXT NOT NULL,
      layer TEXT NOT NULL,
      extracted_text TEXT NOT NULL
    ) STRICT;
    INSERT INTO customers (id, name) VALUES ('c1', 'Север');
    INSERT INTO cases (id, customer_id, title) VALUES ('case-1', 'c1', 'Склад');
    INSERT INTO source_files (id, case_id, name, layer, extracted_text)
    VALUES ('file-1', 'case-1', 'заметка.txt', 'material', '${PHRASE}');
  `);
  database.close();

  const trainer = openTrainer(directory);
  opened.push(trainer);
  const stored = trainer.listSourceFiles("case-1");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.name, "заметка.txt");
  assert.equal(stored[0]?.extractedText, PHRASE);
  assert.equal(stored[0]?.recognized, false);
  assert.equal(trainer.readCase("case-1")?.title, "Склад");
});

function slideXml(paragraphs: readonly string[]): string {
  const body = paragraphs
    .map((text) => `<a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}
