/**
 * 下拉选项匹配单测（lib/option-match.js）
 *
 * 运行：node tests/option-match.test.js
 *
 * 为什么单独测这层：伪下拉的 DOM 交互没法在 Node 里跑，
 * 但「给一批候选文案该选哪个」是纯逻辑，最容易出错也最容易测。
 */

const assert = require("assert");
const OPT = require("../lib/option-match.js");

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

(async () => {
  console.log("下拉选项匹配单测：");

  await test("jhFlatten：去普通空格与全角空格，并转小写", () => {
    assert.strictEqual(OPT.jhFlatten("汉 　族"), "汉族");
    assert.strictEqual(OPT.jhFlatten("CET-4"), "cet-4");
  });

  await test("jhFlatten：去掉括号补充说明", () => {
    assert.strictEqual(OPT.jhFlatten("本科（全日制）"), "本科");
    assert.strictEqual(OPT.jhFlatten("Bachelor(Full-time)"), "bachelor");
  });

  await test("jhScoreOption：完全相等得最高分", () => {
    // 原文相同（120）要高于「去括号后相同」（100），见下一条用例
    assert.strictEqual(OPT.jhScoreOption("本科", "本科"), 120);
  });

  await test("jhScoreOption：原文相同 > 去括号后相同", () => {
    const exact = OPT.jhScoreOption("CET-6", "CET-6");
    const stripped = OPT.jhScoreOption("CET-6（520 分）", "CET-6");
    assert.strictEqual(exact, 120);
    assert.strictEqual(stripped, 100);
    assert.ok(exact > stripped, "原文相同必须排在前面");
  });

  await test("jhPickOption：CET-6 与 CET-6（520 分）并存时不判歧义", () => {
    const opts = ["CET-4", "CET-6", "CET-6（520 分）", "专业英语四级", "无"];
    assert.strictEqual(OPT.jhPickOption(opts, "CET-6"), 1);
  });

  await test("jhScoreOption：选项含目标值 > 目标值含选项", () => {
    const contain = OPT.jhScoreOption("本科（全日制）", "本科");
    const reverse = OPT.jhScoreOption("RHCE", "红帽 RHCSA、RHCE");
    assert.ok(contain > 0 && reverse > 0, "两种包含都应命中");
    assert.ok(contain > reverse, `包含( ${contain} ) 应高于反向包含( ${reverse} )`);
  });

  await test("jhScoreOption：空值 / 无交集返回 0", () => {
    assert.strictEqual(OPT.jhScoreOption("", "本科"), 0);
    assert.strictEqual(OPT.jhScoreOption("本科", ""), 0);
    assert.strictEqual(OPT.jhScoreOption("硕士", "本科"), 0);
  });

  await test("jhScoreOption：单字不参与反向包含（防噪音）", () => {
    assert.strictEqual(OPT.jhScoreOption("男", "男 / 女"), 0);
  });

  await test("jhPickOption：在真实选项列表里选中「本科」", () => {
    const opts = ["大专", "本科", "硕士", "博士"];
    assert.strictEqual(OPT.jhPickOption(opts, "本科"), 1);
  });

  await test("jhPickOption：带括号的选项也能命中", () => {
    const opts = ["大专", "本科（全日制）", "硕士"];
    assert.strictEqual(OPT.jhPickOption(opts, "本科"), 1);
  });

  await test("jhPickOption：同分取更短的（更接近精确）", () => {
    const opts = ["本科（专升本）", "本科"];
    assert.strictEqual(OPT.jhPickOption(opts, "本科"), 1);
  });

  await test("jhPickOption：值里含多个选项时视为歧义，返回 -1", () => {
    const opts = ["CET-4", "RHCSA", "RHCE", "软考中级"];
    assert.strictEqual(
      OPT.jhPickOption(opts, "红帽 RHCSA、RHCE；CET-4"),
      -1,
      "多个证书都能命中时不该替用户瞎选一个"
    );
  });

  await test("jhPickOption：弱匹配唯一时仍然生效", () => {
    assert.strictEqual(OPT.jhPickOption(["软考中级", "RHCE"], "红帽 RHCSA、RHCE；CET-4"), 1);
  });

  await test("jhPickOption：民族框里的全角空格不影响匹配", () => {
    assert.strictEqual(OPT.jhPickOption(["汉族", "回族"], "汉　族"), 0);
  });

  await test("jhPickOption：都不匹配返回 -1", () => {
    assert.strictEqual(OPT.jhPickOption(["大专", "硕士"], "本科"), -1);
    assert.strictEqual(OPT.jhPickOption([], "本科"), -1);
  });

  await test("jhSplitCascade：按斜杠拆分省 / 市", () => {
    assert.deepStrictEqual(OPT.jhSplitCascade("辽宁省 / 大连市"), ["辽宁省", "大连市"]);
  });

  await test("jhSplitCascade：支持 > 、 ， 等分隔符", () => {
    assert.deepStrictEqual(OPT.jhSplitCascade("辽宁省>大连市"), ["辽宁省", "大连市"]);
    assert.deepStrictEqual(OPT.jhSplitCascade("辽宁省、大连市"), ["辽宁省", "大连市"]);
    assert.deepStrictEqual(OPT.jhSplitCascade("辽宁省，大连市"), ["辽宁省", "大连市"]);
  });

  await test("jhSplitCascade：单个值不拆，空值返回空数组", () => {
    assert.deepStrictEqual(OPT.jhSplitCascade("大连"), ["大连"]);
    assert.deepStrictEqual(OPT.jhSplitCascade(""), []);
    assert.deepStrictEqual(OPT.jhSplitCascade(null), []);
  });

  await test("jhPickRow：单元格精确匹配优先", () => {
    const rows = ["技术部|一级|单选", "运维部|二级|单选", "市场部|三级|单选"];
    assert.strictEqual(OPT.jhPickRow(rows, "运维部"), 1);
  });

  await test("jhPickRow：单元格包含也能命中", () => {
    const rows = ["系统运维工程师|技术类", "运维开发工程师|技术类", "产品经理|非技术类"];
    assert.strictEqual(OPT.jhPickRow(rows, "系统运维工程师"), 0);
    assert.strictEqual(OPT.jhPickRow(rows, "运维开发"), 1);
  });

  await test("jhPickRow：无匹配返回 -1", () => {
    assert.strictEqual(OPT.jhPickRow(["技术部|一级"], "财务部"), -1);
    assert.strictEqual(OPT.jhPickRow([], "技术部"), -1);
  });

  await test("jhLooksApplied：触发器文案包含目标值即视为成功", () => {
    assert.strictEqual(OPT.jhLooksApplied("本科", "本科"), true);
    assert.strictEqual(OPT.jhLooksApplied("本科（全日制）", "本科"), true);
    assert.strictEqual(OPT.jhLooksApplied("请选择学历", "本科"), false);
  });

  await test("jhLooksApplied：级联多段逐段确认", () => {
    assert.strictEqual(OPT.jhLooksApplied("辽宁省 / 大连市", "辽宁省/大连市"), true);
    assert.strictEqual(OPT.jhLooksApplied("辽宁省 / 沈阳市", "辽宁省/大连市"), false);
  });

  await test("jhLooksApplied：空文案返回 false", () => {
    assert.strictEqual(OPT.jhLooksApplied("", "本科"), false);
    assert.strictEqual(OPT.jhLooksApplied("本科", ""), false);
  });

  console.log(`\n结果：${passed}/22 通过`);
})();
