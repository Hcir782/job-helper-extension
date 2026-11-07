/**
 * 抽取编排单测（lib/resume-extract.js）
 *
 * 运行：node tests/resume-extract.test.js
 *
 * 这一层最容易出问题的是「流程」而不是单个函数：
 * 修补轮该不该发、发出去之后哪些字段允许被改、失败时要不要保留半成品。
 * 全部用假 fetch 驱动，不联网、不花钱。
 */

const assert = require("assert");
const E = require("../lib/resume-extract.js");
const L = require("../lib/llm-client.js");
const S = require("../lib/resume-schema.js");

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

const CFG = { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-test", model: "deepseek-chat", maxAttempts: 1 };
const noWait = { sleep: async () => {} };

/** 造一份完整的 44 字段输出 */
function full(over) {
  const d = S.emptyData();
  d.name = "王瑞瑶";
  d.gender = "女";
  d.phone = "15248522685";
  d.email = "wangruiyao87@gmail.com";
  d.education = "本科";
  d.school = "大连科技学院";
  d.major = "网络工程";
  d.graduationYear = "2027-06";
  return Object.assign(d, over || {});
}

/** 假 fetch：按顺序吐内容字符串（每项会被包成标准 chat 响应），并记录请求 */
function seqFetch(contents) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const c = contents[Math.min(i, contents.length - 1)];
    i++;
    const text = typeof c === "function" ? c() : c;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
      }),
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

function runWith(fetchFn, text, extra) {
  return E.extract(
    text,
    Object.assign(
      { llm: L, cfg: CFG, deps: Object.assign({ fetch: fetchFn }, noWait) },
      extra || {}
    )
  );
}

console.log("抽取编排单测：");

test("buildSystemPrompt：列出 44 字段与枚举允许值", () => {
  const p = E.buildSystemPrompt();
  assert.ok(p.includes("name 姓名"));
  assert.ok(p.includes("hobbies 兴趣爱好"));
  assert.ok(p.includes("男 / 女"), "枚举必须把允许值写清楚");
  assert.ok(p.includes("绝对不要猜测"));
});

test("buildSystemPrompt：示例输出本身就是合法 JSON 且字段齐全", () => {
  const p = E.buildSystemPrompt();
  const m = p.match(/示例输出：(\{[\s\S]*?\})\n/);
  assert.ok(m, "prompt 里的示例必须能被正则捞出");
  const obj = JSON.parse(m[1]);
  assert.deepStrictEqual(Object.keys(obj).sort(), S.FIELDS.slice().sort());
  // 示例自己也得过校验，否则模型会照着错的学
  const v = S.validate(obj);
  assert.strictEqual(v.ok, true);
});

test("buildUserPrompt：多段时说明是第几段", () => {
  const p = E.buildUserPrompt("内容", { index: 2, total: 3 });
  assert.ok(p.includes("第 2/3 段"));
  assert.ok(p.includes("内容"));
});

test("mergeChunks：第一个非空值优先", () => {
  const a = { name: "王瑞瑶", school: "" };
  const b = { name: "别的名字", school: "大连科技学院" };
  const m = E.mergeChunks([a, b]);
  assert.strictEqual(m.name, "王瑞瑶");
  assert.strictEqual(m.school, "大连科技学院");
});

test("mergeChunks：长文本字段追加而不是覆盖", () => {
  const a = { projectExp: "项目一" };
  const b = { projectExp: "项目二" };
  const m = E.mergeChunks([a, b]);
  assert.strictEqual(m.projectExp, "项目一\n项目二");
});

test("mergeChunks：重复内容不重复追加", () => {
  const a = { projectExp: "项目一" };
  const m = E.mergeChunks([a, { projectExp: "项目一" }]);
  assert.strictEqual(m.projectExp, "项目一");
});

test("splitByChars：短文本不分段", () => {
  assert.deepStrictEqual(E.splitByChars("abc", 100), ["abc"]);
});

test("splitByChars：长文本分段且拼回无损", () => {
  const s = "字".repeat(500);
  const parts = E.splitByChars(s, 100);
  assert.strictEqual(parts.join(""), s);
  assert.ok(parts.length >= 5);
});

test("extract：一次调用就抽干净的简历，不触发修补", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const r = await runWith(f, "王瑞瑶 女 大连科技学院 网络工程");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.name, "王瑞瑶");
  assert.strictEqual(r.repairRounds, 0);
  assert.strictEqual(r.meter.calls, 1);
  assert.strictEqual(f.calls.length, 1);
});

test("extract：记录 token 用量与耗时", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.meter.promptTokens, 800);
  assert.strictEqual(r.meter.completionTokens, 400);
  assert.ok(r.meter.ms >= 0);
});

test("extract：邮箱格式错 → 只对 email 发起一轮修补", async () => {
  const bad = full({ email: "不是邮箱" });
  const good = full({ email: "wangruiyao87@gmail.com" });
  const f = seqFetch([JSON.stringify(bad), JSON.stringify(good)]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.repairRounds, 1);
  assert.strictEqual(r.data.email, "wangruiyao87@gmail.com");
  assert.strictEqual(r.unrepaired.length, 0);
  // 第二条请求应该带上「只重新抽取这几个字段」的指示
  const last = f.calls[1].messages.map((m) => m.content).join("\n");
  assert.ok(last.includes("email"));
  assert.ok(last.includes("只重新抽取这几个字段"));
});

test("extract：修补时只接受不合格字段的新值，不改已经对的字段", async () => {
  const bad = full({ phone: "123" });
  // 模型顺手把 name 也改了
  const repaired = full({ phone: "15248522685", name: "王小明" });
  const f = seqFetch([JSON.stringify(bad), JSON.stringify(repaired)]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.data.phone, "15248522685", "不合格的该被修");
  assert.strictEqual(r.data.name, "王瑞瑶", "已合格的字段不该被顺手改掉");
});

test("extract：修补两轮仍不合格 → needsReview 为真", async () => {
  // 每轮都「改」成一个仍然不合格的新值，才能把两轮修补都走完
  const bad = full({ email: "坏邮箱" });
  const ok = full();
  let i = 0;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    // 主抽取 → 坏邮箱；修补轮依次给两个不同的坏值
    const payload = i === 0 ? bad : full({ email: `坏邮箱${i}` });
    i++;
    const text = JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      text: async () => text,
    };
  };
  const r = await runWith(fetchFn, "简历");
  assert.strictEqual(r.repairRounds, 2, "最多两轮，不能无限问下去");
  assert.strictEqual(r.needsReview, true);
  assert.ok(r.unrepaired.includes("email"));
  assert.strictEqual(i, 3, "主抽取 1 次 + 修补 2 次");
});

test("extract：修补没进展（模型原样返回）就提前收手，不浪费第二轮", async () => {
  const bad = full({ email: "坏邮箱" });
  const f = seqFetch([JSON.stringify(bad), JSON.stringify(bad)]);
  const r = await runWith(f, "简历");
  assert.strictEqual(f.calls.length, 2, "一次主抽取 + 一次无效修补后应停止");
  assert.strictEqual(r.needsReview, true);
});

test("extract：maxRepairRounds=0 时完全不修补", async () => {
  const f = seqFetch([JSON.stringify(full({ email: "坏" }))]);
  const r = await runWith(f, "简历", { maxRepairRounds: 0 });
  assert.strictEqual(r.repairRounds, 0);
  assert.strictEqual(f.calls.length, 1);
});

test("extract：模型第一次返回非 JSON → 自动重问一次", async () => {
  const f = seqFetch(["抱歉，我无法完成。", JSON.stringify(full())]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.data.name, "王瑞瑶");
  assert.strictEqual(f.calls.length, 2);
  // 第二次要把失败原因告诉模型
  const joined = f.calls[1].messages.map((m) => m.content).join("\n");
  assert.ok(joined.includes("不合格"));
});

test("extract：连续两次都返回垃圾 → 抛出带 stage 的错误", async () => {
  const f = seqFetch(["不知道", "还是不知道"]);
  await assert.rejects(
    () => runWith(f, "简历"),
    (e) => /抽取失败/.test(e.message) && e.stage === "parse"
  );
});

test("extract：空文本直接拒绝，不调用模型", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  await assert.rejects(() => runWith(f, "   \n  "), /扫描件/);
  assert.strictEqual(f.calls.length, 0);
});

test("extract：超长简历自动分块，每块一次调用", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const long = "简历内容".repeat(2000); // 8000 字，按 2000 字分块 → 4 段
  const r = await runWith(f, long, { chunkChars: 2000 });
  assert.strictEqual(r.chunks, 4);
  assert.strictEqual(f.calls.length, 4);
  assert.strictEqual(f.calls.length, r.meter.calls);
});

test("extract：鉴权错误向上抛，不静默返回空数据", async () => {
  const fn = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => "invalid api key",
    json: async () => ({}),
  });
  await assert.rejects(() => runWith(fn, "简历"), (e) => e instanceof L.FatalError);
});

test("extract：onProgress 按阶段回调，顺序可预测", async () => {
  const events = [];
  const f = seqFetch([JSON.stringify(full({ email: "坏" })), JSON.stringify(full())]);
  await runWith(f, "简历", { onProgress: (stage) => events.push(stage) });
  assert.strictEqual(events[0], "extract");
  assert.ok(events.includes("extract-done"));
  assert.ok(events.includes("repair"));
  assert.strictEqual(events[events.length - 1], "done");
});

test("extract：missing 列表供 UI 显示「待补充」", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.missing.length, 44 - 8);
});

test("extract：枚举越界由校验层收敛，不算修补失败", async () => {
  const f = seqFetch([JSON.stringify(full({ gender: "女性" }))]);
  const r = await runWith(f, "简历");
  assert.strictEqual(r.data.gender, "女");
  assert.strictEqual(r.repairRounds, 0, "能确定性收敛的就不该再花一次请求");
});

console.log(`\n结果：${passed} 条通过`);
