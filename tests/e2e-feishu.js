/**
 * 端到端测试：飞书招聘（atsx 组件库）表单能不能被填上
 *
 * 运行：node tests/e2e-feishu.js
 *
 * 为什么单独一个文件：飞书这套表单的难点不在「点开下拉选值」，而在**认字段**——
 * 输入框没有 placeholder，字段名写在 .atsx-form-item-label 里，既不是 <label for>
 * 也不是控件的兄弟节点，祖先链前三层全是 +86 / 获取验证码 这类噪音。
 * 用 mock DOM 测不出真实 innerText / 文档顺序，只能用真浏览器跑。
 *
 * 依赖：Microsoft Edge（系统自带）+ puppeteer-core。缺任一条件时跳过，退出码 0。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function skip(reason) {
  console.log(`e2e（飞书 atsx）：跳过 —— ${reason}`);
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
const READ_STATE = () => {
  const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
  return {
    name: document.getElementById("f-name")?.value || "",
    phone: document.getElementById("f-phone")?.value || "",
    email: document.getElementById("f-email")?.value || "",
    school: document.getElementById("f-school")?.value || "",
    major: document.getElementById("f-major")?.value || "",
    education: pick("#f-education .atsx-select-selection__rendered"),
    politics: pick("#f-politics .atsx-select-selection__rendered"),
    city: pick("#f-city .atsx-select-selection__rendered"),
    portalsOpen: Array.from(document.querySelectorAll("[data-atsx-portal]")).filter(
      (p) => getComputedStyle(p).display !== "none"
    ).length,
  };
};

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
  console.log("飞书 atsx 表单端到端测试（真实浏览器）：");

  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: "new",
    args: ["--allow-file-access-from-files", "--no-sandbox", "--hide-scrollbars"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1100, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(mockScript());
    await page.goto("file:///" + path.join(ROOT, "demo-feishu.html").replace(/\\/g, "/"), {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 600));

    // 0. 适配器要认出这是 atsx 表单
    const adapterName = await page.evaluate(() => {
      const a = jhPickAdapter();
      return a ? a.name : "通用规则";
    });
    check("适配器识别为飞书 atsx 表单", adapterName, "飞书 atsx 表单");

    // 1. 字段名能不能从 .atsx-form-item-label 里读出来
    const ctx = await page.evaluate(() => {
      const ids = ["f-name", "f-phone", "f-email", "f-school", "f-major"];
      const out = {};
      ids.forEach((id) => {
        out[id] = getTextContext(document.getElementById(id)).replace(/\s+/g, " ").trim();
      });
      return out;
    });
    for (const [id, text] of Object.entries(ctx)) {
      console.log(`      [ctx] ${id}  ←  ${text || "(空)"}`);
    }
    check("姓名输入框读到「姓名」", ctx["f-name"].includes("姓名"), true);
    check("手机输入框读到「手机号码」", ctx["f-phone"].includes("手机号码"), true);
    check("邮箱输入框读到「电子邮箱」", ctx["f-email"].includes("电子邮箱"), true);
    check("院校输入框读到「毕业院校」", ctx["f-school"].includes("毕业院校"), true);
    check("专业输入框读到「所学专业」", ctx["f-major"].includes("所学专业"), true);

    const before = await page.evaluate(READ_STATE);
    check("初始状态：输入框都是空的", before.name, "");

    // 只喂这 8 个字段：演示页上正好有对应的 5 个输入框 + 3 个 atsx 下拉，
    // 这样「未匹配」列表必须为空，任何遗漏都会被抓到
    const payload = {
      name: preset.data.name,
      phone: preset.data.phone,
      email: preset.data.email,
      education: preset.data.education,
      school: preset.data.school,
      major: preset.data.major,
      politics: "共青团员", // preset 里留空，这里补上以覆盖「下拉类」字段
      expectCity: "大连",
    };

    const result = await page.evaluate(async (p) => {
      const r = await fillResume(p);
      return {
        filled: r.filled.map((x) => x.field).sort(),
        filledCustom: r.filledCustom.map((x) => `${x.field}:${x.kind}`).sort(),
        missed: r.missed,
        customMissed: r.customMissed || [],
        counts: r.scan.counts,
        adapter: r.scan.adapter,
      };
    }, payload);

    await new Promise((r) => setTimeout(r, 300));
    const after = await page.evaluate(READ_STATE);

    // 2. 扫描结果：5 个文本框 + 3 个 atsx 伪下拉
    check("扫描到 5 个文本框", result.counts.text, 5);
    check("扫描到 3 个 atsx 伪下拉", result.counts.custom, 3);

    // 3. 字段识别 + 填充结果
    check(
      "8 个字段全部命中",
      result.filled.join(","),
      "education,email,expectCity,major,name,phone,politics,school"
    );
    check("没有字段被漏掉", result.missed.length, 0);
    if (result.missed.length || result.customMissed.length) {
      console.log(
        `      诊断：未匹配 ${JSON.stringify(result.missed)}；认出了控件但没填上 ${JSON.stringify(
          result.customMissed
        )}`
      );
    }

    // 4. 控件里真的显示出了值
    check("姓名 = 王瑞瑶", after.name, "王瑞瑶");
    check("手机号 = 15248522685", after.phone, "15248522685");
    check(`邮箱 = ${preset.data.email}`, after.email, preset.data.email);
    check("院校 = 大连科技学院", after.school, "大连科技学院");
    check("专业 = 网络工程", after.major, "网络工程");
    check("最高学历下拉显示「本科」", after.education, "本科");
    check("政治面貌下拉显示「共青团员」", after.politics, "共青团员");
    check("期望城市下拉显示「大连」", after.city, "大连");

    // 5. 选完要收起浮层
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
