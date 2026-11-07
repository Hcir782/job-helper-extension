/**
 * PDF 取文本层单测（lib/pdf-text.js）
 *
 * 运行：node tests/pdf-text.test.js
 *
 * 真 PDF 的解析交给 e2e（需要真实的 pdfjs + 真实浏览器），
 * 这里专测最容易错的那一半：把「带坐标的文本碎片」还原成人类可读的行。
 * 两栏简历、右对齐的电话号码、中英文混排，都是真实踩过的坑。
 */

const assert = require("assert");
const P = require("../lib/pdf-text.js");

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

/** 造一个 pdfjs 的 text item：x / y 是页面坐标，y 越大越靠上 */
function it(str, x, y, w) {
  return { str, width: w == null ? str.length * 8 : w, transform: [1, 0, 0, 1, x, y] };
}

console.log("PDF 取文本单测：");

test("itemsToLines：空输入返回空串", () => {
  assert.strictEqual(P.itemsToLines([]), "");
  assert.strictEqual(P.itemsToLines(null), "");
});

test("itemsToLines：同一 y 的碎片拼成一行", () => {
  const text = P.itemsToLines([it("姓名", 10, 700), it("：王瑞瑶", 50, 700)]);
  assert.strictEqual(text, "姓名：王瑞瑶");
});

test("itemsToLines：y 不同则分行，且从上到下", () => {
  const text = P.itemsToLines([
    it("第二行", 10, 600),
    it("第一行", 10, 700),
  ]);
  assert.deepStrictEqual(text.split("\n"), ["第一行", "第二行"]);
});

test("itemsToLines：即使内容流顺序是乱的，也按坐标还原", () => {
  // 真实 PDF 里内容流顺序经常与视觉顺序不一致
  const text = P.itemsToLines([
    it("邮箱：a@b.com", 300, 700),
    it("姓名：王瑞瑶", 10, 700),
    it("电话：152", 10, 680),
  ]);
  assert.deepStrictEqual(text.split("\n"), ["姓名：王瑞瑶邮箱：a@b.com", "电话：152"]);
});

test("itemsToLines：中文之间不补空格", () => {
  const text = P.itemsToLines([it("大连", 10, 700), it("科技学院", 26, 700)]);
  assert.strictEqual(text, "大连科技学院");
});

test("itemsToLines：英文单词之间按间距补空格", () => {
  const text = P.itemsToLines([it("Dalian", 10, 700), it("Institute", 60, 700)]);
  assert.strictEqual(text, "Dalian Institute");
});

test("itemsToLines：紧挨着的英文不补空格（避免 Py thon）", () => {
  const text = P.itemsToLines([it("Py", 10, 700), it("thon", 24, 700)]);
  assert.strictEqual(text, "Python");
});

test("itemsToLines：行尾空白被清掉", () => {
  const text = P.itemsToLines([it("校内职务   ", 10, 700)]);
  assert.strictEqual(text, "校内职务");
});

test("itemsToLines：多于两行连续空行被压成一个", () => {
  const text = P.itemsToLines([
    it("A", 10, 700),
    it("", 10, 690),
    it("B", 10, 600),
  ]);
  assert.ok(!/\n{3,}/.test(text));
});

test("chunkText：短文本不分块", () => {
  assert.deepStrictEqual(P.chunkText("abc", 100), ["abc"]);
});

test("chunkText：超长文本分块且不丢内容", () => {
  const src = "x".repeat(250);
  const chunks = P.chunkText(src, 100);
  assert.ok(chunks.length >= 3);
  assert.strictEqual(chunks.join(""), src, "拼回来必须和原文一致");
});

test("chunkText：尽量在换行处断开", () => {
  const src = "a".repeat(90) + "\n" + "b".repeat(90);
  const chunks = P.chunkText(src, 100);
  assert.ok(chunks[0].endsWith("\n"), "应在换行处切，而不是劈开单词");
});

test("humanSize：按量级换单位", () => {
  assert.strictEqual(P.humanSize(512), "512 B");
  assert.strictEqual(P.humanSize(2048), "2.0 KB");
  assert.strictEqual(P.humanSize(1024 * 1024 * 2.5), "2.50 MB");
});

test("humanSize：非法值不报错", () => {
  assert.strictEqual(P.humanSize(undefined), "0 B");
});

test("extractText：没有 pdfjs 时抛出可读错误而不是 TypeError", async () => {
  await assert.rejects(
    () => P.extractText(new Uint8Array(0), { pdfjs: null }),
    /PDF 解析库没有加载/
  );
});

test("extractText：假 pdfjs 下能抽多页并标出页序", async () => {
  const fakePage = (txt) => ({
    getTextContent: async () => ({ items: [it(txt, 10, 700)] }),
    cleanup() {},
  });
  const fakePdf = {
    numPages: 2,
    getPage: async (p) => fakePage(p === 1 ? "第一页内容" : "第二页内容"),
  };
  const fakePdfjs = { getDocument: () => ({ promise: Promise.resolve(fakePdf) }) };

  const r = await P.extractText(new Uint8Array([1, 2, 3]), { pdfjs: fakePdfjs });
  assert.strictEqual(r.pages, 2);
  assert.strictEqual(r.scanned, false);
  assert.ok(r.text.includes("【第 1 页】"));
  assert.ok(r.text.includes("第一页内容"));
  assert.ok(r.text.includes("第二页内容"));
});

test("extractText：抽不出字时标记为扫描件", async () => {
  const fakePdf = {
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }),
  };
  const fakePdfjs = { getDocument: () => ({ promise: Promise.resolve(fakePdf) }) };
  const r = await P.extractText(new Uint8Array([1]), { pdfjs: fakePdfjs });
  assert.strictEqual(r.scanned, true);
  assert.strictEqual(r.chars, 0);
});

test("extractText：字很少但有文本层 → 不算扫描件（封面页现象）", async () => {
  const fakePdf = {
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [it("个人简历", 10, 700)] }), cleanup() {} }),
  };
  const fakePdfjs = { getDocument: () => ({ promise: Promise.resolve(fakePdf) }) };
  const r = await P.extractText(new Uint8Array([1]), { pdfjs: fakePdfjs });
  assert.strictEqual(r.scanned, false, "有字就不是扫描件，字少只能说明简历写得简洁");
  // chars 统计的是最终文本（含「【第 1 页】」页码标记）去空白后的字数
  assert.ok(r.chars > 0);
});

test("extractText：页数超过上限时只解析前几页", async () => {
  let fetched = 0;
  const fakePdf = {
    numPages: 10,
    getPage: async () => {
      fetched++;
      return { getTextContent: async () => ({ items: [it("内容", 10, 700)] }), cleanup() {} };
    },
  };
  const fakePdfjs = { getDocument: () => ({ promise: Promise.resolve(fakePdf) }) };
  const r = await P.extractText(new Uint8Array([1]), { pdfjs: fakePdfjs, maxPages: 3 });
  assert.strictEqual(fetched, 3);
  assert.strictEqual(r.pages, 10, "总数仍要如实汇报");
  assert.strictEqual(r.parsedPages, 3);
});

console.log(`\n结果：${passed} 条通过`);
