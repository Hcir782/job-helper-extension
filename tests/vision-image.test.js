/**
 * 图片简历链路单测（lib/vision-image.js + resume-extract 的多模态入口）
 *
 * 运行：node tests/vision-image.test.js
 *
 * canvas 压缩那一步依赖真实 DOM，单测里只钉纯函数：
 * 类型判定、缩放计算、多模态消息构造、报错识别，以及
 * extractFromImages 的完整流程（假 fetch 驱动，与 resume-extract.test.js 同一套手法）。
 */

const assert = require("assert");
const V = require("../lib/vision-image.js");
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

const CFG = { baseURL: "https://api.example.com/v1", apiKey: "sk-test", model: "qwen-vl-plus", maxAttempts: 1 };
const noWait = { sleep: async () => {} };
const PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

/** 造一份完整的 44 字段输出（与 resume-extract.test.js 同款） */
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

/** 假 fetch：按顺序吐内容字符串，并记录请求体 */
function seqFetch(contents) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const c = contents[Math.min(i, contents.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: c }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 400, total_tokens: 1300 },
      }),
      text: async () => c,
    };
  };
  fn.calls = calls;
  return fn;
}

console.log("图片简历链路单测：");

/* ---------- 类型判定 ---------- */

test("isImageFile：MIME 命中即认（jpg/jpeg/png/webp）", () => {
  assert.strictEqual(V.isImageFile("任意名字", "image/jpeg"), true);
  assert.strictEqual(V.isImageFile("a.png", "image/png"), true);
  assert.strictEqual(V.isImageFile("a.webp", "image/webp"), true);
  assert.strictEqual(V.isImageFile("a.gif", "image/gif"), false);
});

test("isImageFile：MIME 为空时按扩展名兜底", () => {
  assert.strictEqual(V.isImageFile("简历.jpg", ""), true);
  assert.strictEqual(V.isImageFile("简历.JPEG", ""), true);
  assert.strictEqual(V.isImageFile("简历.png", ""), true);
  assert.strictEqual(V.isImageFile("简历.pdf", ""), false);
  assert.strictEqual(V.isImageFile("简历", ""), false);
});

test("ACCEPT_ATTR：pdf 与全部图片类型都在文件选择白名单里", () => {
  assert.ok(V.ACCEPT_ATTR.includes("application/pdf"));
  Object.values(V.IMAGE_MIME).forEach((m) => assert.ok(V.ACCEPT_ATTR.includes(m)));
});

/* ---------- 压缩尺寸 ---------- */

test("computeScaledSize：小图原样返回，不放大", () => {
  assert.deepStrictEqual(V.computeScaledSize(800, 600, 2000), { width: 800, height: 600 });
});

test("computeScaledSize：长边等比压到上限", () => {
  const r = V.computeScaledSize(4000, 3000, 2000);
  assert.deepStrictEqual(r, { width: 2000, height: 1500 });
  const r2 = V.computeScaledSize(3000, 4000, 2000);
  assert.deepStrictEqual(r2, { width: 1500, height: 2000 });
});

test("computeScaledSize：极端输入不出 0 尺寸", () => {
  assert.strictEqual(V.computeScaledSize(0, 0, 2000).width >= 1, true);
  assert.strictEqual(V.computeScaledSize(1, 999999, 2000).height, 2000);
});

/* ---------- dataURL 与多模态消息 ---------- */

test("isImageDataUrl：只认 jpeg/png/webp 的 base64 dataURL", () => {
  assert.strictEqual(V.isImageDataUrl(PNG_URL), true);
  assert.strictEqual(V.isImageDataUrl(JPEG_URL), true);
  assert.strictEqual(V.isImageDataUrl("data:image/gif;base64,AAAA"), false);
  assert.strictEqual(V.isImageDataUrl("https://example.com/a.png"), false);
  assert.strictEqual(V.isImageDataUrl(""), false);
});

test("estimateDataUrlBytes：与 base64 长度换算一致", () => {
  const b64 = "QUJD"; // 4 字符 → 3 字节
  assert.strictEqual(V.estimateDataUrlBytes(`data:image/png;base64,${b64}`), 3);
  assert.strictEqual(V.estimateDataUrlBytes("没有逗号"), 0);
});

test("buildImageContent：图片段在前、文字指令在后", () => {
  const parts = V.buildImageContent([PNG_URL], "请抽取");
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0].type, "image_url");
  assert.strictEqual(parts[0].image_url.url, PNG_URL);
  assert.strictEqual(parts[1].type, "text");
  assert.strictEqual(parts[1].text, "请抽取");
});

test("buildImageContent：支持多张图，空列表直接拒绝", () => {
  assert.strictEqual(V.buildImageContent([PNG_URL, JPEG_URL], "x").length, 3);
  assert.throws(() => V.buildImageContent([], "x"), /没有可发送的图片/);
  assert.throws(() => V.buildImageContent(["不是dataURL"], "x"), /dataURL/);
});

/* ---------- 报错识别 ---------- */

test("isVisionUnsupported：各家措辞都能认出来", () => {
  assert.strictEqual(V.isVisionUnsupported("HTTP 400。image_url is not supported by this model"), true);
  assert.strictEqual(V.isVisionUnsupported("HTTP 400。该模型不支持图片输入"), true);
  assert.strictEqual(V.isVisionUnsupported("invalid_image: cannot process the image"), true);
  assert.strictEqual(V.isVisionUnsupported("HTTP 401。API Key 被拒绝"), false);
  assert.strictEqual(V.isVisionUnsupported("HTTP 400。response_format not supported"), false);
});

/* ---------- system prompt ---------- */

test("buildSystemPrompt：默认（文本模式）措辞不变，仍说「PDF 抽取」", () => {
  const p = E.buildSystemPrompt();
  assert.ok(p.includes("文本（可能来自 PDF 抽取"));
  assert.ok(!p.includes("图片（拍照"));
});

test("buildSystemPrompt('image')：首行换成读图指令，其余约束共享", () => {
  const p = E.buildSystemPrompt("image");
  assert.ok(p.includes("简历的图片"));
  assert.ok(p.includes("绝对不要猜测"), "禁止编造的硬约束必须保留");
  assert.ok(p.includes("name 姓名"), "44 字段清单必须保留");
});

/* ---------- extractFromImages 流程 ---------- */

function runVision(fetchFn, dataUrls, extra) {
  return E.extractFromImages(dataUrls, Object.assign(
    { llm: L, cfg: CFG, deps: Object.assign({ fetch: fetchFn }, noWait) },
    extra || {}
  ));
}

test("extractFromImages：一次调用抽干净的图片，不触发修补", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const r = await runVision(f, JPEG_URL);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.name, "王瑞瑶");
  assert.strictEqual(r.repairRounds, 0);
  assert.strictEqual(r.chunks, 1);
  assert.strictEqual(f.calls.length, 1);
});

test("extractFromImages：请求体是多模态结构（image_url + 文本指令）", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  await runVision(f, [PNG_URL]);
  const body = f.calls[0];
  const user = body.messages.find((m) => m.role === "user");
  assert.ok(Array.isArray(user.content), "图片模式 user.content 应为数组");
  assert.strictEqual(user.content[0].type, "image_url");
  assert.ok(user.content[0].image_url.url.startsWith("data:image/"));
  assert.ok(user.content.some((p) => p.type === "text" && /44 个字段/.test(p.text)));
});

test("extractFromImages：system prompt 用的是读图措辞", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  await runVision(f, PNG_URL);
  const sys = f.calls[0].messages.find((m) => m.role === "system");
  assert.ok(sys.content.includes("简历的图片"));
});

test("extractFromImages：邮箱格式错 → 定向修补只修 email", async () => {
  const bad = full({ email: "不是邮箱" });
  const good = full({ email: "wangruiyao87@gmail.com" });
  const f = seqFetch([JSON.stringify(bad), JSON.stringify(good)]);
  const r = await runVision(f, JPEG_URL);
  assert.strictEqual(r.repairRounds, 1);
  assert.strictEqual(r.data.email, "wangruiyao87@gmail.com");
  // 修补请求也要带图：模型得能重看原图
  const repairMsg = f.calls[1].messages.find((m) => m.role === "user");
  const firstUser = f.calls[1].messages.filter((m) => m.role === "user")[0];
  assert.ok(Array.isArray(firstUser.content) && firstUser.content[0].type === "image_url",
    "修补轮的第一条 user 消息应仍包含图片");
  void repairMsg;
});

test("extractFromImages：修补只接受不合格字段的新值", async () => {
  const bad = full({ phone: "123" });
  const repaired = full({ phone: "15248522685", name: "王小明" });
  const f = seqFetch([JSON.stringify(bad), JSON.stringify(repaired)]);
  const r = await runVision(f, JPEG_URL);
  assert.strictEqual(r.data.phone, "15248522685");
  assert.strictEqual(r.data.name, "王瑞瑶", "已合格的字段不该被顺手改掉");
});

test("extractFromImages：修补两轮仍不合格 → needsReview", async () => {
  let i = 0;
  const fetchFn = async (url, init) => {
    const payload = i === 0 ? full({ email: "坏邮箱" }) : full({ email: `坏邮箱${i}` });
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
  const r = await runVision(fetchFn, JPEG_URL);
  assert.strictEqual(r.repairRounds, 2);
  assert.strictEqual(r.needsReview, true);
  assert.strictEqual(r.meter.calls, 3);
});

test("extractFromImages：空列表 / 非法 dataURL 直接拒绝，不调模型", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  await assert.rejects(() => runVision(f, []), /没有可识别的图片/);
  await assert.rejects(() => runVision(f, ["https://x.com/a.png"]), /dataURL/);
  assert.strictEqual(f.calls.length, 0);
});

test("extractFromImages：模型回垃圾 → 自动重问一次（复用 extractOne 的纠偏）", async () => {
  const f = seqFetch(["抱歉我读不了图", JSON.stringify(full())]);
  const r = await runVision(f, JPEG_URL);
  assert.strictEqual(r.data.name, "王瑞瑶");
  assert.strictEqual(f.calls.length, 2);
});

test("extractFromImages：token 计量与文本链路同一套账本", async () => {
  const f = seqFetch([JSON.stringify(full())]);
  const r = await runVision(f, JPEG_URL);
  assert.strictEqual(r.meter.promptTokens, 900);
  assert.strictEqual(r.meter.completionTokens, 400);
  assert.strictEqual(r.meter.calls, 1);
});

console.log(`\n结果：${passed} 条通过`);
