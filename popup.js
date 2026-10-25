/**
 * popup.js —— 弹窗交互逻辑（阶段 2：简历存储 + 一键填充）
 *
 * 职责：
 * 1. 读取本地简历数据回填到表单
 * 2. 保存表单内容到 chrome.storage.local
 * 3. 向当前标签页的 content script 下发填充指令
 *
 * 存储结构（阶段 3 的版本管理会在此之上扩展）：
 *   chrome.storage.local = {
 *     resumes: { [id]: { id, name, data, updatedAt } },
 *     activeResumeId: string,
 *     applications: [ { company, position, resumeId, sentAt } ]
 *   }
 */

/** 简历字段名，与 popup.html 中表单控件的 name 属性一一对应 */
const RESUME_FIELDS = [
  "name", "gender", "phone", "birth", "email",
  "education", "graduationYear", "school", "major",
  "workYears", "expectSalary", "currentCompany", "currentPosition",
  "expectPosition", "expectCity",
  "selfIntro", "projectExp",
];

const DEFAULT_RESUME_ID = "default";
const DEFAULT_RESUME_NAME = "通用版";

/* ========== 兜底：把脚本异常显示在弹窗里 ========== */

window.addEventListener("error", (e) => {
  showFatal(`${e.message}（${(e.filename || "").split("/").pop()}:${e.lineno}）`);
});

window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  showFatal(msg);
});

function showFatal(text) {
  const box = document.getElementById("fatal-box");
  if (!box) return;
  box.style.display = "block";
  box.textContent = `脚本异常：${text}`;
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    initVersion();
    bindEvents();
    loadResume();
  } catch (e) {
    showFatal(e.message);
  }
});

/* ========== 初始化 ========== */

function initVersion() {
  const el = document.getElementById("version");
  if (!el) return;
  try {
    el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (e) {
    el.textContent = "v0.2.0";
  }
}

function bindEvents() {
  document.getElementById("btn-save")?.addEventListener("click", saveResume);
  document.getElementById("btn-fill")?.addEventListener("click", fillCurrentPage);
  document.getElementById("btn-demo")?.addEventListener("click", openDemoPage);
  document.getElementById("btn-diag")?.addEventListener("click", runDiagnose);
}

/** 扫描当前招聘页面，把候选控件信息显示在面板里（没有 DevTools 时的排查手段） */
async function runDiagnose() {
  const box = document.getElementById("diag-box");
  box.style.display = "block";
  box.textContent = "正在扫描页面…";

  try {
    const tab = await resolveTargetTab();
    if (!tab || !tab.id) {
      box.textContent = "没找到招聘页面标签，请先打开 Boss直聘/猎聘/智联等页面。";
      return;
    }

    const resp = await sendToTab(tab.id, { type: "DIAGNOSE" });
    if (!resp) {
      box.textContent = `${hostOf(tab.url) || "目标页面"} 未响应，请刷新该页面后重试。`;
      return;
    }

    box.textContent = formatDiagnose(resp);
  } catch (e) {
    box.textContent = "诊断失败：" + e.message;
  }
}

function formatDiagnose(d) {
  const lines = [`${d.host}（${d.frame}）共 ${d.total} 个候选控件`];
  if (!d.items || !d.items.length) {
    lines.push("页面上没有可填充的输入框。");
    return lines.join("\n");
  }
  d.items.forEach((it, i) => {
    const attr = it.attr ? `  {${it.attr}}` : "";
    lines.push(`${i + 1}. [${it.kind}] ${it.ctx || "(无文案)"}${attr}`);
  });
  return lines.join("\n");
}

/** 打开自带的演示页，用于验证填充是否正常（不依赖真实网站） */
function openDemoPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
}

/* ========== 读写存储 ========== */

/** 读取当前激活简历，回填表单 */
async function loadResume() {
  try {
    const { resumes = {}, activeResumeId } = await chrome.storage.local.get([
      "resumes",
      "activeResumeId",
    ]);

    const id = activeResumeId || DEFAULT_RESUME_ID;
    const resume = resumes[id];
    if (!resume || !resume.data) {
      setTip("还没有保存过简历，填写后点「保存简历」。");
      return;
    }

    writeForm(resume.data);
    setTip(`已载入简历：${resume.name || "默认"}（${countFilled(resume.data)} 项）`, "ok");
  } catch (e) {
    console.error("[求职简历助手] 读取简历失败：", e);
    setTip("读取本地简历失败，请重新加载插件。", "error");
  }
}

/** 收集表单 → 写入本地存储 */
async function saveResume() {
  const data = readForm();

  if (!data.name && !data.phone) {
    setTip("请至少填写姓名或手机号。", "error");
    return;
  }

  const btn = document.getElementById("btn-save");
  btn.disabled = true;

  try {
    const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
    const id = DEFAULT_RESUME_ID;
    const record = resumes[id];

    resumes[id] = {
      id,
      name: record?.name || DEFAULT_RESUME_NAME,
      data,
      updatedAt: Date.now(),
    };

    await chrome.storage.local.set({ resumes, activeResumeId: id });
    setTip(`已保存简历（${countFilled(data)} 项字段）。`, "ok");
  } catch (e) {
    console.error("[求职简历助手] 保存简历失败：", e);
    setTip("保存失败，请重试。", "error");
  } finally {
    btn.disabled = false;
  }
}

/* ========== 一键填充 ========== */

async function fillCurrentPage() {
  const btn = document.getElementById("btn-fill");
  btn.disabled = true;
  setTip("正在填充…");

  try {
    // 先保存一遍，保证填充的是表单当前内容
    const data = readForm();
    if (!data.name && !data.phone) {
      setTip("请先填写简历内容再填充。", "error");
      return;
    }
    await chrome.storage.local.set({
      resumes: await mergeResume(data),
      activeResumeId: DEFAULT_RESUME_ID,
    });

    const tab = await resolveTargetTab();
    if (!tab || !tab.id) {
      setTip("没找到可填充的招聘页面，请先打开 Boss直聘 并刷新一次。", "error");
      return;
    }

    const resp = await sendToTab(tab.id, { type: "FILL_RESUME", payload: data });

    if (!resp) {
      setTip(
        `目标页面（${hostOf(tab.url) || "未知"}）没有响应，请切到该页面刷新一次再试。`,
        "error"
      );
      return;
    }
    if (!resp.ok) {
      setTip(resp.reason || "填充失败。", "error");
      return;
    }

    const filled = resp.filled?.length || 0;
    const missed = resp.missed?.length || 0;
    if (filled === 0) {
      setTip(describeFailure(resp.scan), "error");
    } else {
      setTip(
        `已填充 ${filled} 个字段${missed ? `，${missed} 个未匹配` : ""}。`,
        "ok"
      );
    }
  } catch (e) {
    console.error("[求职简历助手] 填充失败：", e);
    setTip("填充失败：页面未响应，刷新页面后重试。", "error");
  } finally {
    btn.disabled = false;
  }
}

/** 支持的招聘站点主域名，与 manifest 的 *.domain 通配保持一致（含子域名） */
const SUPPORTED_DOMAINS = [
  "zhipin.com",
  "liepin.com",
  "zhaopin.com",
  "51job.com",
  "lagou.com",
];

/**
 * 决定"填哪个标签页"，按优先级：
 *  1. 当前活动标签页（从工具栏弹窗点击时的正常场景）
 *  2. 后台记录下的"发起面板请求的招聘页面"标签（从页面右下角按钮打开面板时记录）
 *  3. 所有标签页里最近访问过的招聘站点
 * 这样无论从弹窗、整页面板还是页面悬浮按钮进入，都能填到对的页面。
 */
async function resolveTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isSupportedUrl(active.url)) return active;

  // 后台在打开面板时记下的来源标签
  try {
    const stored = await chrome.storage.session.get("lastJobTabId");
    if (stored && stored.lastJobTabId) {
      const tab = await chrome.tabs.get(stored.lastJobTabId);
      if (tab && isSupportedUrl(tab.url)) return tab;
    }
  } catch (e) {
    // 标签可能已关闭，继续往下找
  }

  const all = await chrome.tabs.query({});
  const candidates = all
    .filter((t) => t.id && isSupportedUrl(t.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

  return candidates[0] || null;
}

function isSupportedUrl(url) {
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return false;
  }
  return SUPPORTED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

/** 把 content script 返回的诊断信息翻译成人话，方便没有 DevTools 时定位问题 */
function describeFailure(scan) {
  if (!scan) return "页面没有返回诊断信息，请刷新页面后重试。";

  const c = scan.counts || {};
  const base = `未匹配到字段：${scan.host || "未知页面"}（${scan.frame === "iframe" ? "iframe 内" : "主文档"}）扫描到 文本框 ${c.text || 0}、富文本 ${c.editable || 0}、下拉 ${c.select || 0}、单选 ${c.radio || 0}。`;

  if (!c.text && !c.editable && !c.select && !c.radio) {
    return base + "页面上没有可填充的控件，可能还没进入填写页面。";
  }
  if (scan.samples && scan.samples.length) {
    return base + "页面上控件的提示文案：" + scan.samples.join(" | ");
  }
  return base;
}

/** 向 content script 发消息，捕获"未注入"错误 */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null); // 页面没有 content script
        return;
      }
      resolve(resp);
    });
  });
}

/** 合并当前表单到存储中的简历记录（保留版本名等元信息） */
async function mergeResume(data) {
  const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
  const id = DEFAULT_RESUME_ID;
  const record = resumes[id];
  resumes[id] = {
    id,
    name: record?.name || DEFAULT_RESUME_NAME,
    data,
    updatedAt: Date.now(),
  };
  return resumes;
}

/* ========== 表单工具 ========== */

function readForm() {
  const form = document.getElementById("resume-form");
  const data = {};
  RESUME_FIELDS.forEach((field) => {
    const el = form.elements[field];
    data[field] = el ? el.value.trim() : "";
  });
  return data;
}

function writeForm(data) {
  const form = document.getElementById("resume-form");
  RESUME_FIELDS.forEach((field) => {
    const el = form.elements[field];
    if (el) el.value = data[field] || "";
  });
}

function countFilled(data) {
  return RESUME_FIELDS.filter((f) => data[f]).length;
}

function setTip(text, level) {
  const el = document.getElementById("tip");
  if (!el) return;
  el.textContent = text;
  el.className = `tip ${level || ""}`.trim();
}
