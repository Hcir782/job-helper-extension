/**
 * 端到端测试：自定义下拉 / 可搜索下拉 / 级联选择 / 下拉表格 能否真的被填上
 *
 * 运行：node tests/e2e-widgets.js
 *
 * 与其它单测的区别：这个必须开真浏览器。因为伪下拉的核心是「模拟点击 → 等浮层渲染
 * → 点选项」，在 mock DOM 里测不出框架的异步渲染行为，只能拿真实内核跑一遍。
 *
 * 依赖：Microsoft Edge（系统自带）+ puppeteer-core（本地开发环境已装）。
 * 缺任一条件时**跳过**并以退出码 0 结束，避免影响其它测试的流水线。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function skip(reason) {
  console.log(`e2e（自定义控件）：跳过 —— ${reason}`);
  process.exit(0);
}

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch (e) {
  skip("未安装 puppeteer-core");
}

const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) skip("未找到 Microsoft Edge");

const preset = JSON.parse(
  fs.readFileSync(path.join(ROOT, "presets", "resume-wangruiyao.json"), "utf8")
);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const now = Date.now();

/** 注入 chrome API 模拟层：让 content.js / demo 页在普通页面里也能跑 */
function mockScript() {
  const seed = {
    resumes: { default: { id: "default", name: "通用版", data: preset.data, updatedAt: now } },
    activeResumeId: "default",
    showFloatingButton: false,
    applications: [],
  };
  const base = "file:///" + ROOT.replace(/\\/g, "/") + "/";
  return `
(function () {
  const store = JSON.parse(${JSON.stringify(JSON.stringify(seed))});
  function read(keys) {
    const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach(function (k) { if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); });
    return out;
  }
  function get(keys) {
    if (typeof keys === "function") { keys(read(null)); return; }
    return new Promise(function (res) { setTimeout(function () { res(read(keys)); }, 0); });
  }
  function set(obj, cb) { Object.assign(store, obj); if (typeof cb === "function") setTimeout(cb, 0); return Promise.resolve(); }
  window.chrome = {
    runtime: {
      id: "mock", lastError: null,
      getManifest: function () { return { version: ${JSON.stringify(manifest.version)} }; },
      getURL: function (p) { return ${JSON.stringify(base)} + p; },
      onMessage: { addListener: function () {} },
      onInstalled: { addListener: function () {} },
      sendMessage: function (msg, cb) { if (typeof cb === "function") setTimeout(function () { cb({ ok: true }); }, 0); }
    },
    storage: {
      local: { get: get, set: set },
      session: { get: async function () { return {}; }, set: async function () {} },
      onChanged: { addListener: function () {} }
    },
    tabs: { create: async function () { return {}; }, query: async function () { return []; }, get: async function () { return {}; } }
  };
})();
`;
}

/** 读回控件当前显示的值 */
const READ_STATE = () => ({
  education: document.querySelector("#w-education .ant-select-selection-item")?.textContent || "",
  nation: document.querySelector("#w-nation input")?.value || "",
  city: document.querySelector("#w-city input")?.value || "",
  position: document.querySelector("#w-position .jh-ts-value")?.textContent || "",
  politics: document.querySelector("#w-politics")?.value || "",
  portalsOpen: Array.from(document.querySelectorAll("[data-widget-portal]")).filter(
    (p) => getComputedStyle(p).display !== "none"
  ).length,
});

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

(async () => {
  console.log("自定义控件端到端测试（真实浏览器）：");

  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: "new",
    args: ["--allow-file-access-from-files", "--no-sandbox", "--hide-scrollbars"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(mockScript());
    await page.goto("file:///" + path.join(ROOT, "demo-widgets.html").replace(/\\/g, "/"), {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 600));

    const before = await page.evaluate(READ_STATE);
    check("初始状态：自定义控件都是空的（未填就选不上）", before.education, "");

    const payload = {
      education: "本科",
      nation: "汉族",
      expectCity: "辽宁省 / 大连市",
      expectPosition: "系统运维工程师",
      politics: "共青团员",
    };

    const result = await page.evaluate(async (p) => {
      const r = await fillResume(p);
      return {
        filled: r.filled.map((x) => x.field).sort(),
        filledCustom: r.filledCustom.map((x) => `${x.field}:${x.kind}`).sort(),
        missed: r.missed,
        counts: r.scan.counts,
      };
    }, payload);

    await new Promise((r) => setTimeout(r, 300));
    const after = await page.evaluate(READ_STATE);

    // 1. 识别到 5 个伪下拉触发器（4 个自定义 + 1 个原生 select 单独计数）
    check("页面扫描：识别到 4 个自定义下拉触发器", result.counts.custom, 4);

    // 2. 四种形态各自命中，且能区分来源
    check("填充结果：5 个字段全部命中", result.filled.length, 5);
    check(
      "形态识别：普通选项 / 可搜索 / 级联 / 表格行",
      result.filledCustom.join(","),
      "education:option,expectCity:cascade,expectPosition:row,nation:option"
    );
    check("没有字段被漏掉", result.missed.length, 0);

    // 3. 控件里真的显示出了值（不是只返回成功）
    check("Ant Design 下拉显示「本科」", after.education, "本科");
    check("可搜索下拉输入框是「汉族」", after.nation, "汉族");
    check("级联选择显示「辽宁省 / 大连市」", after.city, "辽宁省 / 大连市");
    check("下拉表格回填「系统运维工程师」", after.position, "系统运维工程师");
    check("原生 <select> 仍是「共青团员」", after.politics, "共青团员");

    // 4. 选完要收起浮层，别把后面的字段挡住
    check("所有浮层都已收起", after.portalsOpen, 0);
  } finally {
    await browser.close();
  }

  console.log(`\n结果：${passed}/${passed + failed} 通过`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("e2e 出错：", e);
  process.exit(1);
});
