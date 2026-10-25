/**
 * background.js —— 扩展后台 Service Worker（Manifest V3）
 *
 * 职责：
 *  1. 接收内容脚本的请求，打开完整操作面板（popup.html 以标签页形式）
 *  2. 阶段 3 的投递记录写入也会以这里为统一入口
 *
 * 为什么需要它：内容脚本运行在网页里，无法直接打开扩展页面，
 * 必须通过 chrome.runtime.sendMessage 让后台调 chrome.tabs.create。
 *
 * 注意：这里刻意不申请 "tabs" 权限（会触发"读取浏览记录"的权限警告），
 * 改用 chrome.storage.session 记住面板标签页 id，避免重复开标签。
 */

const PANEL_PATH = "popup.html";
const PANEL_TAB_KEY = "panelTabId";
const JOB_TAB_KEY = "lastJobTabId";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "OPEN_PANEL") {
    handleOpenPanel(sender).then((ok) => sendResponse({ ok }));
    return true; // 异步响应，保持消息通道
  }

  return false;
});

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

/* 安装 / 更新时的日志，便于在扩展页确认后台已启动 */
chrome.runtime.onInstalled.addListener(() => {
  console.log("[求职简历助手] 已安装/更新，版本:", chrome.runtime.getManifest().version);
});
