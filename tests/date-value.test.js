/**
 * lib/date-value.js 单测：日期字段归一化
 * 运行：node tests/date-value.test.js
 *
 * 为什么单独测：简历里人写的是「2027-06」「2027年6月」「2027/6」，
 * 而 <input type="date"> 只认 YYYY-MM-DD、<input type="month"> 只认 YYYY-MM。
 * 格式不对浏览器不会报错，只是把 value 变成空——静默失败最容易被当成「插件没生效」。
 */
const assert = require("assert");
const path = require("path");
const DATE = require(path.join(__dirname, "..", "lib", "date-value.js"));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

(async () => {
  console.log("lib/date-value.js 单测：");

  await test("jhParseDate：2027-06 解出年月", () => {
    assert.deepStrictEqual(DATE.jhParseDate("2027-06"), {
      year: "2027",
      month: "06",
      day: "",
      hour: "",
      minute: "",
    });
  });

  await test("jhParseDate：2027/6/5 补零", () => {
    const d = DATE.jhParseDate("2027/6/5");
    assert.strictEqual(d.year, "2027");
    assert.strictEqual(d.month, "06");
    assert.strictEqual(d.day, "05");
  });

  await test("jhParseDate：2027年6月 中文写法", () => {
    const d = DATE.jhParseDate("2027年6月");
    assert.strictEqual(d.month, "06");
  });

  await test("jhParseDate：2027.06 点分隔", () => {
    assert.strictEqual(DATE.jhParseDate("2027.06").month, "06");
  });

  await test("jhParseDate：解析时间 14:30", () => {
    const d = DATE.jhParseDate("2027-06-15 14:30");
    assert.strictEqual(d.hour, "14");
    assert.strictEqual(d.minute, "30");
  });

  await test("jhParseDate：非法月份被丢弃", () => {
    assert.strictEqual(DATE.jhParseDate("2027-13").month, "");
  });

  await test("jhParseDate：空值返回全空", () => {
    assert.strictEqual(DATE.jhParseDate("").year, "");
    assert.strictEqual(DATE.jhParseDate(null).year, "");
  });

  await test("jhNormalizeDateInput：month 控件要 YYYY-MM", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("2027年6月", "month"), "2027-06");
  });

  await test("jhNormalizeDateInput：month 控件只有年份时放弃（不瞎补月）", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("2027", "month"), "");
  });

  await test("jhNormalizeDateInput：date 控件只有年月时补 01", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("2004-08", "date"), "2004-08-01");
  });

  await test("jhNormalizeDateInput：date 控件原样保留具体日期", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("2004/8/15", "date"), "2004-08-15");
  });

  await test("jhNormalizeDateInput：time 控件要 HH:mm", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("9:5", "time"), "09:05");
  });

  await test("jhNormalizeDateInput：datetime-local 要 T 分隔", () => {
    assert.strictEqual(
      DATE.jhNormalizeDateInput("2027-06-15 14:30", "datetime-local"),
      "2027-06-15T14:30"
    );
  });

  await test("jhNormalizeDateInput：普通文本框原样返回", () => {
    assert.strictEqual(DATE.jhNormalizeDateInput("2027年6月毕业", "text"), "2027年6月毕业");
  });

  await test("jhSplitYearMonth：给年月分离的两个下拉用", () => {
    assert.deepStrictEqual(DATE.jhSplitYearMonth("2027-06"), { year: "2027", month: "06" });
    assert.deepStrictEqual(DATE.jhSplitYearMonth("没写"), { year: "", month: "" });
  });

  await test("jhIsDateInputType：只认四种日期类控件", () => {
    ["date", "month", "time", "datetime-local"].forEach((t) =>
      assert.strictEqual(DATE.jhIsDateInputType(t), true, t)
    );
    ["text", "number", "tel"].forEach((t) =>
      assert.strictEqual(DATE.jhIsDateInputType(t), false, t)
    );
  });

  console.log(`\n结果：${passed}/${passed + failed} 通过`);
  if (failed) process.exit(1);
})();
