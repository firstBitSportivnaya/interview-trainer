import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { DRAFT_TOKENS, liveModel, ModelFailure, REPLY_TOKENS, REVIEW_TOKENS, type ModelCall } from "../src/model.ts";
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
    response.end('data: {"type":"message_stop"}\n\n');
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
      max_tokens: REPLY_TOKENS,
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

test("чужой протокол не уходит в запрос", async () => {
  let hits = 0;
  const server = await listen((request, response) => {
    hits += 1;
    request.resume();
    response.writeHead(204);
    response.end();
  });

  try {
    const chunks: string[] = [];
    await assert.rejects(
      async () => {
        for await (const text of liveModel().complete(
          { ...callFor("anthropic", origin(server)), protocol: "grpc" as Protocol },
          new AbortController().signal,
        )) {
          chunks.push(text);
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelFailure);
        assert.equal(error.reason, "model");
        return true;
      },
    );
    assert.equal(hits, 0);
    assert.deepEqual(chunks, []);
  } finally {
    await close(server);
  }
});

test("обрыв потока без конца протокола остаётся отказом", async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/v1/messages") {
      response.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Срок "}}\n\n');
      return;
    }
    response.end('data: {"choices":[{"delta":{"content":"Срок "}}]}\n\n');
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
          assert.equal(error.message.includes("Срок"), false);
          return true;
        },
      );
      assert.deepEqual(chunks, ["Срок "]);
    }
  } finally {
    await close(server);
  }
});

test("неполный кадр длиннее 64 КиБ не становится речью", async () => {
  const payload = `секрет-кадра${"x".repeat(64 * 1024)}`;
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${payload}`);
  });

  try {
    const chunks: string[] = [];
    await assert.rejects(
      async () => {
        for await (const text of liveModel().complete(
          callFor("openai-compatible", origin(server)),
          new AbortController().signal,
        )) {
          chunks.push(text);
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelFailure);
        assert.equal(error.reason, "model");
        assert.equal(error.message.includes("секрет-кадра"), false);
        return true;
      },
    );
    assert.deepEqual(chunks, []);
  } finally {
    await close(server);
  }
});

test("обрыв чтения останавливает адаптер", { timeout: 2000 }, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markClosed = () => {};
  const dropped = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = await listen(async (request, response) => {
    await readBody(request);
    let finished = false;
    response.on("close", () => {
      if (!finished) markClosed();
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Срок "}}]}\n\n');
    await gate;
    finished = true;
    response.end('data: {"choices":[{"delta":{"content":"— июнь."}}]}\n\ndata: [DONE]\n\n');
  });

  try {
    const iterator = liveModel()
      .complete(callFor("openai-compatible", origin(server)), new AbortController().signal)
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, "Срок ");
    await iterator.return?.();
    await dropped;
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("куски чаще паузы не срывают ответ длиннее этой паузы", { timeout: 5000 }, async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Срок "}}]}\n\n');
    await pause(150);
    response.write('data: {"choices":[{"delta":{"content":"— июнь."}}]}\n\n');
    await pause(150);
    response.end("data: [DONE]\n\n");
  });

  try {
    const chunks: string[] = [];
    for await (const text of liveModel({ timeoutMs: 200 }).complete(
      callFor("openai-compatible", origin(server)),
      new AbortController().signal,
    )) {
      chunks.push(text);
    }
    assert.deepEqual(chunks, ["Срок ", "— июнь."]);
  } finally {
    await close(server);
  }
});

test("тишина между кусками дольше паузы — сбой, обрезок не речь", { timeout: 5000 }, async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"Срок поставки — "}}]}\n\n');
    await pause(400);
    if (!response.writableEnded) response.end("data: [DONE]\n\n");
  });

  try {
    const chunks: string[] = [];
    await assert.rejects(
      async () => {
        for await (const text of liveModel({ timeoutMs: 80 }).complete(
          callFor("openai-compatible", origin(server)),
          new AbortController().signal,
        )) {
          chunks.push(text);
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ModelFailure);
        assert.equal(error.reason, "timeout");
        assert.equal(error.message.includes("Срок поставки"), false);
        return true;
      },
    );
    assert.equal(chunks.join("").includes("июнь"), false);
  } finally {
    await close(server);
  }
});

test("обрыв по длине не становится речью ни в одном протоколе", async () => {
  const phrase = "Срок поставки — ";
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/v1/messages") {
      response.end(
        [
          `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(phrase)}}}`,
          "",
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
          "",
          'data: {"type":"message_stop"}',
          "",
          "",
        ].join("\n"),
      );
      return;
    }
    response.end(
      [
        `data: {"choices":[{"delta":{"content":${JSON.stringify(phrase)}}}]}`,
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );
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
          assert.equal(error.message.includes(phrase), false);
          return true;
        },
      );
      assert.equal(chunks.every((chunk) => chunk === phrase), true);
      assert.notEqual(chunks.join(""), "");
    }
  } finally {
    await close(server);
  }
});

test("конец реплики end_turn остаётся речью", async () => {
  const server = await listen(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Срок — июнь."}}',
        "",
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        "",
        'data: {"type":"message_stop"}',
        "",
        "",
      ].join("\n"),
    );
  });

  try {
    const chunks: string[] = [];
    for await (const text of liveModel().complete(callFor("anthropic", origin(server)), new AbortController().signal)) {
      chunks.push(text);
    }
    assert.deepEqual(chunks, ["Срок — июнь."]);
  } finally {
    await close(server);
  }
});

test("потолки реплики, черновика и разбора разные, черновик вмещает 64 КиБ", async () => {
  const bodies: Array<{ max_tokens?: number }> = [];
  const server = await listen(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)) as { max_tokens?: number });
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/v1/messages") {
      response.end('data: {"type":"message_stop"}\n\n');
      return;
    }
    response.end('data: {"choices":[{"delta":{"content":"ок"}}]}\n\ndata: [DONE]\n\n');
  });

  try {
    for (const protocol of ["anthropic", "openai-compatible"] as const) {
      for (const maxTokens of [undefined, DRAFT_TOKENS, REVIEW_TOKENS] as const) {
        const call = callFor(protocol, origin(server));
        if (maxTokens !== undefined) call.maxTokens = maxTokens;
        for await (const text of liveModel().complete(call, new AbortController().signal)) {
          assert.equal(typeof text, "string");
        }
      }
    }
    assert.deepEqual(
      bodies.map((body) => body.max_tokens),
      [REPLY_TOKENS, DRAFT_TOKENS, REVIEW_TOKENS, REPLY_TOKENS, DRAFT_TOKENS, REVIEW_TOKENS],
    );
    assert.ok(DRAFT_TOKENS >= 64 * 1024);
    assert.notEqual(DRAFT_TOKENS, REPLY_TOKENS);
    assert.notEqual(REVIEW_TOKENS, REPLY_TOKENS);
  } finally {
    await close(server);
  }
});

test("вызов с прокси идёт через прокси, без прокси — напрямую", async () => {
  let originHits = 0;
  const originServer = await listen((request, response) => {
    originHits += 1;
    assert.equal(request.url, "/v1/messages");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"июнь"}}\n\ndata: {"type":"message_stop"}\n\n');
  });
  let proxyHits = 0;
  const proxy = await listen(async (request, response) => {
    proxyHits += 1;
    const target = new URL(request.url ?? "");
    const body = await readBody(request);
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-api-key": request.headers["x-api-key"] ?? "",
          "anthropic-version": request.headers["anthropic-version"] ?? "",
        },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          "content-type": upstreamResponse.headers["content-type"] ?? "text/plain",
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    upstream.end(body);
  });

  try {
    const base = origin(originServer);
    const direct = callFor("anthropic", base);
    let text = "";
    for await (const chunk of liveModel().complete(direct, new AbortController().signal)) text += chunk;
    assert.equal(text, "июнь");
    assert.equal(proxyHits, 0);
    assert.equal(originHits, 1);

    const viaProxy = {
      ...callFor("anthropic", base),
      proxyUrl: `http://owner:secret-proxy@127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    };
    text = "";
    for await (const chunk of liveModel().complete(viaProxy, new AbortController().signal)) text += chunk;
    assert.equal(text, "июнь");
    assert.equal(text.includes("secret-proxy"), false);
    assert.equal(proxyHits, 1);
    assert.equal(originHits, 2);
  } finally {
    await close(proxy);
    await close(originServer);
  }

  const refused = await listen(() => undefined);
  const refusedOrigin = origin(refused);
  await close(refused);
  const refusedCall = {
    ...callFor("anthropic", "http://127.0.0.1:9"),
    proxyUrl: `http://owner:secret-proxy@${new URL(refusedOrigin).host}`,
  };
  await assert.rejects(
    (async () => {
      for await (const chunk of liveModel().complete(refusedCall, new AbortController().signal)) {
        assert.equal(chunk, "");
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof ModelFailure);
      assert.equal(error.detail, "proxy");
      assert.equal(String(error).includes("secret-proxy"), false);
      return true;
    },
  );
});

test("отказ вызова различает секрет, объём и обрыв соединения", async () => {
  const server = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model?: string };
    if (body.model === "too-big") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "prompt is too long: 999999 tokens > 200000" },
        }),
      );
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "authentication_error", message: "СЕКРЕТ-НЕ-ПОКАЗЫВАТЬ" } }));
  });

  const take = async (call: ModelCall) => {
    for await (const text of liveModel().complete(call, new AbortController().signal)) {
      assert.equal(text, "");
    }
  };

  try {
    const base = origin(server);
    await assert.rejects(take(callFor("anthropic", base)), (error: unknown) => {
      assert.ok(error instanceof ModelFailure);
      assert.equal(error.reason, "model");
      assert.equal(error.detail, "auth");
      assert.equal(String(error).includes("СЕКРЕТ"), false);
      return true;
    });
    const large = { ...callFor("anthropic", base), modelName: "too-big" };
    await assert.rejects(take(large), (error: unknown) => {
      assert.ok(error instanceof ModelFailure);
      assert.equal(error.detail, "large");
      assert.equal(String(error).includes("999999"), false);
      return true;
    });
  } finally {
    await close(server);
  }

  const probe = await listen(() => undefined);
  const closed = origin(probe);
  await close(probe);
  await assert.rejects(take(callFor("anthropic", closed)), (error: unknown) => {
    assert.ok(error instanceof ModelFailure);
    assert.equal(error.reason, "model");
    assert.equal(error.detail, "unreachable");
    return true;
  });
});
