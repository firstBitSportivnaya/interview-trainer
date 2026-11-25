import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = join(process.cwd(), "data", "models");
const weightsDirectory = join(root, "multilingual-e5-small");
const tesseractDirectory = join(root, "tesseract");
const modelRepo = "Xenova/multilingual-e5-small";
const trainedData =
  "https://github.com/tesseract-ocr/tessdata_fast/raw/main/rus.traineddata";

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed ${response.status} ${url}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, destination);
  console.log(destination);
}

async function modelFiles(prefix) {
  const url = `https://huggingface.co/api/models/${modelRepo}/tree/main${prefix}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`model list failed ${response.status} ${url}`);
  }
  const entries = await response.json();
  const files = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.type !== "string") {
      continue;
    }
    if (entry.type === "directory") {
      files.push(...(await modelFiles(`/${entry.path}`)));
      continue;
    }
    if (entry.type === "file" && !entry.path.split("/").some((part) => part.startsWith("."))) {
      files.push(entry.path);
    }
  }
  return files;
}

const files = await modelFiles("");
for (const path of files) {
  const url = `https://huggingface.co/${modelRepo}/resolve/main/${path}`;
  await download(url, join(weightsDirectory, path));
}
await download(trainedData, join(tesseractDirectory, "rus.traineddata"));
