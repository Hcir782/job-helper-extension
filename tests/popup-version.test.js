/**
 * popup.js 简历版本管理逻辑的本地单测（不依赖浏览器）
 *
 * 运行：node tests/popup-version.test.js
 *
 * 用 mock 的 document / chrome.storage / prompt / confirm 驱动 popup.js，
 * 覆盖：首次初始化、保存、新建、复制、切换（含未保存提醒）、删除、
 *      旧数据迁移、版本 id 唯一性。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/* ========== mock DOM ========== */

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
    style: {},
    listeners: {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
  };
  // 模拟真实 DOM：textContent = "" 会移除所有子节点
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

const elements = {};

function getEl(id) {
  if (!elements[id]) {
    const el = makeElement(id === "resume-select" ? "select" : "div");
    if (id === "resume-form") {
      el.elements = {};
      // RESUME_FIELDS 的控件
      [
        "name", "gender", "phone", "birth", "email",
        "education", "graduationYear", "school", "major",
        "workYears", "expectSalary", "currentCompany", "currentPosition",
        "expectPosition", "expectCity",
        "selfIntro", "projectExp",
      ].forEach((f) => {
        el.elements[f] = { value: "" };
      });
    }
    elements[id] = el;
  }
  return elements[id];
}

const documentMock = {
  getElementById: getEl,
  createElement: (tag) => makeElement(tag),
  addEventListener: () => {},
};

const windowMock = { addEventListener: () => {} };

/* ========== mock chrome.storage ========== */

const store = {};

const chromeMock = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return JSON.parse(JSON.stringify(store));
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
    session: { async get() { return {}; }, async set() {} },
    onChanged: { addListener() {} },
  },
  runtime: { getManifest: () => ({ version: "0.5.0" }) },
};

/* ========== mock prompt / confirm ========== */

let promptQueue = [];
let confirmQueue = [];
const promptMock = () => {
  const v = promptQueue.shift();
  return v === undefined ? null : v;
};
const confirmMock = () => {
  const v = confirmQueue.shift();
  return v === undefined ? true : v;
};

/* ========== 加载 popup.js ========== */

const src = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8"
);

const api = new Function(
  "window",
  "document",
  "chrome",
  "confirm",
  "prompt",
  "console",
  src +
    "\nreturn { loadResume, saveResume, createResume, duplicateResume, deleteResume," +
    " switchResume, renderResumeList, readForm, writeForm, isDirty, state, genResumeId };"
)(windowMock, documentMock, chromeMock, confirmMock, promptMock, console);

const SAMPLE_A = {
  name: "王瑞瑶", gender: "男", phone: "15248522685", birth: "2004-08",
  email: "hcir012@qq.com", education: "本科", graduationYear: "2027",
  school: "大连科技学院", major: "网络工程", workYears: "应届生",
  expectSalary: "6-8K", currentCompany: "", currentPosition: "",
  expectPosition: "系统运维工程师", expectCity: "大连",
  selfIntro: "熟悉 Linux、K8s。", projectExp: "企业网络设计与实现。",
};
const SAMPLE_B = {
  ...SAMPLE_A,
  name: "王瑞瑶", expectPosition: "DevOps 工程师", expectCity: "北京",
  selfIntro: "偏 SRE 方向。",
};

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
  console.log("简历版本管理单测：");

  /* ---------- 1. 首次打开：自动创建默认版本 ---------- */
  await test("首次打开自动创建默认版本（空数据、下拉框 1 项、删除禁用）", async () => {
    Object.keys(store).forEach((k) => delete store[k]);
    await api.loadResume();

    assert.ok(store.resumes && store.resumes.default, "应创建 default 版本");
    assert.strictEqual(store.activeResumeId, "default");
    assert.strictEqual(store.resumes.default.name, "通用版");
    assert.deepStrictEqual(store.resumes.default.data, {});
    assert.strictEqual(api.readForm().name, "", "表单应为空");

    const sel = getEl("resume-select");
    assert.strictEqual(sel.children.length, 1, "下拉框应有 1 个选项");
    assert.strictEqual(getEl("btn-del-resume").disabled, true, "只剩 1 版时删除按钮禁用");
  });

  /* ---------- 2. 保存 ---------- */
  await test("保存写入当前激活版本并记录 updatedAt", async () => {
    api.writeForm(SAMPLE_A);
    await api.saveResume();

    const d = store.resumes.default.data;
    assert.strictEqual(d.name, "王瑞瑶");
    assert.strictEqual(d.expectPosition, "系统运维工程师");
    assert.ok(store.resumes.default.updatedAt > 0, "应记录 updatedAt");
    assert.strictEqual(api.isDirty(), false, "保存后表单与快照一致");
  });

  /* ---------- 3. 新建版本 ---------- */
  await test("新建版本：表单清空、激活切换、下拉框 2 项", async () => {
    promptQueue = ["技术版"];
    await api.createResume();

    assert.strictEqual(promptQueue.length, 0, "prompt 应被消费");
    const ids = Object.keys(store.resumes);
    assert.strictEqual(ids.length, 2, "应有 2 个版本");
    assert.ok(ids.includes("default"));

    const newId = store.activeResumeId;
    assert.notStrictEqual(newId, "default", "激活版本应切换到新版本");
    assert.strictEqual(store.resumes[newId].name, "技术版");
    assert.deepStrictEqual(store.resumes[newId].data, {}, "新版本数据应为空");
    assert.strictEqual(api.readForm().name, "", "表单应被清空");

    const sel = getEl("resume-select");
    assert.strictEqual(sel.children.length, 2);
    assert.strictEqual(getEl("btn-del-resume").disabled, false, "2 个版本时删除可用");
  });

  /* ---------- 4. 在新版本上保存另一份数据 ---------- */
  await test("新版本可独立保存自己的数据", async () => {
    const newId = store.activeResumeId;
    api.writeForm(SAMPLE_B);
    await api.saveResume();

    assert.strictEqual(store.resumes[newId].data.expectCity, "北京");
    assert.strictEqual(store.resumes.default.data.expectCity, "大连", "不影响旧版本");
  });

  /* ---------- 5. 复制版本 ---------- */
  await test("复制版本：数据为深拷贝、激活切换", async () => {
    const srcId = store.activeResumeId;
    promptQueue = ["运维版"];
    await api.duplicateResume();

    const newId = store.activeResumeId;
    assert.notStrictEqual(newId, srcId);
    assert.strictEqual(store.resumes[newId].name, "运维版");
    assert.deepStrictEqual(
      store.resumes[newId].data,
      store.resumes[srcId].data,
      "复制内容应与源版本一致"
    );
    assert.strictEqual(api.readForm().expectCity, "北京", "表单应载入新版本数据");

    // 修改副本不影响源（深拷贝验证）
    api.writeForm({ ...SAMPLE_B, expectCity: "上海" });
    await api.saveResume();
    assert.strictEqual(store.resumes[srcId].data.expectCity, "北京");
  });

  /* ---------- 6. 切换版本 ---------- */
  await test("切换版本：载入目标版本数据", async () => {
    const sel = getEl("resume-select");
    sel.value = "default";
    confirmQueue = []; // 无未保存修改，不会触发 confirm
    await api.switchResume();

    assert.strictEqual(store.activeResumeId, "default");
    assert.strictEqual(api.state.resumeId, "default");
    assert.strictEqual(api.readForm().expectCity, "大连", "应载入 default 的数据");
    assert.strictEqual(api.readForm().expectPosition, "系统运维工程师");
  });

  /* ---------- 7. 切换时未保存修改 → 保存 ---------- */
  await test("切换版本时提示保存：确认后写入旧版本", async () => {
    // 当前激活 default，改表单但没保存
    api.writeForm({ ...SAMPLE_A, expectCity: "广州" });
    assert.strictEqual(api.isDirty(), true, "应有未保存修改");

    const sel = getEl("resume-select");
    sel.value = store.activeResumeId === "default"
      ? Object.keys(store.resumes).find((k) => k !== "default")
      : "default";
    confirmQueue = [true];
    await api.switchResume();

    assert.strictEqual(
      store.resumes.default.data.expectCity,
      "广州",
      "确认后未保存修改应写入旧版本"
    );
    assert.strictEqual(api.isDirty(), false, "切换后表单与新版本一致");
  });

  /* ---------- 8. 切换时未保存修改 → 丢弃 ---------- */
  await test("切换版本时取消保存：丢弃修改", async () => {
    // 先确保当前是某个非 default 版本
    const sel = getEl("resume-select");
    const other = Object.keys(store.resumes).find((k) => k !== "default");
    sel.value = other;
    confirmQueue = [false];
    await api.switchResume();
    assert.strictEqual(store.activeResumeId, other);

    api.writeForm({ ...SAMPLE_B, expectCity: "深圳" });
    sel.value = "default";
    confirmQueue = [false]; // 取消 = 丢弃
    await api.switchResume();

    assert.strictEqual(store.activeResumeId, "default");
    assert.strictEqual(api.readForm().expectCity, "广州", "应载入已保存的数据而非丢弃的修改");
  });

  /* ---------- 9. 删除版本 ---------- */
  await test("删除版本：从列表移除并自动切换", async () => {
    const before = Object.keys(store.resumes).length;
    const delId = "default";
    const delName = store.resumes[delId].name;

    confirmQueue = [true];
    await api.deleteResume();

    assert.ok(!store.resumes[delId], "default 应被删除");
    assert.strictEqual(Object.keys(store.resumes).length, before - 1);
    assert.ok(store.activeResumeId in store.resumes, "激活版本应切换到剩余版本");
    assert.ok(api.state.resumeId in store.resumes);

    const sel = getEl("resume-select");
    assert.strictEqual(sel.children.length, before - 1);
    console.log(`    （已删除「${delName}」）`);
  });

  /* ---------- 10. 只剩一个版本时禁止删除 ---------- */
  await test("只剩一个版本时删除被拒绝", async () => {
    // 删到只剩 1 个
    while (Object.keys(store.resumes).length > 1) {
      confirmQueue = [true];
      await api.deleteResume();
    }
    assert.strictEqual(Object.keys(store.resumes).length, 1);

    confirmQueue = [true];
    await api.deleteResume();
    assert.strictEqual(Object.keys(store.resumes).length, 1, "不应删除最后一个版本");
    assert.ok(
      getEl("tip").textContent.includes("至少需要保留"),
      "应提示至少保留一个版本"
    );
  });

  /* ---------- 11. 阶段 2 旧数据迁移 ---------- */
  await test("旧版单份 resume 数据自动迁移为默认版本", async () => {
    Object.keys(store).forEach((k) => delete store[k]);
    store.resume = {
      name: "老张", phone: "13800138000", school: "大连科技学院",
    };
    await api.loadResume();

    assert.ok(store.resumes.default, "应迁移出 default 版本");
    assert.strictEqual(store.resumes.default.data.name, "老张");
    assert.strictEqual(api.readForm().name, "老张", "表单应载入迁移的数据");
    assert.strictEqual(getEl("resume-select").children.length, 1);
  });

  /* ---------- 12. 版本 id 唯一性 ---------- */
  await test("genResumeId 连续生成不重复", async () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(api.genResumeId());
    assert.strictEqual(ids.size, 200);
  });

  /* ---------- 13. 空 prompt 名称兜底 ---------- */
  await test("新建版本名称为空时用默认名", async () => {
    promptQueue = ["  "];
    await api.createResume();
    const id = store.activeResumeId;
    assert.strictEqual(store.resumes[id].name, "通用版");
  });

  console.log(`\n结果：${passed}/13 通过`);
  if (process.exitCode) {
    console.error("存在失败用例");
    process.exit(1);
  }
})().catch((e) => {
  console.error("测试运行器异常：", e);
  process.exit(1);
});
