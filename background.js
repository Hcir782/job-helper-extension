/**
 * background.js —— 扩展后台 Service Worker（Manifest V3）
 *
 * 职责：
 *  1. 打开/复用完整操作面板标签页，并记录发起请求的招聘页标签
 *  2. 按需动态注入内容脚本（activeTab + chrome.scripting）
 *     —— 这是"任意招聘网站都能用"的关键：不依赖 manifest 里枚举域名
 *  3. 统一转发 FILL_RESUME / DIAGNOSE 请求并回传结果
 *  4. 阶段 3：投递记录登记（去重后写入 chrome.storage.local.applications）
 *
 * 为什么需要它：内容脚本运行在网页里，既打不开扩展页面，
 * 也无法自己注入到没有预先声明的站点。
 */

importScripts("lib/ledger.js"); // 提供 JH_LEDGER（去重 / CSV / 格式化）

const PANEL_PATH = "popup.html";
const PANEL_TAB_KEY = "panelTabId";
const JOB_TAB_KEY = "lastJobTabId";

/** 注入顺序不能变：词典 / 选项匹配 / 日期归一化 / 适配器要先于 content.js 加载 */
const CONTENT_FILES = [
  "field-dictionary.js",
  "lib/option-match.js",
  "lib/date-value.js",
  "lib/date-group.js",
  "site-adapters.js",
  "content.js",
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "OPEN_PANEL") {
    handleOpenPanel(sender).then((ok) => sendResponse({ ok }));
    return true; // 异步响应，保持消息通道
  }

  if (msg.type === "RUN_IN_TAB") {
    runInTab(msg.tabId, msg.action, msg.payload).then(sendResponse);
    return true;
  }

  if (msg.type === "RECORD_APPLICATION") {
    recordApplication(msg.payload || {}).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_APPLICATIONS") {
    getApplications().then(sendResponse);
    return true;
  }

  if (msg.type === "CLEAR_APPLICATIONS") {
    clearApplications().then(sendResponse);
    return true;
  }

  return false;
});

/* ==================== 面板 ==================== */

/**
 * 处理"打开面板"请求。
 * 顺带记下发起请求的标签页 id（就是当前所在的招聘网站页面），
 * 面板里点"一键填充"时优先填回这个标签，避免填错到面板自己身上。
 */
async function handleOpenPanel(sender) {
  if (sender && sender.tab && sender.tab.id) {
    try {
      await chrome.storage.session.set({ [JOB_TAB_KEY]: sender.tab.id });
    } catch (e) {
      console.warn("[求职简历助手] 记录来源标签失败：", e);
    }
  }
  return openPanel();
}

/** 打开操作面板：已有面板标签就切过去，没有才新建 */
async function openPanel() {
  try {
    const stored = await chrome.storage.session.get(PANEL_TAB_KEY);
    const tabId = stored[PANEL_TAB_KEY];

    if (tabId) {
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (tab && tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return true;
      } catch (e) {
        // 标签已被用户关闭，继续走新建流程
      }
    }

    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
    if (tab && tab.id) {
      await chrome.storage.session.set({ [PANEL_TAB_KEY]: tab.id });
    }
    return true;
  } catch (e) {
    console.error("[求职简历助手] 打开面板失败：", e);
    return false;
  }
}

/* ==================== 动态注入 + 转发 ==================== */

/**
 * 确保目标标签页里已有内容脚本。
 * 已注入（PING 有回应）则跳过；否则用 chrome.scripting 现场注入。
 */
async function ensureContent(tabId) {
  const pong = await sendToTab(tabId, { type: "PING" });
  if (pong && pong.ok) return { injected: false };

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES,
  });

  await sleep(150);

  const again = await sendToTab(tabId, { type: "PING" });
  if (!again) throw new Error("脚本已注入但页面无响应，请刷新页面后重试");

  return { injected: true };
}

/** 在指定标签页执行填充或诊断 */
async function runInTab(tabId, action, payload) {
  if (!tabId) return { ok: false, reason: "没有目标标签页" };

  let injectInfo = { injected: false };
  try {
    injectInfo = await ensureContent(tabId);
  } catch (e) {
    return { ok: false, reason: "无法注入脚本：" + e.message };
  }

  const message = { type: action };
  if (payload !== undefined) message.payload = payload;

  const resp = await sendToTab(tabId, message);
  if (!resp) return { ok: false, reason: "页面未响应，请刷新后重试" };

  // 把"是否刚注入"带回去，面板可以据此提示
  if (typeof resp === "object") resp.injected = !!injectInfo.injected;
  return resp;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ==================== 投递记录（阶段 3） ==================== */

/**
 * 登记一条投递记录。
 * 后台负责补上"用的哪个简历版本"，并调用 JH_LEDGER 去重
 * （同公司 + 同岗位 + 同自然日只记一条）。
 */
async function recordApplication(payload) {
  try {
    const { applications = [], activeResumeId, resumes = {} } =
      await chrome.storage.local.get(["applications", "activeResumeId", "resumes"]);

    // 当前激活的简历版本（记录"这份简历投了哪些公司"）
    const resume = (activeResumeId && resumes[activeResumeId]) || null;
    const record = {
      company: payload.company,
      position: payload.position,
      resumeId: resume ? resume.id : "",
      resumeName: resume ? resume.name : "",
      url: payload.url,
      sentAt: Date.now(),
    };

    const { list, added } = JH_LEDGER.jhAddApplication(applications, record);
    if (added) {
      await chrome.storage.local.set({ applications: list });
    }
    return { ok: true, added, total: list.length };
  } catch (e) {
    console.error("[求职简历助手] 登记投递记录失败：", e);
    return { ok: false, reason: e.message };
  }
}

/** 读取全部投递记录（按时间倒序，面板直接渲染） */
async function getApplications() {
  try {
    const { applications = [] } = await chrome.storage.local.get(["applications"]);
    const list = applications
      .slice()
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    return { ok: true, list };
  } catch (e) {
    console.error("[求职简历助手] 读取投递记录失败：", e);
    return { ok: false, reason: e.message, list: [] };
  }
}

/** 清空投递记录 */
async function clearApplications() {
  try {
    await chrome.storage.local.set({ applications: [] });
    return { ok: true };
  } catch (e) {
    console.error("[求职简历助手] 清空投递记录失败：", e);
    return { ok: false, reason: e.message };
  }
}

/* 安装 / 更新时的日志，便于在扩展页确认后台已启动 */
chrome.runtime.onInstalled.addListener(() => {
  console.log("[求职简历助手] 已安装/更新，版本:", chrome.runtime.getManifest().version);
});
