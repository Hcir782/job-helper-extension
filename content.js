/**
 * content.js —— 注入招聘网站的脚本
 *
 * 职责：
 *  1. 接收 popup 下发的简历数据，匹配页面表单并自动填充
 *  2. 提供 PING 通信通道，供 popup 判断脚本是否已注入
 *  3. 阶段 3：探测当前页面的公司/岗位，自动登记投递记录（仅已知招聘站点）
 *
 * 关键技术点：Boss 直聘等站点是 React 受控组件，直接赋值 el.value 会被
 * React 的 onChange 逻辑覆盖。必须先调用原型链上的原生 value setter，
 * 再手动派发 input / change 事件，React 的合成事件才会感知到变化。
 */

// 开发期注入提示徽标：全量部署后默认关闭（每个页面都弹一下会很吵），需要调试时改回 true
const SHOW_INJECT_BADGE = false;

// 悬浮入口按钮的开关存在 chrome.storage.local.showFloatingButton，默认开启、可在面板里关掉
const FLOAT_BUTTON_KEY = "showFloatingButton";

/** 已自动登记过投递记录的 URL（同一页面只报一次，去重由后台再做一层） */
const jhReportedUrls = new Set();

/**
 * 字段匹配规则来自 field-dictionary.js（别名词典），站点结构识别来自 site-adapters.js。
 * 两者都由 manifest 的 content_scripts 或 background 的动态注入按顺序先加载。
 * 这里保留一份兜底词典，避免单独加载 content.js 时（例如演示页）报错。
 */
const FIELD_RULES =
  typeof JH_FIELD_KEYWORDS !== "undefined"
    ? JH_FIELD_KEYWORDS
    : {
        name: ["姓名", "name"],
        gender: ["性别", "gender"],
        phone: ["手机号", "手机", "联系电话", "phone", "mobile"],
        email: ["邮箱", "email"],
        education: ["学历", "education"],
        school: ["毕业院校", "学校", "school"],
        major: ["专业", "major"],
        expectPosition: ["期望职位", "期望岗位"],
      };

/** 当前页面命中的站点适配器（惰性计算，页面结构可能异步渲染，每次填充前重算） */
let jhAdapter = null;

function refreshAdapter() {
  jhAdapter = typeof jhPickAdapter === "function" ? jhPickAdapter() : null;
  return jhAdapter;
}

/* ==================== 消息监听 ==================== */

(() => {
  console.log("[求职简历助手] content script 已注入:", location.hostname);

  // 只在顶层页面挂 UI，避免 iframe 里重复出现徽标和悬浮按钮
  const isTopFrame = window.top === window.self;
  if (isTopFrame) {
    showInjectBadge();
    mountFloatingButton();
    scheduleAutoReport();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true, pong: true, url: location.href });
        break;

      case "FILL_RESUME":
        try {
          const result = fillResume(msg.payload || {});
          // 填充成功 = 用户确实在投递流程里，顺手登记一次
          if (result.ok && result.filled.length) reportApplication("fill");
          sendResponse(result);
        } catch (e) {
          console.error("[求职简历助手] 填充异常：", e);
          sendResponse({ ok: false, reason: "填充过程出错：" + e.message });
        }
        break;

      case "DIAGNOSE":
        sendResponse(diagnose());
        break;

      default:
        break;
    }

    return false; // 同步响应，无需保持异步通道
  });
})();

/* ==================== 填充主流程 ==================== */

/**
 * @param {Object} payload 简历字段对象，key 见 FIELD_RULES
 * @returns {{ok:boolean, filled:Array, missed:Array, scan:Object}}
 */
function fillResume(payload) {
  const filled = [];
  const missed = [];
  const doneFields = new Set();

  refreshAdapter(); // 页面可能刚渲染完，重新识别站点结构

  const textBoxes = collectTextBoxes();
  const editables = collectEditables();
  const selects = collectSelects();
  const radios = collectRadios();

  // 1. 单行 / 多行文本框
  textBoxes.forEach((el) => {
    const field = detectField(el, payload);
    if (!field || doneFields.has(field)) return;

    const value = String(payload[field] || "").trim();
    if (!value) return;

    if (setNativeValue(el, value)) {
      filled.push({ field, value });
      doneFields.add(field);
      highlight(el);
    }
  });

  // 2. 富文本编辑器（contenteditable）
  editables.forEach((el) => {
    const field = detectField(el, payload);
    if (!field || doneFields.has(field)) return;

    const value = String(payload[field] || "").trim();
    if (!value) return;

    if (setEditableValue(el, value)) {
      filled.push({ field, value });
      doneFields.add(field);
      highlight(el);
    }
  });

  // 3. 下拉框（学历、工作年限等）
  selects.forEach((el) => {
    const field = detectField(el, payload);
    if (!field || doneFields.has(field)) return;

    const value = String(payload[field] || "").trim();
    if (!value) return;

    if (selectOption(el, value)) {
      filled.push({ field, value });
      doneFields.add(field);
      highlight(el);
    }
  });

  // 3. 单选按钮（性别）
  if (payload.gender) {
    if (radios.length && clickRadioByText(radios, payload.gender)) {
      filled.push({ field: "gender", value: payload.gender });
      doneFields.add("gender");
    }
  }

  // 4. 统计未匹配的字段（有值但页面上没找到对应控件）
  Object.keys(payload).forEach((field) => {
    if (payload[field] && !doneFields.has(field) && FIELD_RULES[field]) {
      missed.push(field);
    }
  });

  // 5. 诊断信息：即使没填上，也能看出页面上到底有什么控件
  const scan = {
    host: location.hostname,
    frame: window.top === window.self ? "top" : "iframe",
    counts: {
      text: textBoxes.length,
      editable: editables.length,
      select: selects.length,
      radio: radios.length,
    },
    samples: textBoxes
      .slice(0, 6)
      .map((el) => getTextContext(el).slice(0, 18) || "(无文案)"),
  };

  console.log("[求职简历助手] 填充完成:", { filled, missed, scan });
  return { ok: true, filled, missed, scan };
}

/* ==================== 页面结构诊断 ==================== */

/**
 * 把页面上的候选控件信息导出，供面板显示。
 * 没有 DevTools 时靠它看清页面结构，便于调整匹配规则。
 */
function diagnose() {
  const adapter = refreshAdapter();
  const items = [];

  collectTextBoxes().forEach((el) => {
    items.push({
      kind: el.tagName === "TEXTAREA" ? "textarea" : "input:" + (el.type || "text"),
      ctx: getTextContext(el).slice(0, 40),
      attr: `${el.getAttribute("name") || ""}${el.id ? "#" + el.id : ""}`,
    });
  });

  collectEditables().forEach((el) => {
    items.push({
      kind: "contenteditable",
      ctx: getTextContext(el).slice(0, 40),
      attr: el.className ? String(el.className).slice(0, 20) : "",
    });
  });

  collectSelects().forEach((el) => {
    items.push({
      kind: "select",
      ctx: getTextContext(el).slice(0, 40),
      attr: `${el.getAttribute("name") || ""}${el.id ? "#" + el.id : ""}`,
    });
  });

  if (collectRadios().length) {
    items.push({ kind: "radio", ctx: "共 " + collectRadios().length + " 个单选按钮", attr: "" });
  }

  return {
    ok: true,
    host: location.hostname,
    frame: window.top === window.self ? "top" : "iframe",
    adapter: adapter ? `${adapter.name}（置信度 ${adapter.confidence}）` : "通用规则",
    total: items.length,
    items: items.slice(0, 30),
  };
}

/* ==================== 投递记录登记（阶段 3） ==================== */

/**
 * 延迟自动登记：SPA 站点（Boss直聘等）注入时 title 可能还没渲染出公司/岗位，
 * 等 1.5 秒再探测；之后 hash/popstate 路由变化也补一次探测。
 * 仅对已知招聘站点（JH_JOB_DOMAINS）生效，普通网页不记录，避免噪音和隐私问题。
 */
function scheduleAutoReport() {
  if (typeof jhIsJobSite !== "function" || !jhIsJobSite(location.hostname)) return;

  setTimeout(() => reportApplication("auto"), 1500);

  // SPA 路由切换（Boss/拉勾详情页不刷新页面）
  window.addEventListener("popstate", () => setTimeout(() => reportApplication("auto"), 800));
  window.addEventListener("hashchange", () => setTimeout(() => reportApplication("auto"), 800));
}

/**
 * 把当前页面的公司/岗位发给后台登记。
 * 去重双保险：content 侧同 URL 只报一次；background 侧按"公司+岗位+同一天"再去重。
 */
function reportApplication(reason) {
  if (jhReportedUrls.has(location.href)) return;
  jhReportedUrls.add(location.href);

  let info = { company: "", position: "" };
  try {
    info = typeof jhDetectJobPage === "function"
      ? jhDetectJobPage(document)
      : info;
  } catch (e) {
    console.warn("[求职简历助手] 页面信息探测失败：", e);
  }

  // 公司岗位都探测不到时也记录（保留 URL，用户可在面板里看到链接自行判断）
  chrome.runtime.sendMessage(
    {
      type: "RECORD_APPLICATION",
      payload: {
        company: info.company || "",
        position: info.position || "",
        url: location.href,
        reason,
      },
    },
    () => {
      void chrome.runtime.lastError; // 后台休眠时忽略
    }
  );
}

/* ==================== 元素采集 ==================== */

function collectTextBoxes() {
  return Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
    if (el.tagName === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      if (!["text", "tel", "email", "number", "search", "url"].includes(type)) return false;
    }
    if (el.disabled || el.readOnly) return false;
    return isVisible(el);
  });
}

function collectSelects() {
  return Array.from(document.querySelectorAll("select")).filter(
    (el) => !el.disabled && isVisible(el)
  );
}

function collectRadios() {
  return Array.from(document.querySelectorAll('input[type="radio"]')).filter(
    (el) => !el.disabled && isVisible(el)
  );
}

/** 富文本编辑器（Boss/猎聘 的"个人优势""项目经历"常是 contenteditable 的 div） */
function collectEditables() {
  return Array.from(
    document.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]')
  ).filter((el) => !el.disabled && isVisible(el));
}

/** 元素是否可见（隐藏元素填了也没意义，还会误判匹配） */
function isVisible(el) {
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/* ==================== 字段识别 ==================== */

/**
 * 根据控件上下文推断它对应哪个简历字段。
 * 只在 payload 中"有值"的字段里匹配，避免把无内容字段错误抢占。
 */
function detectField(el, payload) {
  const rawCtx = getTextContext(el);
  // 中文站点的 label 常带空格（"姓　名"），去掉所有空白后再匹配
  const flatCtx = rawCtx.replace(/\s+/g, "");
  const attrCtx = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`;

  let best = null;
  let bestScore = 0;

  Object.entries(FIELD_RULES).forEach(([field, keywords]) => {
    if (!payload[field]) return;

    keywords.forEach((kw) => {
      let score = 0;
      const lowerKw = kw.toLowerCase();

      if (/^[a-z]+$/.test(lowerKw)) {
        // 英文关键词：文案命中权重更高；属性名要求边界匹配
        if (rawCtx.includes(lowerKw)) score = kw.length * 2;
        const boundary = new RegExp(`(^|[\\s_\\-\\[.])${lowerKw}($|[\\s_\\-\\]_.])`, "i");
        if (boundary.test(attrCtx)) score = Math.max(score, kw.length * 2);
      } else {
        // 中文关键词在"去空白"文案里匹配，避免被 class 名干扰
        if (flatCtx.includes(lowerKw)) score = kw.length;
      }

      if (score > bestScore) {
        bestScore = score;
        best = field;
      }
    });
  });

  return best;
}

/** 提取控件周边的可见文案：placeholder、label、aria-label、祖先短文本、前置兄弟节点 */
function getTextContext(el) {
  const parts = [
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
  ];

  // 优先用站点/组件库适配器定位字段文案
  if (jhAdapter) {
    try {
      const container = el.closest(jhAdapter.containerSelector);
      if (container) {
        const labelEl = container.querySelector(jhAdapter.labelSelector);
        if (labelEl && labelEl.innerText) {
          parts.push(labelEl.innerText);
        } else {
          const text = (container.innerText || "").trim();
          if (text && text.length <= 40) parts.push(text);
        }
      }
    } catch (e) {
      // 选择器异常时退回通用规则
    }
  }

  // <label for="xxx"> 形式
  if (el.id) {
    try {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) parts.push(forLabel.innerText);
    } catch (e) {
      // CSS.escape 不可用时忽略
    }
  }

  // 包裹型 <label><span>姓名</span><input></label>
  const label = el.closest("label");
  if (label) parts.push(label.innerText);

  // 向上最多 2 层，取足够短的容器文本（<div><span>姓名</span><input></div>）
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 2) {
    const text = (node.innerText || "").trim();
    if (text && text.length <= 30) {
      parts.push(text);
      break;
    }
    node = node.parentElement;
    depth++;
  }

  // 前置兄弟节点里的文字（表单行常见结构）
  const prev = el.previousElementSibling;
  if (prev) {
    const text = (prev.innerText || "").trim();
    if (text && text.length <= 20) parts.push(text);
  }

  return parts.filter(Boolean).join(" ").toLowerCase();
}

/* ==================== 赋值与事件 ==================== */

/**
 * 用原生 setter 赋值并派发事件。
 * React 会劫持 el.value 的 setter 并记录内部值，直接赋值不触发 onChange；
 * 这里绕过实例属性、直接调用原型上的 setter，再手动派发事件，React 才能感知。
 */
function setNativeValue(el, value) {
  if (el.value === value) return true;

  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return true;
}

/**
 * 富文本编辑器赋值：先聚焦、全选、再走 execCommand('insertText')，
 * 这样 Vue/React 的编辑器内部模型才会同步更新；失败则退化为直接写 textContent。
 */
function setEditableValue(el, value) {
  const current = (el.innerText || "").trim();
  if (current === value) return true;

  try {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    const ok = document.execCommand && document.execCommand("insertText", false, value);
    if (!ok) el.textContent = value;
  } catch (e) {
    el.textContent = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return true;
}

/** 下拉框按选项文案匹配 */function selectOption(el, value) {
  const options = Array.from(el.options || []);
  const target =
    options.find((o) => o.text.trim() === value) ||
    options.find((o) => o.text.includes(value)) ||
    options.find((o) => o.value === value);

  if (!target) return false;

  el.value = target.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** 单选按钮：按文案点击（性别"男/女"） */
function clickRadioByText(radios, value) {
  const target = radios.find((r) => {
    const label = r.closest("label");
    const text = `${r.value} ${label ? label.innerText : ""}`.trim();
    return text.includes(value);
  });

  if (!target) return false;
  target.click();
  return true;
}

/** 填充后给控件一个短暂的绿色描边，方便肉眼确认哪些被填了 */
function highlight(el) {
  const original = el.style.boxShadow;
  el.style.transition = "box-shadow 0.2s";
  el.style.boxShadow = "0 0 0 2px #27ae60";
  setTimeout(() => {
    el.style.boxShadow = original;
  }, 1500);
}

/* ==================== 页面常驻入口按钮 ==================== */

/**
 * 在页面右下角挂一个圆形按钮，点击通过后台打开完整操作面板。
 * 内容脚本无法直接打开扩展页面，必须经 background 调 chrome.tabs.create。
 * 显示/隐藏由面板里的开关（chrome.storage.local.showFloatingButton）控制。
 */
function mountFloatingButton() {
  if (!document.body) return;
  if (document.getElementById("__job_helper_btn__")) return; // 防止重复注入

  const btn = document.createElement("button");
  btn.id = "__job_helper_btn__";
  btn.type = "button";
  btn.textContent = "简";
  btn.title = "打开求职简历助手";
  btn.style.cssText = `
    position: fixed !important;
    right: 18px !important;
    bottom: 110px !important;
    width: 44px !important;
    height: 44px !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 50% !important;
    background: #27ae60 !important;
    color: #ffffff !important;
    font: 600 16px/1 "Microsoft YaHei", "PingFang SC", sans-serif !important;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22) !important;
    cursor: pointer !important;
    z-index: 2147483646 !important;
    display: none !important;
    align-items: center !important;
    justify-content: center !important;
    opacity: 0.9 !important;
    transition: opacity 0.2s, transform 0.2s !important;
  `;

  btn.addEventListener("mouseenter", () => {
    btn.style.setProperty("opacity", "1", "important");
    btn.style.setProperty("transform", "scale(1.06)", "important");
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.setProperty("opacity", "0.9", "important");
    btn.style.setProperty("transform", "scale(1)", "important");
  });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_PANEL" }, () => {
      void chrome.runtime.lastError; // 后台未就绪时忽略，避免控制台报错
    });
  });

  document.body.appendChild(btn);
  applyFloatVisibility(btn);

  // 面板里切换开关时，已打开的页面立即生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[FLOAT_BUTTON_KEY]) {
      applyFloatVisibility(btn, changes[FLOAT_BUTTON_KEY].newValue);
    }
  });
}

/** 根据存储里的开关决定按钮显隐；默认显示（未设置时视为开启） */
function applyFloatVisibility(btn, value) {
  const resolve = (v) => {
    if (v !== undefined) return !!v;
    return chrome.storage.local.get(FLOAT_BUTTON_KEY).then((r) => {
      const enabled = r[FLOAT_BUTTON_KEY] !== false;
      btn.style.setProperty("display", enabled ? "flex" : "none", "important");
    });
  };

  if (value !== undefined) {
    btn.style.setProperty("display", value ? "flex" : "none", "important");
    return;
  }
  resolve(undefined);
}

/* ==================== 注入提示徽标 ==================== */

/**
 * 在页面右上角显示一个绿色小标签，4 秒后淡出。
 * CSS 全部走内联样式 + !important，避免被招聘网站自身样式覆盖。
 */
function showInjectBadge() {
  if (!SHOW_INJECT_BADGE) return;
  if (!document.body) return;

  const badge = document.createElement("div");
  badge.id = "__job_helper_badge__";
  badge.textContent = "求职简历助手 · 已注入";
  badge.style.cssText = `
    position: fixed !important;
    top: 12px !important;
    right: 12px !important;
    z-index: 2147483647 !important;
    padding: 6px 14px !important;
    background: #27ae60 !important;
    color: #ffffff !important;
    font: 13px/1.4 "Microsoft YaHei", "PingFang SC", sans-serif !important;
    border-radius: 16px !important;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25) !important;
    opacity: 0 !important;
    transition: opacity 0.3s ease !important;
    pointer-events: none !important;
  `;

  document.body.appendChild(badge);
  requestAnimationFrame(() => {
    badge.style.setProperty("opacity", "1", "important");
  });

  setTimeout(() => {
    badge.style.setProperty("opacity", "0", "important");
    setTimeout(() => badge.remove(), 350);
  }, 4000);
}
