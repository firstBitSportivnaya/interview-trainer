import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { liveModel, ModelFailure, type ModelCall } from "../src/model.ts";
import type { Protocol } from "../src/trainer.ts";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<Server> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function origin(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function callFor(protocol: Protocol, baseAddress: string): ModelCall {
  return {
    protocol,
    baseAddress,
    modelName: protocol === "anthropic" ? "claude-sonnet" : "deepseek-chat",
    secret: protocol === "anthropic" ? "test-secret-anthropic" : "test-secret-openai",
    messages: [
      { role: "user", text: "Какой срок поставки?" },
      { role: "assistant", text: "Смотрю склад." },
      { role: "user", text: "И?" },
    ],
  };
}

test("адаптер Anthropic отдаёт речь потоком", { timeout: 2000 }, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let url = "";
  let headers: IncomingMessage["headers"] = {};
  let body: unknown;

  const server = await listen(async (request, response) => {
    url = request.url ?? "";
    headers = request.headers;
    body = JSON.parse(await readBody(request)) as unknown;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write('data: {"type":"message_start","message":{"content":[]}}\n\n');
    response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ср');
    response.write('ок "}}\n\n');
    await gate;
    response.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"— июнь."}}\n\n',
    );
    response.end();
  });

  try {
    const iterator = liveModel()
      .complete(callFor("anthropic", `${origin(server)}/`), new AbortController().signal)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(url, "/v1/messages");
    assert.equal(headers["x-api-key"], "test-secret-anthropic");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers.authorization, undefined);
    assert.deepEqual(body, {
      model: "claude-sonnet",
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: "user", content: "Какой срок поставки?" },
        { role: "assistant", content: "Смотрю склад." },
        { role: "user", content: "И?" },
      ],
    });
    assert.deepEqual(first.value, "Срок ");
    release();
    assert.deepEqual((await iterator.next()).value, "— июнь.");
    assert.equal((await iterator.next()).done, true);
  } finally {
    release();
    await close(server);
  }
});

test("адаптер, совместимый с OpenAI, отдаёт речь потоком", async () => {
  let url = "";
  let headers: IncomingMessage["headers"] = {};
  let body: unknown;

  const server = await listen(async (request, response) => {
    url = request.url ?? "";
    headers = request.headers;
    body = JSON.parse(await readBody(request)) as unknown;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"Срок "}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"— июнь."}}]}',
        "",
        'data: {"choices":[{"delta":{}}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );
  });

  try {
    const chunks: string[] = [];
    for await (const text of liveModel().complete(callFor("openai-compatible", origin(server)), new AbortController().signal)) {
      chunks.push(text);
    }
    assert.equal(url, "/v1/chat/completions");
    assert.equal(headers.authorization, "Bearer test-secret-openai");
    assert.equal(headers["x-api-key"], undefined);
    assert.deepEqual(body, {
      model: "deepseek-chat",
      stream: true,
      messages: [
        { role: "user", content: "Какой срок поставки?" },
        { role: "assistant", content: "Смотрю склад." },
        { role: "user", content: "И?" },
      ],
    });
    assert.deepEqual(chunks, ["Срок ", "— июнь."]);
  } finally {
    await close(server);
  }
});

test("ошибка адаптера не становится речью", async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    const leak = request.url === "/v1/messages" ? "сбой-anthropic" : "сбой-openai";
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: leak } }));
  });

  try {
    for (const protocol of ["anthropic", "openai-compatible"] as const) {
      const chunks: string[] = [];
      await assert.rejects(
        async () => {
          for await (const text of liveModel().complete(callFor(protocol, origin(server)), new AbortController().signal)) {
            chunks.push(text);
          }
        },
        (error: unknown) => {
          assert.ok(error instanceof ModelFailure);
          assert.equal(error.reason, "model");
          assert.equal(error.message.includes("сбой-"), false);
          return true;
        },
      );
      assert.deepEqual(chunks, []);
    }
  } finally {
    await close(server);
  }
});

test("ошибка внутри потока не становится речью", async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/v1/messages") {
      response.end('data: {"type":"error","error":{"type":"overloaded_error","message":"сбой-потока"}}\n\n');
      return;
    }
    response.end('data: {"error":{"message":"сбой-потока"}}\n\n');
  });

  try {
    for (const protocol of ["anthropic", "openai-compatible"] as const) {
      const chunks: string[] = [];
      await assert.rejects(
        async () => {
          for await (const text of liveModel().complete(callFor(protocol, origin(server)), new AbortController().signal)) {
            chunks.push(text);
          }
        },
        (error: unknown) => {
          assert.ok(error instanceof ModelFailure);
          assert.equal(error.reason, "model");
          assert.equal(error.message.includes("сбой-потока"), false);
          return true;
        },
      );
      assert.deepEqual(chunks, []);
    }
  } finally {
    await close(server);
  }
});

test("обрыв чтения останавливает адаптер", { timeout: 2000 }, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Срок "}}]}\n\n');
    await gate;
    response.end('data: {"choices":[{"delta":{"content":"— июнь."}}]}\n\n');
  });

  try {
    const iterator = liveModel()
      .complete(callFor("openai-compatible", origin(server)), new AbortController().signal)
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, "Срок ");
    await iterator.return?.();
  } finally {
    release();
    await close(server);
  }
});

test("таймаут адаптера не становится речью", { timeout: 2000 }, async () => {
  const server = await listen((request) => {
    request.resume();
  });

  try {
    for (const protocol of ["anthropic", "openai-compatible"] as const) {
      const chunks: string[] = [];
      await assert.rejects(
        async () => {
          for await (const text of liveModel({ timeoutMs: 100 }).complete(
            callFor(protocol, origin(server)),
            new AbortController().signal,
          )) {
            chunks.push(text);
          }
        },
        (error: unknown) => {
          assert.ok(error instanceof ModelFailure);
          assert.equal(error.reason, "timeout");
          return true;
        },
      );
      assert.deepEqual(chunks, []);
    }
  } finally {
    await close(server);
  }
});
