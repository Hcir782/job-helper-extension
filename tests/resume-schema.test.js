/**
 * 简历抽取契约与校验单测（lib/resume-schema.js）
 *
 * 运行：node tests/resume-schema.test.js
 *
 * 这层不联网、不碰 DOM，是「PDF → JSON」模块里最容易出错的确定性部分：
 * 模型返回的东西五花八门（包一层、带围栏、枚举写错、日期自由文本），
 * 全部在这里收敛，所以值得逐条钉死。
 */

const assert = require("assert");
const S = require("../lib/resume-schema.js");

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    process.exitCode = 1;
  }
}

/** 造一份「大部分字段都对」的模型输出，用来测单个字段的收敛行为 */
function base(over) {
  const d = S.emptyData();
  d.name = "王瑞瑶";
  d.phone = "15248522685";
  d.email = "wangruiyao87@gmail.com";
  d.education = "本科";
  d.graduationYear = "2027-06";
  d.school = "大连科技学院";
  d.major = "网络工程";
  return Object.assign(d, over || {});
}

console.log("简历抽取契约与校验单测：");

test("FIELDS 是 44 个且不重复", () => {
  assert.strictEqual(S.FIELDS.length, 44);
  assert.strictEqual(new Set(S.FIELDS).size, 44);
});

test("buildJsonSchema：44 字段全部 required，且禁止额外字段", () => {
  const sc = S.buildJsonSchema();
  assert.strictEqual(sc.type, "object");
  assert.strictEqual(sc.additionalProperties, false);
  assert.strictEqual(sc.required.length, 44);
  assert.strictEqual(Object.keys(sc.properties).length, 44);
  assert.deepStrictEqual(sc.required.sort(), S.FIELDS.slice().sort());
});

test("buildJsonSchema：枚举字段带 enum 且额外允许空串", () => {
  const p = S.buildJsonSchema().properties.gender;
  assert.deepStrictEqual(p.enum, ["男", "女", ""]);
});

test("buildJsonSchema：长文本字段不限长（经历类不给 maxLength）", () => {
  const p = S.buildJsonSchema().properties.projectExp;
  assert.strictEqual(p.maxLength, undefined);
});

test("validate：正常输出原样通过，filled 计数正确", () => {
  const r = S.validate(base());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.filled, 7);
  assert.deepStrictEqual(r.issues.filter((i) => i.kind !== "unknown_field"), []);
});

test("validate：非对象输入直接判失败", () => {
  assert.strictEqual(S.validate("不是 JSON").ok, false);
  assert.strictEqual(S.validate(null).ok, false);
  assert.strictEqual(S.validate([1, 2]).ok, false);
});

test("validate：字段太少判失败并给出原因", () => {
  const r = S.validate({ name: "王瑞瑶" });
  assert.strictEqual(r.ok, false, "1/44 应该判失败");
  assert.ok(r.issues.some((i) => i.kind === "too_few_fields"));
});

test("validate：模型自造字段被丢弃并记账", () => {
  const r = S.validate(base({ wechat: "abc", 微信号: "abc" }));
  assert.strictEqual(r.data.wechat, undefined);
  assert.strictEqual(r.issues.filter((i) => i.kind === "unknown_field").length, 2);
});

test("validate：结果被包在 resume 里时自动拆开", () => {
  const r = S.validate({ resume: base() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.name, "王瑞瑶");
  assert.ok(r.issues.some((i) => i.kind === "nested"));
});

test("validate：字符串输入能剥掉 markdown 围栏", () => {
  const text = "这是结果：\n```json\n" + JSON.stringify(base()) + "\n```\n以上。";
  const r = S.validate(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.name, "王瑞瑶");
});

test("validate：非字符串值转成文本并记账", () => {
  const r = S.validate(base({ phone: 15248522685, workYears: "应届生" }));
  assert.strictEqual(r.data.phone, "15248522685");
  assert.ok(r.issues.some((i) => i.kind === "not_string" && i.field === "phone"));
});

test("enum：标准值直接接受", () => {
  assert.deepStrictEqual(S.coerceEnum("gender", "男"), { value: "男", changed: false });
});

test("enum：别名收敛（学士→本科、硕士研究生→硕士、统招→全日制）", () => {
  assert.strictEqual(S.coerceEnum("education", "学士").value, "本科");
  assert.strictEqual(S.coerceEnum("education", "硕士研究生").value, "硕士");
  assert.strictEqual(S.coerceEnum("studyMode", "统招").value, "全日制");
});

test("enum：带括号补充的写法也能收敛", () => {
  const r = S.coerceEnum("education", "本科（全日制）");
  assert.strictEqual(r.value, "本科");
  assert.strictEqual(r.changed, true);
});

test("enum：中文包含唯一命中才收敛，多个命中宁可清空", () => {
  assert.strictEqual(S.coerceEnum("gender", "女性").value, "女");
  // "男/女" 都命中 → 有歧义，不猜
  const r = S.coerceEnum("gender", "男 女");
  assert.strictEqual(r.value, "", "有歧义时应清空而不是猜一个");
});

test("enum：完全对不上的值清空并标 invalid", () => {
  const r = S.coerceEnum("education", "幼儿园");
  assert.strictEqual(r.value, "");
  assert.strictEqual(r.invalid, true);
});

test("enum：空值不算错", () => {
  assert.deepStrictEqual(S.coerceEnum("gender", ""), { value: "", changed: false });
});

test("graduationYear：2027年6月 → 2027-06", () => {
  assert.strictEqual(S.normalizeGraduation("2027年6月").value, "2027-06");
});

test("graduationYear：2027.6 / 2027/06/30 → 2027-06", () => {
  assert.strictEqual(S.normalizeGraduation("2027.6").value, "2027-06");
  assert.strictEqual(S.normalizeGraduation("2027/06/30").value, "2027-06");
});

test("graduationYear：已经是 YYYY-MM 的不变", () => {
  const r = S.normalizeGraduation("2027-06");
  assert.strictEqual(r.value, "2027-06");
  assert.strictEqual(r.changed, false);
});

test("graduationYear：识别不了的保留原文（应届 / 2027）", () => {
  assert.strictEqual(S.normalizeGraduation("应届").value, "应届");
  assert.strictEqual(S.normalizeGraduation("2027").value, "2027");
});

test("graduationYear：月份越界不当日期处理", () => {
  assert.strictEqual(S.normalizeGraduation("2027年13月").value, "2027年13月");
});

test("phone：去空格横线括号", () => {
  assert.strictEqual(S.normalizePhone("152-4852-2685").value, "15248522685");
  assert.strictEqual(S.normalizePhone("152 4852 2685").value, "15248522685");
  assert.strictEqual(S.normalizePhone("(+86) 15248522685").value, "+8615248522685");
});

test("email：转小写并校验格式", () => {
  const r = S.normalizeEmail("WangRuiYao87@Gmail.com");
  assert.strictEqual(r.value, "wangruiyao87@gmail.com");
  assert.strictEqual(r.changed, true);
  assert.strictEqual(S.normalizeEmail("不是邮箱").invalid, true);
});

test("validate：邮箱格式坏 → 进 fps 修补清单", () => {
  const r = S.validate(base({ email: "wangruiyao87#gmail.com" }));
  assert.ok(r.fps.includes("email"));
});

test("validate：手机号位数不对 → 进 fps 修补清单", () => {
  const r = S.validate(base({ phone: "123" }));
  assert.ok(r.fps.includes("phone"));
});

test("validate：超长字段截断并记账", () => {
  const r = S.validate(base({ name: "王".repeat(60) }));
  assert.strictEqual(r.data.name.length, 40);
  assert.ok(r.issues.some((i) => i.kind === "too_long" && i.field === "name"));
});

test("validate：长文本字段保留换行，不被压成一行", () => {
  const r = S.validate(base({ projectExp: "第一行\n\n第二行" }));
  assert.strictEqual(r.data.projectExp, "第一行\n\n第二行");
});

test("validate：missing 列出空字段，供 UI 提示「待补充」", () => {
  const r = S.validate(base());
  assert.ok(r.missing.includes("gender"));
  assert.ok(!r.missing.includes("name"));
  assert.strictEqual(r.missing.length, 44 - 7);
});

test("buildRepairPrompt：无缺陷时返回空串", () => {
  assert.strictEqual(S.buildRepairPrompt([]), "");
  assert.strictEqual(S.buildRepairPrompt(null), "");
});

test("buildRepairPrompt：只列问题字段，并带上枚举允许值", () => {
  const text = S.buildRepairPrompt([
    { field: "gender", kind: "enum_invalid", value: "男生" },
  ]);
  assert.ok(text.includes("gender"));
  assert.ok(text.includes("男 / 女"));
  assert.ok(text.includes("只重新抽取这几个字段"));
  // 不应该让模型重写整份
  assert.ok(!text.includes("school"));
});

test("stripFence：能处理没有围栏的裸 JSON", () => {
  assert.deepStrictEqual(S.stripFence('{"a":1}'), { a: 1 });
});

console.log(`\n结果：${passed} 条通过`);
