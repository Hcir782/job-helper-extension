/**
 * 大模型调用层单测（lib/llm-client.js）
 *
 * 运行：node tests/llm-client.test.js
 *
 * 全部用假的 fetch，不发真实请求：
 * 重点是「失败怎么归类、什么时候该重试、什么时候该降级」，
 * 这几条判断错了，线上表现就是无限转圈或者明明 Key 错了还一直重试。
 */

const assert = require("assert");
const L = require("../lib/llm-client.js");

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    process.exitCode = 1;
  }
}

/** 造一个假的 fetch：按顺序吐预设响应，并记录每次请求体 */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (typeof r === "function") return r(url, init);
    return makeResp(r.status || 200, r.body);
  };
  fn.calls = calls;
  return fn;
}

function makeResp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function okResp(content, usage) {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: usage || { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  };
}

const noWait = { sleep: async () => {} };
const CFG = { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-test", model: "deepseek-chat", maxAttempts: 3 };

console.log("大模型调用层单测：");

test("chatURL：只填域名时补 /v1/chat/completions", () => {
  assert.strictEqual(L.chatURL("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
});

test("chatURL：已带 /v1 不重复拼接", () => {
  assert.strictEqual(L.chatURL("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
});

test("chatURL：已经是完整路径就原样用", () => {
  assert.strictEqual(L.chatURL("http://localhost:11434/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
});

test("chatURL：本地 Ollama 风格地址也能收敛", () => {
  assert.strictEqual(L.chatURL("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("buildBody：json_schema 档位带 strict schema", () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const b = L.buildBody({ model: "m", messages: [], schema, mode: "json_schema" });
  assert.strictEqual(b.response_format.type, "json_schema");
  assert.strictEqual(b.response_format.json_schema.strict, true);
  assert.deepStrictEqual(b.response_format.json_schema.schema, schema);
});

test("buildBody：json_object 档位只要求是 JSON", () => {
  const b = L.buildBody({ model: "m", messages: [], mode: "json_object" });
  assert.deepStrictEqual(b.response_format, { type: "json_object" });
});

test("buildBody：prompt_only 档位不带 response_format", () => {
  const b = L.buildBody({ model: "m", messages: [], mode: "prompt_only" });
  assert.strictEqual(b.response_format, undefined);
});

test("buildBody：temperature 默认 0（抽取任务要稳定）", () => {
  assert.strictEqual(L.buildBody({ model: "m", messages: [] }).temperature, 0);
});

test("callOnce：正常返回内容与 token 用量", async () => {
  const f = fakeFetch([okResp('{"name":"王瑞瑶"}')]);
  const r = await L.callOnce(CFG, [{ role: "user", content: "hi" }], { fetch: f });
  assert.strictEqual(r.content, '{"name":"王瑞瑶"}');
  assert.strictEqual(r.usage.total, 150);
  assert.strictEqual(f.calls[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(f.calls[0].init.headers.Authorization, "Bearer sk-test");
});

test("callOnce：没 Key 直接抛 FatalError 且不发请求", async () => {
  const f = fakeFetch([okResp("{}")]);
  await assert.rejects(
    () => L.callOnce({ model: "m" }, [], { fetch: f }),
    (e) => e instanceof L.FatalError && /API Key/.test(e.message)
  );
  assert.strictEqual(f.calls.length, 0);
});

test("callOnce：401 → FatalError 并提示检查 Key", async () => {
  const f = fakeFetch([{ status: 401, body: { error: "invalid key" } }]);
  await assert.rejects(
    () => L.callOnce(CFG, [], { fetch: f }),
    (e) => e instanceof L.FatalError && /API Key/.test(e.message) && !!e.hint
  );
});

test("callOnce：429 → RetryableError", async () => {
  const f = fakeFetch([{ status: 429, body: { error: "rate limit" } }]);
  await assert.rejects(() => L.callOnce(CFG, [], { fetch: f }), (e) => e instanceof L.RetryableError);
});

test("callOnce：500 → RetryableError", async () => {
  const f = fakeFetch([{ status: 500, body: "boom" }]);
  await assert.rejects(() => L.callOnce(CFG, [], { fetch: f }), (e) => e instanceof L.RetryableError);
});

test("callOnce：400 → FatalError 且标记 unsupportedParam（留给降级用）", async () => {
  const f = fakeFetch([{ status: 400, body: { error: "response_format not supported" } }]);
  await assert.rejects(
    () => L.callOnce(CFG, [], { fetch: f }),
    (e) => e instanceof L.FatalError && e.unsupportedParam === true
  );
});

test("callOnce：网络异常归为可重试", async () => {
  const f = fakeFetch([() => { throw new TypeError("Failed to fetch"); }]);
  await assert.rejects(() => L.callOnce(CFG, [], { fetch: f }), (e) => e instanceof L.RetryableError);
});

test("callOnce：finish_reason=length 时给出可操作提示", async () => {
  const f = fakeFetch([
    { status: 200, body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } },
  ]);
  await assert.rejects(
    () => L.callOnce(CFG, [], { fetch: f }),
    (e) => e instanceof L.FatalError && /截断/.test(e.message) && /max_tokens/.test(e.hint)
  );
});

test("pickContent：兼容 tool_calls 里塞 JSON 的网关", () => {
  const c = L.pickContent({
    choices: [{ message: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }],
  });
  assert.strictEqual(c, '{"a":1}');
});

test("callWithRetry：429 后自动重试并成功，记录次数", async () => {
  const f = fakeFetch([
    { status: 429, body: { error: "slow down" } },
    okResp('{"ok":1}'),
  ]);
  const r = await L.callWithRetry(CFG, [], Object.assign({ fetch: f }, noWait));
  assert.strictEqual(r.content, '{"ok":1}');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(f.calls.length, 2);
});

test("callWithRetry：连续 5xx 用满重试次数后抛出", async () => {
  const f = fakeFetch([{ status: 503, body: "down" }]);
  await assert.rejects(
    () => L.callWithRetry(Object.assign({}, CFG, { maxAttempts: 3 }), [], Object.assign({ fetch: f }, noWait)),
    (e) => e instanceof L.RetryableError && e.attempts === 3
  );
  assert.strictEqual(f.calls.length, 3);
});

test("callWithRetry：401 不重试，只发一次", async () => {
  const f = fakeFetch([{ status: 401, body: "no" }]);
  await assert.rejects(
    () => L.callWithRetry(CFG, [], Object.assign({ fetch: f }, noWait)),
    (e) => e instanceof L.FatalError
  );
  assert.strictEqual(f.calls.length, 1, "鉴权错误重试 3 次纯属浪费用户时间");
});

test("callAuto：json_schema 不被支持时自动降到 json_object", async () => {
  const schema = { type: "object", properties: {} };
  const f = fakeFetch([
    { status: 400, body: { error: "json_schema unsupported" } },
    okResp('{"name":"王瑞瑶"}'),
  ]);
  const r = await L.callAuto(Object.assign({}, CFG, { schema }), [], Object.assign({ fetch: f }, noWait));
  assert.strictEqual(r.mode, "json_object");
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(f.calls[0].body.response_format.type, "json_schema");
  assert.strictEqual(f.calls[1].body.response_format.type, "json_object");
});

test("callAuto：前两档都不支持时降到 prompt_only", async () => {
  const schema = { type: "object", properties: {} };
  const f = fakeFetch([
    { status: 400, body: { error: "no json_schema" } },
    { status: 400, body: { error: "no response_format" } },
    okResp('{"name":"王瑞瑶"}'),
  ]);
  const r = await L.callAuto(Object.assign({}, CFG, { schema }), [], Object.assign({ fetch: f }, noWait));
  assert.strictEqual(r.mode, "prompt_only");
  assert.strictEqual(f.calls[2].body.response_format, undefined);
});

test("callAuto：鉴权错误不降级，直接终止", async () => {
  const schema = { type: "object", properties: {} };
  const f = fakeFetch([{ status: 401, body: "bad key" }]);
  await assert.rejects(
    () => L.callAuto(Object.assign({}, CFG, { schema }), [], Object.assign({ fetch: f }, noWait)),
    (e) => e instanceof L.FatalError
  );
  assert.strictEqual(f.calls.length, 1, "Key 错了换档位也不可能成功");
});

test("callAuto：没传 schema 时不尝试 json_schema 档", async () => {
  const f = fakeFetch([okResp("{}")]);
  const r = await L.callAuto(CFG, [], Object.assign({ fetch: f }, noWait));
  assert.strictEqual(r.mode, "json_object");
  assert.strictEqual(f.calls.length, 1);
});

test("ping：成功时 ok=true 并回报耗时", async () => {
  const f = fakeFetch([okResp("ok")]);
  const r = await L.ping(CFG, { fetch: f });
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.ms === "number");
  assert.strictEqual(f.calls[0].body.max_tokens, 16);
});

test("ping：失败时把原因与建议一起带回，不抛异常", async () => {
  const f = fakeFetch([{ status: 401, body: "bad" }]);
  const r = await L.ping(CFG, { fetch: f });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message);
  assert.ok(r.hint);
});

console.log(`\n结果：${passed} 条通过`);
