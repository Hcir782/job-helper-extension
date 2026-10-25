/**
 * 投递记录台账单测（阶段 3）
 *
 * 运行：node tests/ledger.test.js
 *
 * 覆盖 lib/ledger.js 的去重/CSV/格式化，
 * 以及 site-adapters.js 的 jhDetectJobPage 页面信息探测。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const LEDGER = require("../lib/ledger.js");

/* ========== 加载 site-adapters.js（取 jhDetectJobPage / jhIsJobSite） ========== */

const adaptersSrc = fs.readFileSync(
  path.join(__dirname, "..", "site-adapters.js"),
  "utf8"
);
const adaptersApi = new Function(
  "window",
  "location",
  "document",
  adaptersSrc + "\nreturn { jhDetectJobPage, jhIsJobSite };"
)({}, { hostname: "" }, {});

/** mock 一个 document，只提供 title 和 querySelector(meta) */
function mockDoc({ title = "", ogTitle, siteName } = {}) {
  return {
    title,
    querySelector(sel) {
      if (sel.includes("og:title")) {
        return ogTitle ? { getAttribute: () => ogTitle } : null;
      }
      if (sel.includes("og:site_name")) {
        return siteName ? { getAttribute: () => siteName } : null;
      }
      return null;
    },
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-10-25T14:30:00").getTime();

(async () => {
  console.log("投递记录台账单测：");

  /* ---------- 去重 ---------- */
  await test("基本追加：返回 added=true", () => {
    const r = LEDGER.jhAddApplication([], {
      company: "某某科技有限公司", position: "运维工程师", sentAt: NOW,
    });
    assert.strictEqual(r.added, true);
    assert.strictEqual(r.list.length, 1);
    assert.strictEqual(r.list[0].company, "某某科技有限公司");
    assert.strictEqual(r.list[0].sentAt, NOW);
  });

  await test("同日同公司同岗位 → 判重不追加", () => {
    const list = [
      { company: "某某科技有限公司", position: "运维工程师", sentAt: NOW },
    ];
    const r = LEDGER.jhAddApplication(list, {
      company: "某某科技有限公司", position: "运维工程师",
      sentAt: NOW + 3600 * 1000, // 同一天晚一点
    });
    assert.strictEqual(r.added, false);
    assert.strictEqual(r.list.length, 1);
  });

  await test("公司名大小写/空格差异视为同一家", () => {
    const list = [
      { company: "某某科技有限公司", position: "运维工程师", sentAt: NOW },
    ];
    const r = LEDGER.jhAddApplication(list, {
      company: " 某某 科技  有限公司 ", position: "运维工程师", sentAt: NOW,
    });
    assert.strictEqual(r.added, false);
  });

  await test("不同日期 → 允许再次记录", () => {
    const list = [
      { company: "某某科技有限公司", position: "运维工程师", sentAt: NOW },
    ];
    const r = LEDGER.jhAddApplication(list, {
      company: "某某科技有限公司", position: "运维工程师", sentAt: NOW + DAY,
    });
    assert.strictEqual(r.added, true);
    assert.strictEqual(r.list.length, 2);
  });

  await test("不同岗位 → 允许记录", () => {
    const list = [
      { company: "某某科技有限公司", position: "运维工程师", sentAt: NOW },
    ];
    const r = LEDGER.jhAddApplication(list, {
      company: "某某科技有限公司", position: "DevOps工程师", sentAt: NOW,
    });
    assert.strictEqual(r.added, true);
  });

  await test("空公司/空岗位有兜底值", () => {
    const r = LEDGER.jhAddApplication([], { sentAt: NOW });
    assert.strictEqual(r.list[0].company, "未知公司");
    assert.strictEqual(r.list[0].position, "未知岗位");
    assert.strictEqual(r.list[0].resumeName, "未命名版本");
  });

  await test("jhAddApplication 不修改入参数组（不可变）", () => {
    const list = [];
    LEDGER.jhAddApplication(list, { company: "A公司", position: "运维", sentAt: NOW });
    assert.strictEqual(list.length, 0, "原数组不应被修改");
  });

  /* ---------- CSV ---------- */
  await test("CSV 含 BOM、表头、倒序、CRLF", () => {
    const list = [
      { company: "旧公司", position: "运维", resumeName: "通用版", url: "https://a.com", sentAt: NOW - DAY },
      { company: "新公司", position: "开发", resumeName: "技术版", url: "https://b.com", sentAt: NOW },
    ];
    const csv = LEDGER.jhToCSV(list);
    assert.ok(csv.startsWith("\ufeff"), "应带 BOM");
    const lines = csv.replace("\ufeff", "").split("\r\n");
    assert.strictEqual(lines[0], "公司,岗位,简历版本,投递时间,页面链接");
    assert.ok(lines[1].startsWith("新公司"), "最新记录应在第一行");
    assert.ok(lines[2].startsWith("旧公司"));
  });

  await test("CSV 特殊字符转义（逗号/引号/换行）", () => {
    const list = [
      {
        company: 'A, B "科技" 公司', position: "运维\n工程师", resumeName: "通用版",
        url: "https://a.com", sentAt: NOW,
      },
    ];
    const csv = LEDGER.jhToCSV(list);
    assert.ok(
      csv.includes('"A, B ""科技"" 公司"'),
      "含逗号引号的字段应加双引号并翻倍内部引号"
    );
    assert.ok(csv.includes('"运维\n工程师"'), "含换行的字段应加双引号");
  });

  await test("空列表 CSV 只有表头", () => {
    const csv = LEDGER.jhToCSV([]);
    assert.strictEqual(csv, "\ufeff公司,岗位,简历版本,投递时间,页面链接\r\n");
  });

  /* ---------- 格式化 ---------- */
  await test("jhFormatTime 输出 年-月-日 时:分", () => {
    assert.strictEqual(LEDGER.jhFormatTime(NOW), "2026-10-25 14:30");
    assert.strictEqual(LEDGER.jhFormatTime(new Date("2026-01-02T03:04:05").getTime()), "2026-01-02 03:04");
    assert.strictEqual(LEDGER.jhFormatTime(0), "");
  });

  await test("jhCsvFileName 含中文与时间戳", () => {
    const name = LEDGER.jhCsvFileName(NOW);
    assert.ok(name.startsWith("投递记录_2026-10-25_1430"), name);
    assert.ok(name.endsWith(".csv"), name);
  });

  /* ---------- 页面探测 ---------- */
  await test("探测 BOSS 式 title：公司_岗位_站点", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "上海某某科技有限公司招聘_运维工程师_招聘信息_BOSS直聘",
    }));
    assert.strictEqual(info.company, "上海某某科技有限公司");
    assert.strictEqual(info.position, "运维工程师");
  });

  await test("探测猎聘式 title：岗位_公司_站点", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "运维工程师招聘_某某科技公司_猎聘",
    }));
    assert.strictEqual(info.company, "某某科技公司");
    assert.strictEqual(info.position, "运维工程师");
  });

  await test("探测智联式 title：公司+岗位同段", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "某某科技公司招聘运维工程师_智联招聘",
    }));
    assert.strictEqual(info.company, "某某科技公司");
    assert.strictEqual(info.position, "运维工程师");
  });

  await test("探测带【】和高级修饰的 title", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "【高级运维工程师招聘_某某集团有限公司_拉勾招聘】",
    }));
    assert.strictEqual(info.company, "某某集团有限公司");
    assert.strictEqual(info.position, "高级运维工程师");
  });

  await test("识别不出时空串且不抛错", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({ title: "首页-随便看看" }));
    assert.strictEqual(info.company, "");
    assert.strictEqual(info.position, "");
  });

  await test("og:title 优先于 document.title", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "无关标题",
      ogTitle: "某某网络科技有限公司_前端开发工程师_51job",
    }));
    assert.strictEqual(info.company, "某某网络科技有限公司");
    assert.strictEqual(info.position, "前端开发工程师");
  });

  await test("og:site_name 兜底公司名", () => {
    const info = adaptersApi.jhDetectJobPage(mockDoc({
      title: "运维工程师_职位详情",
      siteName: "某某信息技术有限公司",
    }));
    assert.strictEqual(info.company, "某某信息技术有限公司");
    assert.strictEqual(info.position, "运维工程师");
  });

  await test("jhIsJobSite：主域名与子域名命中，其他不命中", () => {
    assert.strictEqual(adaptersApi.jhIsJobSite("www.zhipin.com"), true);
    assert.strictEqual(adaptersApi.jhIsJobSite("h.liepin.com"), true);
    assert.strictEqual(adaptersApi.jhIsJobSite("zhipin.com"), true);
    assert.strictEqual(adaptersApi.jhIsJobSite("example.com"), false);
    assert.strictEqual(adaptersApi.jhIsJobSite("notzhipin.com"), false);
    assert.strictEqual(adaptersApi.jhIsJobSite(""), false);
  });

  console.log(`\n结果：${passed}/20 通过`);
  if (process.exitCode) {
    console.error("存在失败用例");
    process.exit(1);
  }
})().catch((e) => {
  console.error("测试运行器异常：", e);
  process.exit(1);
});
