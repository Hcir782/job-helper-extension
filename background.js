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

  if (msg.type === "LLM_PROXY") {
    proxyLLM(msg.payload).then(sendResponse);
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
 * 列出标签页里的所有框架 id（主文档是 0）。
 *
 * 为什么要按框架逐个处理：`chrome.tabs.sendMessage` 不带 frameId 时会把消息广播给
 * 所有框架，但回调只拿到**最先回话的那一个**。京东校招简历页
 * （campus.jd.com/api/wx/position/index#/resume）里挂着一个客服 iframe
 * （salary-collect-pro.pf.jd.com，里面只有一个「向我提问」输入框），
 * 它比主文档先回话，于是面板显示「iframe 内 扫描到 文本框 1」——
 * 真正的简历表单在主文档里，压根没被处理。
 */
async function listFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    const ids = (results || [])
      .map((r) => r.frameId)
      .filter((id) => typeof id === "number");
    if (ids.length) return Array.from(new Set(ids)).sort((a, b) => a - b);
  } catch (e) {
    // 个别框架注入失败（沙箱页 / 已被移除），退回只处理主文档
  }
  return [0];
}

/**
 * 确保指定框架里已有内容脚本。
 * 只往缺脚本的那一帧注入：content.js 每注入一次就多挂一个 onMessage 监听，
 * 全量重注会让同一次填充被执行两遍（下拉被点两次、值来回变）。
 * @returns {Promise<boolean>} 是否在本轮新注入了脚本
 */
async function ensureFrame(tabId, frameId) {
  const pong = await sendToTab(tabId, { type: "PING" }, frameId);
  if (pong && pong.ok) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: CONTENT_FILES,
    });
  } catch (e) {
    return false;
  }

  await sleep(150);
  const again = await sendToTab(tabId, { type: "PING" }, frameId);
  return !!(again && again.ok);
}

/**
 * 给一帧打分：「有多像一张简历表单」。
 * 判据就是控件数量——客服 / 埋点 iframe 通常只有 1 个输入框，
 * 真表单动辄十几个。伪下拉和富文本权重更高，因为它们只在表单里出现。
 */
function frameScore(resp) {
  const c = (resp && (resp.counts || (resp.scan && resp.scan.counts))) || {};
  const score =
    (c.text || 0) + (c.editable || 0) * 2 + (c.select || 0) + (c.custom || 0) * 2 + (c.radio || 0);
  return score || (resp && resp.total) || 0;
}

/** 合并多帧诊断结果：每帧的条目都带上来源标注，避免"以为是同一页"的误解 */
function mergeDiagnose(scans, injected) {
  if (!scans.length) return { ok: false, reason: "页面未响应，请刷新后重试" };

  const top = scans[0].resp;
  const multi = scans.length > 1;
  const items = [];

  scans.forEach((s) => {
    const tag = multi
      ? `〔${s.resp.host || "框架"}${s.frameId === 0 ? " 主文档" : " iframe"}〕`
      : "";
    (s.resp.items || []).forEach((it) => {
      items.push(Object.assign({}, it, { ctx: tag + (it.ctx || "(无文案)") }));
    });
  });

  return {
    ok: true,
    host: top.host,
    frame: top.frame,
    adapter: top.adapter,
    frames: scans.length,
    total: items.length,
    items: items.slice(0, 40),
    injected: !!injected,
  };
}

/** 把多帧的控件计数加起来，用于「一帧都没填上」时的整体提示 */
function sumCounts(scans) {
  const total = { text: 0, editable: 0, select: 0, custom: 0, radio: 0 };
  scans.forEach((s) => {
    const c = s.resp.counts || {};
    Object.keys(total).forEach((k) => {
      total[k] += c[k] || 0;
    });
  });
  return total;
}

/**
 * 在指定标签页执行填充或诊断。
 *
 * 流程：枚举框架 → 补注入 → 每帧体检（只读，很便宜）→ 按控件多少排序
 *   DIAGNOSE    ：合并成一份带框架标注的结果
 *   FILL_RESUME ：从控件最多的帧开始填，第一个真填上东西的就收工。
 *                 不能对每帧都跑一遍，伪下拉每帧最多要 12 秒，而且会误点客服输入框。
 */
async function runInTab(tabId, action, payload) {
  if (!tabId) return { ok: false, reason: "没有目标标签页" };

  const frameIds = await listFrameIds(tabId);
  const ready = [];
  let injected = false;
  for (const frameId of frameIds) {
    if (await ensureFrame(tabId, frameId)) injected = true;
    ready.push(frameId);
  }
  if (!ready.length) return { ok: false, reason: "无法注入脚本：页面未响应，请刷新后重试" };

  // 体检：拿到每帧的控件数量，据此决定谁才是表单
  const scans = [];
  for (const frameId of ready) {
    const r = await sendToTab(tabId, { type: "DIAGNOSE" }, frameId);
    if (r && r.ok) scans.push({ frameId, resp: r, score: frameScore(r) });
  }
  if (!scans.length) return { ok: false, reason: "页面未响应，请刷新后重试" };
  scans.sort((a, b) => b.score - a.score);

  if (action === "DIAGNOSE") return mergeDiagnose(scans, injected);

  // 填充：从最像表单的那一帧开始，填上就停。
  // 只尝试「得分不低于最高分一半」的帧，且最多 3 帧 —— 广告 / 客服 iframe 里
  // 也可能有一两个输入框，对着它们跑伪下拉会白等 12 秒。
  const topScore = scans[0].score;
  const threshold = Math.max(1, topScore * 0.5);
  let best = null;
  let attempts = 0;

  for (const s of scans) {
    // 第一帧（控件最多的）无论如何都试一次，否则「页面上没有任何控件」会退化成
    // 「页面未响应」，用户就看不懂了
    if (attempts > 0 && s.score < threshold) break;
    if (attempts >= 3) break;
    attempts++;

    const message = { type: action };
    if (payload !== undefined) message.payload = payload;
    const r = await sendToTab(tabId, message, s.frameId);
    if (r && r.ok && Array.isArray(r.filled) && r.filled.length) {
      best = r;
      break;
    }
    if (!best && r) best = r;
  }
  if (!best) return { ok: false, reason: "页面未响应，请刷新后重试" };

  if (!best.filled || !best.filled.length) {
    // 一帧都没填上：把全页的统计塞进 scan，别让用户只看到某个 iframe 的 1 个输入框
    best.scan = Object.assign({}, best.scan || {}, {
      counts: sumCounts(scans),
      frames: scans.length,
      frameHosts: scans.map((s) => s.resp.host).filter(Boolean),
    });
  } else {
    best.scan = Object.assign({}, best.scan || {}, { frames: scans.length });
  }

  best.injected = !!injected;
  return best;
}

function sendToTab(tabId, message, frameId) {
  return new Promise((resolve) => {
    const opts = typeof frameId === "number" ? { frameId } : undefined;
    const cb = (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    };
    if (opts) chrome.tabs.sendMessage(tabId, message, opts, cb);
    else chrome.tabs.sendMessage(tabId, message, cb);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ==================== 大模型请求转发（v0.11.0 简历导入） ==================== */

/**
 * 由后台代发大模型请求，而不是在弹窗里直接 fetch。
 *
 * 原因有两个，都是踩过的坑：
 *  1. 弹窗（action popup）一旦失去焦点就整个销毁，正在跑的请求会被中断，
 *     用户点一下网页就前功尽弃；Service Worker 至少能撑到请求结束。
 *  2. 弹窗里直连第三方 API 会遇到 CORS——很多模型服务的鉴权头
 *     （Authorization）在预检阶段不被允许，报一个和真实原因无关的 CORS 错误。
 *     manifest 的 host_permissions 已放开全部站点，后台 fetch 不受这个限制。
 *
 * 注意：注释里别写 `https://*` 这种带斜杠的写法——`*` 紧跟在 `/` 后面会提前
 * 结束块注释，导致整个 Service Worker 解析失败、扩展直接加载不起来
 * （integration-smoke.test.js 的「链路A」就是在守这一条）。
 *
 * 安全边界：Key 只存在 chrome.storage.local，只拼进这一次请求头，
 * 后台不打印、不写入任何日志。可选「仅本次会话」存在 session 区。
 */
async function proxyLLM(payload) {
  const p = payload || {};
  if (!p.url) return { ok: false, message: "缺少请求地址。" };

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutMs = p.timeoutMs || 60000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const resp = await fetch(p.url, {
      method: p.method || "POST",
      headers: p.headers || {},
      body: typeof p.body === "string" ? p.body : JSON.stringify(p.body || {}),
      signal: controller ? controller.signal : undefined,
    });
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      retryAfter: resp.headers.get("retry-after") || "",
      text,
    };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      network: true,
      message: aborted
        ? `请求超过 ${Math.round(timeoutMs / 1000)} 秒没有响应。`
        : `网络请求失败：${e.message}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
