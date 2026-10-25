/**
 * 集成冒烟测试：模拟真实环境跑通两条关键链路
 *
 * 运行：node tests/integration-smoke.test.js
 *
 * 链路 A（悬浮按钮点开的路径）：
 *   content script 发 OPEN_PANEL → background.js 顶层执行（含 importScripts）
 *   → handleOpenPanel → openPanel → chrome.tabs.create(popup.html)
 *
 * 链路 B（面板打开的路径）：
 *   popup.html 按序加载 site-adapters.js + lib/ledger.js + popup.js
 *   → DOMContentLoaded → 初始化全流程（版本工具栏 + 简历 + 投递记录）
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

/* ========== mock chrome（SW 侧） ========== */

function createSWChrome() {
  const calls = [];
  const listeners = { message: [], installed: [] };
  const store = {};

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      getManifest: () => ({ version: "0.6.0" }),
      getURL: (p) => `chrome-extension://abcdefgh/${p}`,
      lastError: null,
    },
    storage: {
      local: {
        async get(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          arr.forEach((k) => {
            if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          });
          return out;
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
      },
      session: {
        async get(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          arr.forEach((k) => {
            if (k in session) out[k] = session[k];
          });
          return out;
        },
        async set(obj) {
          Object.assign(session, obj);
        },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      async create(opts) {
        calls.push({ api: "tabs.create", url: opts.url });
        return { id: 99, windowId: 1 };
      },
      async update(tabId) {
        calls.push({ api: "tabs.update", tabId });
        throw new Error("no such tab"); // 模拟旧面板标签已关闭
      },
    },
    windows: { async update() {} },
    scripting: { async executeScript() {} },
  };

  const session = {};
  return { chrome, calls, listeners, store, session };
}

/* ========== mock DOM（popup 侧） ========== */

function makeElement(tag) {
  const el = {
    tag,
    children: [],
    value: "",
    className: "",
    title: "",
    selected: false,
    disabled: false,
    checked: false,
    style: { setProperty() {}, cssText: "" },
    listeners: {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    set innerHTML(v) {
      this._html = v;
      this.children = [];
    },
    get innerHTML() {
      return this._html || "";
    },
  };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get() { return text; },
    set(v) {
      text = v;
      if (v === "") el.children.length = 0;
    },
  });
  return el;
}

function createPopupEnv() {
  const elements = {};
  const document = {
    getElementById(id) {
      if (!elements[id]) {
        const el = makeElement(id === "resume-select" ? "select" : "div");
        if (id === "resume-form") {
          el.elements = {};
          [
            "name", "gender", "phone", "birth", "email",
            "education", "graduationYear", "school", "major",
            "workYears", "expectSalary", "currentCompany", "currentPosition",
            "expectPosition", "expectCity",
            "selfIntro", "projectExp",
          ].forEach((f) => { el.elements[f] = { value: "" }; });
        }
        elements[id] = el;
      }
      return elements[id];
    },
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) {
      (document._dom ||= {})[type] = fn;
    },
    body: makeElement("body"),
  };

  const window = {
    addEventListener() {},
    JH_JOB_DOMAINS: null, // 由 site-adapters.js 填充
  };

  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.7.0" }),
      getURL: (p) => `chrome-extension://abcdefgh/${p}`,
      sendMessage: (msg, cb) => {
        // 模拟 SW 的响应
        setTimeout(() => cb({ ok: true, list: [] }), 0);
      },
      lastError: null,
    },
    storage: {
      local: {
        async get(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          arr.forEach((k) => { if (k in popupStore) out[k] = JSON.parse(JSON.stringify(popupStore[k])); });
          return out;
        },
        async set(obj) { Object.assign(popupStore, JSON.parse(JSON.stringify(obj))); },
      },
      onChanged: { addListener() {} },
    },
  };

  const popupStore = {};
  return { document, window, chrome, elements, popupStore };
}

/* ========== 构建 popup 运行时（三脚本 + 环境） ========== */

/** 在 vm 沙箱里按 popup.html 的顺序加载脚本，返回 context */
function buildPopupContext(env) {
  const sandbox = {
    window: env.window,
    document: env.document,
    chrome: env.chrome,
    console,
    setTimeout,
    location: { hostname: "" },
    confirm: () => true,
    prompt: () => "测试版",
    Blob: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    // 预设文件从仓库里真实读取，验证 JSON 与字段映射
    fetch: async () => ({
      ok: true,
      json: async () =>
        JSON.parse(
          fs.readFileSync(
            path.join(ROOT, "presets", "resume-wangruiyao.json"),
            "utf8"
          )
        ),
    }),
  };
  const context = vm.createContext(sandbox);
  for (const f of ["site-adapters.js", "lib/ledger.js", "popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), context);
  }
  return context;
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

(async () => {
  console.log("集成冒烟测试：");

  /* ---------- 链路 A：SW + OPEN_PANEL ---------- */
  await test("链路A：background.js 顶层可执行（importScripts 正常）", async () => {
    const env = createSWChrome();
    const sandbox = {
      console,
      setTimeout,
      chrome: env.chrome,
    };
    sandbox.importScripts = (f) => {
      const code = fs.readFileSync(path.join(ROOT, f), "utf8");
      vm.runInContext(code, context);
    };
    const context = vm.createContext(sandbox);

    const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
    vm.runInContext(bg, context);

    assert.strictEqual(env.listeners.message.length, 1, "应注册消息监听");
    assert.ok(
      typeof vm.runInContext("JH_LEDGER", context) === "object",
      "importScripts 后 JH_LEDGER 应可用"
    );
  });

  await test("链路A：OPEN_PANEL → tabs.create 打开 popup.html", async () => {
    const env = createSWChrome();
    const sandbox = { console, setTimeout, chrome: env.chrome };
    sandbox.importScripts = (f) => {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), context);
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context);

    // 模拟 content script 的悬浮按钮点击
    const response = await new Promise((resolve) => {
      env.listeners.message[0](
        { type: "OPEN_PANEL" },
        { tab: { id: 42 } },
        resolve
      );
    });

    assert.strictEqual(response && response.ok, true, "应返回 ok:true");
    const created = env.calls.find((c) => c.api === "tabs.create");
    assert.ok(created, "应调用 tabs.create");
    assert.ok(
      created.url.endsWith("popup.html"),
      `应打开 popup.html，实际：${created.url}`
    );
    assert.strictEqual(env.session.lastJobTabId, 42, "应记录来源标签");
  });

  /* ---------- 链路 B：popup.html 三脚本 ---------- */
  await test("链路B：popup.html 三脚本按序加载 + DOMContentLoaded 无异常", async () => {
    const env = createPopupEnv();
    buildPopupContext(env);

    // 触发 DOMContentLoaded（popup.js 里注册的初始化入口）
    assert.ok(env.document._dom && env.document._dom.DOMContentLoaded, "应注册 DOMContentLoaded");
    await env.document._dom.DOMContentLoaded();
    await new Promise((r) => setTimeout(r, 30)); // 等异步初始化完成

    // 初始化结果：默认版本已建、下拉框有选项、投递记录区已渲染
    assert.ok(env.popupStore.resumes && env.popupStore.resumes.default, "应创建默认版本");
    const sel = env.elements["resume-select"];
    assert.ok(sel && sel.children.length >= 1, "版本下拉框应有选项");
    assert.ok(env.elements["version"].textContent.includes("0.7.0"), "版本号应显示");
    const ledger = env.elements["ledger-list"];
    assert.ok(ledger && ledger.innerHTML.length > 0, "投递记录区应被渲染");
  });

  await test("链路B：面板里所有按钮均已绑定事件", async () => {
    const env = createPopupEnv();
    buildPopupContext(env);
    await env.document._dom.DOMContentLoaded();

    ["btn-save", "btn-fill", "btn-demo", "btn-diag", "opt-float",
     "resume-select", "btn-new-resume", "btn-dup-resume", "btn-del-resume",
     "btn-export-csv", "btn-clear-ledger", "btn-preset"].forEach((id) => {
      const el = env.elements[id];
      assert.ok(el, `${id} 应存在`);
      assert.ok(
        el.listeners && (el.listeners.click || el.listeners.change),
        `${id} 应绑定事件`
      );
    });
  });

  await test("链路B：载入预设简历 → 新建版本并回填表单", async () => {
    const env = createPopupEnv();
    const context = buildPopupContext(env);
    await env.document._dom.DOMContentLoaded();

    // 直接调用面板里的载入预设逻辑
    await vm.runInContext("loadPresetResume()", context);
    await new Promise((r) => setTimeout(r, 20));

    const resumes = Object.values(env.popupStore.resumes);
    const preset = resumes.find((r) => r.name === "王瑞瑶-运维版");
    assert.ok(preset, "应生成「王瑞瑶-运维版」新版本");

    // 页面提取到的三项必须原样保留
    assert.strictEqual(preset.data.name, "王瑞瑶");
    assert.strictEqual(preset.data.phone, "15248522685");
    assert.strictEqual(preset.data.email, "hcir012@qq.com");
    // 档案补全字段
    assert.strictEqual(preset.data.school, "大连科技学院");
    assert.strictEqual(preset.data.major, "网络工程");
    assert.strictEqual(preset.data.graduationYear, "2027");
    assert.strictEqual(preset.data.education, "本科");
    assert.strictEqual(preset.data.expectPosition, "系统运维工程师");
    // 不确定的字段应保持为空，不能瞎填
    assert.strictEqual(preset.data.gender, "", "性别应为空");
    assert.strictEqual(preset.data.birth, "", "出生年月应为空");
    assert.strictEqual(preset.data.projectExp, "", "项目经历应为空");

    // 表单已回填、激活版本已切换
    assert.strictEqual(env.elements["resume-form"].elements.name.value, "王瑞瑶");
    assert.strictEqual(env.popupStore.activeResumeId, preset.id);
    assert.strictEqual(resumes.length, 2, "原有默认版本应保留，不被覆盖");
  });

  console.log(`\n结果：${passed}/5 通过`);
  if (process.exitCode) {
    console.error("存在失败用例");
    process.exit(1);
  }
})().catch((e) => {
  console.error("测试运行器异常：", e);
  process.exit(1);
});
