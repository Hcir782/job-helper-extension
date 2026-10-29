/**
 * lib/date-group.js 单测：年月分离控件的配对
 * 运行：node tests/date-group.test.js
 *
 * 为什么单独测：把「入学时间」拆成两个控件的表单很常见，两个控件单独看
 * 只是「年」和「月」，按字段名永远匹配不到「入学时间」。配错一对的代价是
 * 把 09 写进年份框（或把 2023 写进月份框），属于「填错了比没填更糟」的场景，
 * 所以配对的边界条件必须钉死。
 */
const assert = require("assert");
const path = require("path");
const G = require(path.join(__dirname, "..", "lib", "date-group.js"));

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

const YEARS = ["2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027"];
const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

(async () => {
  console.log("lib/date-group.js 单测：");

  await test("jhOptionsLookLikeYears：4 位年份列表", () => {
    assert.strictEqual(G.jhOptionsLookLikeYears(YEARS), true);
    assert.strictEqual(G.jhOptionsLookLikeYears(["2023年", "2024年", "2025年"]), true);
  });

  await test("jhOptionsLookLikeYears：混入「请选择」仍算年份列表", () => {
    assert.strictEqual(G.jhOptionsLookLikeYears(["请选择", ...YEARS]), true);
  });

  await test("jhOptionsLookLikeYears：几个数字不算年份（如 1-8 人）", () => {
    assert.strictEqual(G.jhOptionsLookLikeYears(["1", "2", "3", "4"]), false);
  });

  await test("jhOptionsLookLikeMonths：数字与中文月份都认", () => {
    assert.strictEqual(G.jhOptionsLookLikeMonths(MONTHS), true);
    assert.strictEqual(G.jhOptionsLookLikeMonths(MONTHS.map((m) => String(m).padStart(2, "0"))), true);
    assert.strictEqual(
      G.jhOptionsLookLikeMonths(["一月", "二月", "三月", "四月", "五月", "六月"]),
      true
    );
  });

  await test("jhOptionsLookLikeMonths：13/0 不是月份", () => {
    assert.strictEqual(G.jhOptionsLookLikeMonths(["0", "13", "14", "15"]), false);
  });

  await test("jhControlKind：以选项为准，学历选项不会被当年月", () => {
    assert.strictEqual(G.jhControlKind({ label: "年", options: YEARS }), "year");
    assert.strictEqual(G.jhControlKind({ label: "月", options: MONTHS }), "month");
    assert.strictEqual(
      G.jhControlKind({ label: "年", options: ["大专", "本科", "硕士", "博士"] }),
      ""
    );
  });

  await test("jhControlKind：选项读不到时看占位文案", () => {
    assert.strictEqual(G.jhControlKind({ label: "年", options: [] }), "year");
    assert.strictEqual(G.jhControlKind({ label: "月份", options: [] }), "month");
    assert.strictEqual(G.jhControlKind({ label: "请选择", options: [] }), "");
  });

  await test("jhKindFromLabel：出生年月 两个都含 → 无法判断", () => {
    assert.strictEqual(G.jhKindFromLabel("出生年月"), "");
    assert.strictEqual(G.jhKindFromLabel("毕业年份"), "year");
    assert.strictEqual(G.jhKindFromLabel("入学月份"), "month");
  });

  await test("jhPairYearMonth：原生年 + 月 相邻同组 → 配对", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y", group: "g1", label: "", options: YEARS },
      { id: "m", group: "g1", label: "", options: MONTHS },
    ]);
    assert.deepStrictEqual(pairs, [{ yearId: "y", monthId: "m", group: "g1" }]);
  });

  await test("jhPairYearMonth：月份写在前面也能配出正确次序", () => {
    const pairs = G.jhPairYearMonth([
      { id: "m", group: "g1", label: "", options: MONTHS },
      { id: "y", group: "g1", label: "", options: YEARS },
    ]);
    assert.deepStrictEqual(pairs, [{ yearId: "y", monthId: "m", group: "g1" }]);
  });

  await test("jhPairYearMonth：不同组的年与月不配对", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y", group: "g1", label: "", options: YEARS },
      { id: "m", group: "g2", label: "", options: MONTHS },
    ]);
    assert.deepStrictEqual(pairs, []);
  });

  await test("jhPairYearMonth：两个都是年不配对", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y1", group: "g1", label: "", options: YEARS },
      { id: "y2", group: "g1", label: "", options: YEARS },
    ]);
    assert.deepStrictEqual(pairs, []);
  });

  await test("jhPairYearMonth：隔着一个控件不配对（防止跨字段错配）", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y", group: "g1", label: "", options: YEARS },
      { id: "x", group: "g1", label: "", options: ["大专", "本科", "硕士"] },
      { id: "m", group: "g1", label: "", options: MONTHS },
    ]);
    assert.deepStrictEqual(pairs, []);
  });

  await test("jhPairYearMonth：伪下拉看不到选项，靠「年」「月」占位也能配", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y", group: "g1", label: "年", options: [] },
      { id: "m", group: "g1", label: "月", options: [] },
    ]);
    assert.deepStrictEqual(pairs, [{ yearId: "y", monthId: "m", group: "g1" }]);
  });

  await test("jhPairYearMonth：页面上有两组年月时各配各的", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y1", group: "g1", label: "", options: YEARS },
      { id: "m1", group: "g1", label: "", options: MONTHS },
      { id: "y2", group: "g2", label: "", options: YEARS },
      { id: "m2", group: "g2", label: "", options: MONTHS },
    ]);
    assert.deepStrictEqual(pairs, [
      { yearId: "y1", monthId: "m1", group: "g1" },
      { yearId: "y2", monthId: "m2", group: "g2" },
    ]);
  });

  await test("jhPairYearMonth：一个控件不会被重复配对", () => {
    const pairs = G.jhPairYearMonth([
      { id: "y", group: "g1", label: "", options: YEARS },
      { id: "m1", group: "g1", label: "", options: MONTHS },
      { id: "m2", group: "g1", label: "", options: MONTHS },
    ]);
    assert.deepStrictEqual(pairs, [{ yearId: "y", monthId: "m1", group: "g1" }]);
  });

  console.log(`\n结果：${passed}/${passed + failed} 通过`);
  process.exit(failed ? 1 : 0);
})();
