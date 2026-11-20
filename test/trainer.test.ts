import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openTrainer } from "../src/trainer.ts";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trainer-"));
  directories.push(directory);
  return directory;
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("владелец сохраняет ключ, и список не показывает секрет целиком", () => {
  const trainer = openTrainer(tempDirectory());
  const secret = "sk-ant-api03-secret-WXYZ";

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret,
  });

  const keys = trainer.listKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.protocol, "anthropic");
  assert.equal(keys[0]?.baseAddress, "https://api.anthropic.com");
  assert.equal(keys[0]?.modelName, "claude-sonnet");
  assert.equal(keys[0]?.secretPreview, "••••WXYZ");
  assert.equal(JSON.stringify(keys).includes(secret), false);
});

test("второй ключ сохраняется отдельно от первого", () => {
  const trainer = openTrainer(tempDirectory());

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });
  trainer.saveKey({
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
  });

  const keys = trainer.listKeys();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0]?.id, keys[1]?.id);
  assert.deepEqual(
    keys.map((key) => ({
      protocol: key.protocol,
      baseAddress: key.baseAddress,
      modelName: key.modelName,
      secretPreview: key.secretPreview,
    })),
    [
      {
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secretPreview: "••••WXYZ",
      },
      {
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secretPreview: "••••9876",
      },
    ],
  );
  assert.equal(JSON.stringify(keys).includes("sk-ant-api03-secret-WXYZ"), false);
  assert.equal(JSON.stringify(keys).includes("sk-deepseek-secret-9876"), false);
});

test("после перезапуска список ключей на месте, секрет не раскрыт", () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory);
  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });
  trainer.saveKey({
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
  });

  const keys = openTrainer(directory).listKeys();
  assert.deepEqual(
    keys.map((key) => ({
      protocol: key.protocol,
      baseAddress: key.baseAddress,
      modelName: key.modelName,
      secretPreview: key.secretPreview,
    })),
    [
      {
        protocol: "anthropic",
        baseAddress: "https://api.anthropic.com",
        modelName: "claude-sonnet",
        secretPreview: "••••WXYZ",
      },
      {
        protocol: "openai-compatible",
        baseAddress: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        secretPreview: "••••9876",
      },
    ],
  );
  assert.equal(JSON.stringify(keys).includes("sk-ant-api03-secret-WXYZ"), false);
  assert.equal(JSON.stringify(keys).includes("sk-deepseek-secret-9876"), false);
});

test("ключ принимается только когда заполнены все четыре поля", () => {
  const trainer = openTrainer(tempDirectory());
  const complete = {
    protocol: "anthropic" as const,
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  };

  for (const field of ["protocol", "baseAddress", "modelName", "secret"] as const) {
    const saved = trainer.saveKey({ ...complete, [field]: "  " });
    assert.deepEqual(saved, { ok: false, reason: "incomplete" });
  }

  assert.deepEqual(trainer.listKeys(), []);
});

test("протокол ключа — Anthropic или совместимый с OpenAI", () => {
  const trainer = openTrainer(tempDirectory());
  const saved = trainer.saveKey({
    protocol: "grpc",
    baseAddress: "https://example.test",
    modelName: "other",
    secret: "sk-other-secret-1234",
  });

  assert.deepEqual(saved, { ok: false, reason: "protocol" });
  assert.deepEqual(trainer.listKeys(), []);
});

test("короткий секрет в списке не раскрыт целиком", () => {
  const trainer = openTrainer(tempDirectory());
  const secret = "ab12";

  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret,
  });

  const keys = trainer.listKeys();
  assert.equal(keys[0]?.secretPreview, "••••");
  assert.equal(JSON.stringify(keys).includes(secret), false);
});

test("повреждённый список ключей не затирается", () => {
  const directory = tempDirectory();
  const file = join(directory, "keys.json");
  writeFileSync(file, "{");

  assert.throws(() => openTrainer(directory));
  assert.equal(readFileSync(file, "utf8"), "{");
});

test("неудачная запись не оставляет ключ в списке", () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory);
  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });
  mkdirSync(join(directory, "keys.json.tmp"));

  assert.throws(() =>
    trainer.saveKey({
      protocol: "openai-compatible",
      baseAddress: "https://api.deepseek.com",
      modelName: "deepseek-chat",
      secret: "sk-deepseek-secret-9876",
    }),
  );
  assert.deepEqual(
    trainer.listKeys().map((key) => key.modelName),
    ["claude-sonnet"],
  );

  rmSync(join(directory, "keys.json.tmp"), { recursive: true, force: true });
  trainer.saveKey({
    protocol: "openai-compatible",
    baseAddress: "https://api.deepseek.com",
    modelName: "deepseek-chat",
    secret: "sk-deepseek-secret-9876",
  });

  assert.deepEqual(
    openTrainer(directory).listKeys().map((key) => key.modelName),
    ["claude-sonnet", "deepseek-chat"],
  );
});

test("файл ключа доступен только владельцу", () => {
  const directory = tempDirectory();
  const trainer = openTrainer(directory);
  trainer.saveKey({
    protocol: "anthropic",
    baseAddress: "https://api.anthropic.com",
    modelName: "claude-sonnet",
    secret: "sk-ant-api03-secret-WXYZ",
  });

  assert.equal(trainer.listKeys().length, 1);
  if (process.platform === "win32") {
    return;
  }
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, "keys.json")).mode & 0o777, 0o600);
});
