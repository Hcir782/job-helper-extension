/**
 * popup.js —— 弹窗交互逻辑（阶段 3：简历版本管理 + 投递记录）
 *
 * 职责：
 * 1. 多简历版本的增删改切换（新建 / 复制 / 删除 / 切换）
 * 2. 读取本地简历数据回填到表单
 * 3. 保存表单内容到 chrome.storage.local
 * 4. 向当前标签页的 content script 下发填充指令
 *
 * 存储结构：
 *   chrome.storage.local = {
 *     resumes: { [id]: { id, name, data, updatedAt } },  // 多简历
 *     activeResumeId: string,                            // 当前选中版本
 *     showFloatingButton: boolean,
 *     applications: [ { company, position, resumeId, sentAt } ]  // 阶段 3 投递记录
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

/** 当前会话状态：选中版本 id + 已载入的数据快照（用于切换前判断有无未保存修改） */
const state = {
  resumeId: DEFAULT_RESUME_ID,
  loadedData: {},
};

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
    renderResumeList();
    loadResume();
    loadFloatOption();
    loadLedger();
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
    el.textContent = "v0.6.1";
  }
}

function bindEvents() {
  document.getElementById("btn-save")?.addEventListener("click", saveResume);
  document.getElementById("btn-fill")?.addEventListener("click", fillCurrentPage);
  document.getElementById("btn-demo")?.addEventListener("click", openDemoPage);
  document.getElementById("btn-diag")?.addEventListener("click", runDiagnose);
  document.getElementById("opt-float")?.addEventListener("change", saveFloatOption);

  // 简历版本工具栏
  document.getElementById("resume-select")?.addEventListener("change", switchResume);
  document.getElementById("btn-new-resume")?.addEventListener("click", createResume);
  document.getElementById("btn-dup-resume")?.addEventListener("click", duplicateResume);
  document.getElementById("btn-del-resume")?.addEventListener("click", deleteResume);

  // 投递记录
  document.getElementById("btn-export-csv")?.addEventListener("click", exportLedger);
  document.getElementById("btn-clear-ledger")?.addEventListener("click", clearLedger);
}

/** 保存"是否在网页上显示悬浮按钮"，content.js 通过 storage.onChanged 实时响应 */
async function saveFloatOption() {
  const box = document.getElementById("opt-float");
  if (!box) return;
  try {
    await chrome.storage.local.set({ showFloatingButton: box.checked });
  } catch (e) {
    console.error("[求职简历助手] 保存悬浮按钮开关失败：", e);
  }
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

    const resp = await runInTab(tab.id, "DIAGNOSE");
    if (!resp) {
      box.textContent = `${hostOf(tab.url) || "目标页面"} 未响应，请刷新该页面后重试。`;
      return;
    }
    if (!resp.ok) {
      box.textContent = resp.reason || "诊断失败。";
      return;
    }

    box.textContent = formatDiagnose(resp);
  } catch (e) {
    box.textContent = "诊断失败：" + e.message;
  }
}

function formatDiagnose(d) {
  const lines = [
    `${d.host}（${d.frame}）适配器：${d.adapter || "通用规则"}，共 ${d.total} 个候选控件`,
  ];
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

/* ========== 简历版本管理 ========== */

/**
 * 渲染版本下拉框。
 * 选项按更新时间倒序（最近编辑的排前面），并同步选中当前激活版本。
 */
async function renderResumeList() {
  const select = document.getElementById("resume-select");
  if (!select) return;

  const { resumes = {}, activeResumeId } = await chrome.storage.local.get([
    "resumes",
    "activeResumeId",
  ]);
  const activeId = activeResumeId || DEFAULT_RESUME_ID;

  const list = Object.values(resumes).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  select.textContent = "";
  list.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name || "未命名版本";
    opt.title = `最近更新：${formatTime(r.updatedAt)}`;
    opt.selected = r.id === activeId;
    select.appendChild(opt);
  });

  // 同步删除按钮可用状态：只剩一个版本时不允许删除
  const delBtn = document.getElementById("btn-del-resume");
  if (delBtn) delBtn.disabled = list.length <= 1;
}

/** 切换简历版本：有未保存修改时先询问 */
async function switchResume() {
  const select = document.getElementById("resume-select");
  const nextId = select.value;
  if (!nextId || nextId === state.resumeId) return;

  if (isDirty()) {
    const ok = confirm("当前表单有未保存的修改，是否保存到原版本后再切换？\n（取消 = 丢弃修改）");
    if (ok) {
      await saveResume();
    }
  }

  try {
    await chrome.storage.local.set({ activeResumeId: nextId });
  } catch (e) {
    console.error("[求职简历助手] 切换版本失败：", e);
    setTip("切换版本失败，请重试。", "error");
    renderResumeList();
    return;
  }
  await loadResume();
}

/** 新建一个空白简历版本 */
async function createResume() {
  const name = prompt("新简历版本的名称：", DEFAULT_RESUME_NAME);
  if (name === null) return;
  const finalName = name.trim() || DEFAULT_RESUME_NAME;

  const id = genResumeId();
  try {
    const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
    resumes[id] = { id, name: finalName, data: {}, updatedAt: Date.now() };
    await chrome.storage.local.set({ resumes, activeResumeId: id });
  } catch (e) {
    console.error("[求职简历助手] 新建版本失败：", e);
    setTip("新建版本失败，请重试。", "error");
    return;
  }

  renderResumeList();
  await loadResume();
  setTip(`已新建版本「${finalName}」，填写后记得保存。`, "ok");
}

/** 把当前激活版本（已保存的数据）复制为一个新版本 */
async function duplicateResume() {
  const select = document.getElementById("resume-select");
  const srcId = state.resumeId;

  let srcName = DEFAULT_RESUME_NAME;
  let srcData = {};
  try {
    const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
    srcName = resumes[srcId]?.name || DEFAULT_RESUME_NAME;
    srcData = resumes[srcId]?.data || {};
  } catch (e) {
    console.error("[求职简历助手] 读取源版本失败：", e);
  }

  const name = prompt("复制后的版本名称：", `${srcName} 副本`);
  if (name === null) return;
  const finalName = name.trim() || `${srcName} 副本`;

  const id = genResumeId();
  try {
    const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
    resumes[id] = {
      id,
      name: finalName,
      data: { ...srcData },
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ resumes, activeResumeId: id });
  } catch (e) {
    console.error("[求职简历助手] 复制版本失败：", e);
    setTip("复制版本失败，请重试。", "error");
    return;
  }

  renderResumeList();
  await loadResume();
  setTip(`已复制为「${finalName}」（${countFilled(srcData)} 项字段）。`, "ok");
}

/** 删除当前激活版本，删除后自动切换到列表中的第一个版本 */
async function deleteResume() {
  const select = document.getElementById("resume-select");
  const delId = state.resumeId;

  let resumes = {};
  let name = "";
  try {
    ({ resumes = {} } = await chrome.storage.local.get(["resumes"]));
  } catch (e) {
    console.error("[求职简历助手] 读取版本列表失败：", e);
    setTip("删除失败，请重试。", "error");
    return;
  }

  name = resumes[delId]?.name || "当前版本";
  if (Object.keys(resumes).length <= 1) {
    setTip("至少需要保留一个简历版本。", "error");
    return;
  }
  if (!confirm(`确定删除简历版本「${name}」吗？此操作不可恢复。`)) return;

  delete resumes[delId];
  const nextId = Object.keys(resumes)[0];
  try {
    await chrome.storage.local.set({ resumes, activeResumeId: nextId });
  } catch (e) {
    console.error("[求职简历助手] 删除版本失败：", e);
    setTip("删除失败，请重试。", "error");
    return;
  }

  renderResumeList();
  await loadResume();
  setTip(`已删除「${name}」，当前切换到「${resumes[nextId]?.name || "未命名"}」。`, "ok");
}

/** 生成版本 id：时间戳 + 随机后缀，避免同毫秒创建多个版本时冲突 */
function genResumeId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 表单当前内容与已载入数据是否有差异（用于切换/关闭前提醒） */
function isDirty() {
  return JSON.stringify(readForm()) !== JSON.stringify(state.loadedData);
}

/* ========== 投递记录 ========== */

/** 拉取投递记录并渲染（后台按时间倒序返回） */
async function loadLedger() {
  try {
    const resp = await sendMsg({ type: "GET_APPLICATIONS" });
    if (resp && resp.ok) {
      renderLedger(resp.list || []);
    } else {
      renderLedger([]);
    }
  } catch (e) {
    console.error("[求职简历助手] 读取投递记录失败：", e);
    renderLedger([]);
  }
}

/** 渲染投递记录列表（最多显示 50 条，倒序） */
function renderLedger(list) {
  const box = document.getElementById("ledger-list");
  const count = document.getElementById("ledger-count");
  if (!box) return;

  if (count) count.textContent = `${list.length} 条`;

  if (!list.length) {
    box.innerHTML =
      '<div class="ledger-empty">暂无投递记录，打开支持的招聘站点即自动登记</div>';
    return;
  }

  box.innerHTML = list
    .slice(0, 50)
    .map((r) => {
      const company = escapeHtml(r.company);
      const position = escapeHtml(r.position);
      const resume = r.resumeName ? ` · ${escapeHtml(r.resumeName)}` : "";
      const time = JH_LEDGER.jhFormatTime(r.sentAt);
      return (
        `<div class="ledger-row">` +
        `<span class="lr-company" title="${company}">${company}</span>` +
        `<span class="lr-time">${time}</span>` +
        `<span class="lr-sub">${position}${resume}</span>` +
        `</div>`
      );
    })
    .join("");
}

/** 导出 CSV（带 BOM，Excel 直接打开中文不乱码） */
async function exportLedger() {
  try {
    const resp = await sendMsg({ type: "GET_APPLICATIONS" });
    if (!resp || !resp.ok || !resp.list || !resp.list.length) {
      setTip("暂无投递记录可导出。", "error");
      return;
    }

    const csv = JH_LEDGER.jhToCSV(resp.list);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = JH_LEDGER.jhCsvFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    setTip(`已导出 ${resp.list.length} 条投递记录（CSV）。`, "ok");
  } catch (e) {
    console.error("[求职简历助手] 导出 CSV 失败：", e);
    setTip("导出失败，请重试。", "error");
  }
}

/** 清空投递记录 */
async function clearLedger() {
  if (!confirm("确定清空全部投递记录吗？此操作不可恢复。")) return;

  try {
    const resp = await sendMsg({ type: "CLEAR_APPLICATIONS" });
    if (resp && resp.ok) {
      setTip("投递记录已清空。", "ok");
      loadLedger();
    } else {
      setTip("清空失败，请重试。", "error");
    }
  } catch (e) {
    console.error("[求职简历助手] 清空投递记录失败：", e);
    setTip("清空失败，请重试。", "error");
  }
}

/** 通用消息发送（带 Promise 包装，后台无响应时返回 null） */
function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ========== 读写存储 ========== */

/** 读取当前激活简历，回填表单；首次使用自动创建默认版本，兼容阶段 2 的旧数据 */
async function loadResume() {
  try {
    let { resumes = {}, activeResumeId } = await chrome.storage.local.get([
      "resumes",
      "activeResumeId",
    ]);

    // 兼容阶段 2 旧结构：只有单份 resume 数据时迁移为默认版本
    if (Object.keys(resumes).length === 0) {
      const legacy = await chrome.storage.local.get(["resume"]);
      if (legacy.resume && typeof legacy.resume === "object") {
        resumes[DEFAULT_RESUME_ID] = {
          id: DEFAULT_RESUME_ID,
          name: DEFAULT_RESUME_NAME,
          data: legacy.resume,
          updatedAt: Date.now(),
        };
        await chrome.storage.local.set({
          resumes,
          activeResumeId: DEFAULT_RESUME_ID,
        });
      }
    }

    // 首次使用：创建一个空的默认版本，保证下拉框始终有内容
    if (Object.keys(resumes).length === 0) {
      resumes[DEFAULT_RESUME_ID] = {
        id: DEFAULT_RESUME_ID,
        name: DEFAULT_RESUME_NAME,
        data: {},
        updatedAt: Date.now(),
      };
      activeResumeId = DEFAULT_RESUME_ID;
      await chrome.storage.local.set({ resumes, activeResumeId });
    }

    const id = activeResumeId && resumes[activeResumeId]
      ? activeResumeId
      : DEFAULT_RESUME_ID;
    const resume = resumes[id];

    state.resumeId = id;
    writeForm(resume.data || {});
    state.loadedData = readForm();

    const count = countFilled(resume.data || {});
    setTip(
      count > 0
        ? `已载入简历：${resume.name || "默认"}（${count} 项）`
        : `当前版本「${resume.name || "默认"}」还没有内容，填写后点「保存简历」。`,
      count > 0 ? "ok" : ""
    );

    renderResumeList();
  } catch (e) {
    console.error("[求职简历助手] 读取简历失败：", e);
    setTip("读取本地简历失败，请重新加载插件。", "error");
  }
}

/** 收集表单 → 写入当前激活版本 */
async function saveResume() {
  const data = readForm();

  if (!data.name && !data.phone) {
    setTip("请至少填写姓名或手机号。", "error");
    return;
  }

  const btn = document.getElementById("btn-save");
  if (btn) btn.disabled = true;

  try {
    const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
    const id = state.resumeId;
    const record = resumes[id];

    resumes[id] = {
      id,
      name: record?.name || DEFAULT_RESUME_NAME,
      data,
      updatedAt: Date.now(),
    };

    await chrome.storage.local.set({ resumes, activeResumeId: id });
    state.loadedData = readForm();
    setTip(`已保存「${resumes[id].name}」（${countFilled(data)} 项字段）。`, "ok");
    renderResumeList();
  } catch (e) {
    console.error("[求职简历助手] 保存简历失败：", e);
    setTip("保存失败，请重试。", "error");
  } finally {
    if (btn) btn.disabled = false;
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
    const resumes = await mergeResume(data, state.resumeId);
    await chrome.storage.local.set({ resumes });

    const tab = await resolveTargetTab();
    if (!tab || !tab.id) {
      setTip("没找到可填充的招聘页面，请先打开 Boss直聘 并刷新一次。", "error");
      return;
    }

    const resp = await runInTab(tab.id, "FILL_RESUME", data);

    if (!resp) {
      setTip("与扩展后台通信失败，请重新加载插件后重试。", "error");
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
      const injectedTip = resp.injected ? "（已按需注入脚本）" : "";
      setTip(
        `已填充 ${filled} 个字段${missed ? `，${missed} 个未匹配` : ""}${injectedTip}。`,
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

/** 支持的招聘站点主域名（来自 site-adapters.js 的 JH_JOB_DOMAINS，含子域名） */
const SUPPORTED_DOMAINS =
  (typeof window !== "undefined" && window.JH_JOB_DOMAINS) || [
    "zhipin.com",
    "liepin.com",
    "zhaopin.com",
    "51job.com",
    "lagou.com",
  ];

/**
 * 决定"填哪个标签页"，按优先级：
 *  1. 当前活动标签页（普通网页即可，脚本会按需动态注入）
 *  2. 后台记录下的"发起面板请求的页面"标签（从页面右下角按钮打开面板时记录）
 *  3. 所有标签页里最近访问过的页面，招聘站点优先
 * 这样无论从弹窗、整页面板还是页面悬浮按钮进入，都能填到对的页面。
 */
async function resolveTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isInjectableUrl(active.url)) return active;

  // 后台在打开面板时记下的来源标签
  try {
    const stored = await chrome.storage.session.get("lastJobTabId");
    if (stored && stored.lastJobTabId) {
      const tab = await chrome.tabs.get(stored.lastJobTabId);
      if (tab && isInjectableUrl(tab.url)) return tab;
    }
  } catch (e) {
    // 标签可能已关闭，继续往下找
  }

  const all = await chrome.tabs.query({});
  const candidates = all
    .filter((t) => t.id && isInjectableUrl(t.url))
    .sort((a, b) => {
      const knownA = isKnownJobSite(a.url) ? 1 : 0;
      const knownB = isKnownJobSite(b.url) ? 1 : 0;
      if (knownA !== knownB) return knownB - knownA;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });

  return candidates[0] || null;
}

/** 普通网页才可注入（排除 chrome:// 、扩展页、about: 等） */
function isInjectableUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

/** 是否属于已内置适配器的招聘站点 */
function isKnownJobSite(url) {
  if (!isInjectableUrl(url)) return false;
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

/** 向后台发指令：确保脚本已注入后再执行指定动作 */
function runInTab(tabId, action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RUN_IN_TAB", tabId, action, payload }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

/** 合并当前表单到指定版本（保留版本名等元信息） */
async function mergeResume(data, id) {
  const { resumes = {} } = await chrome.storage.local.get(["resumes"]);
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

/** 读取悬浮按钮开关并回填复选框（默认开启） */
async function loadFloatOption() {
  const box = document.getElementById("opt-float");
  if (!box) return;
  try {
    const result = await chrome.storage.local.get(["showFloatingButton"]);
    box.checked = result.showFloatingButton !== false;
  } catch (e) {
    box.checked = true;
  }
}

function setTip(text, level) {
  const el = document.getElementById("tip");
  if (!el) return;
  el.textContent = text;
  el.className = `tip ${level || ""}`.trim();
}

/** 时间戳 → "10-25 14:30" 形式的短标签（用于下拉框 title） */
function formatTime(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
