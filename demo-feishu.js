/**
 * demo-feishu.js —— 飞书 atsx 表单演示页逻辑
 *
 * 只做一件事：用原生 DOM 复刻 atsx Select 的真实行为——
 * 触发器是个 div（不是 <select>），选项点击后才 appendChild 到 body 末尾的浮层里。
 *
 * 与 demo-widgets.js 的区别：这里连「字段名从哪来」也一起还原了，
 * 输入框没有 placeholder，label 在 .atsx-form-item-label 里。
 * 只用于本地演示与端到端测试，不参与真实站点逻辑。
 */

const ATSX_EDU = ["大专", "本科", "硕士", "博士"];
const ATSX_POLITICS = ["群众", "共青团员", "中共预备党员", "中共党员"];
const ATSX_CITIES = ["北京", "上海", "深圳", "大连", "沈阳", "杭州"];

const atsxWidgets = {};

function closeAtsxDropdowns(except) {
  document.querySelectorAll("[data-atsx-portal]").forEach((p) => {
    if (p !== except) p.style.display = "none";
  });
  document.querySelectorAll(".atsx-select-open").forEach((el) => el.classList.remove("atsx-select-open"));
  document.querySelectorAll(".atsx-select-selection").forEach((el) =>
    el.setAttribute("aria-expanded", "false")
  );
}

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("[data-atsx-portal]") && !e.target.closest(".atsx-select-selection")) {
    closeAtsxDropdowns();
  }
});

/** 把一个 .atsx-select 变成可交互的伪下拉 */
function mountAtsxSelect(id, options) {
  const wrap = document.getElementById(id);
  if (!wrap) return null;

  const selection = wrap.querySelector(".atsx-select-selection");
  const rendered = wrap.querySelector(".atsx-select-selection__rendered");

  const portal = document.createElement("div");
  portal.className = "atsx-select-dropdown";
  portal.setAttribute("data-atsx-portal", id);
  document.body.appendChild(portal);

  let current = "";

  function paint() {
    rendered.innerHTML = current
      ? `<div class="atsx-select-selection-selected-value">${current}</div>`
      : '<div class="atsx-select-selection__placeholder">请选择</div>';
  }

  function render() {
    portal.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "atsx-select-dropdown-menu";
    ul.setAttribute("role", "listbox");

    options.forEach((text) => {
      const li = document.createElement("li");
      li.className = "atsx-select-dropdown-menu-item";
      if (text === current) li.classList.add("atsx-select-dropdown-menu-item-selected");
      li.setAttribute("title", text);
      li.textContent = text;
      li.addEventListener("click", () => {
        current = text;
        paint();
        closeAtsxDropdowns();
      });
      ul.appendChild(li);
    });

    portal.appendChild(ul);
  }

  function open() {
    closeAtsxDropdowns(portal);
    wrap.classList.add("atsx-select-open");
    selection.setAttribute("aria-expanded", "true");
    render();

    const rect = selection.getBoundingClientRect();
    portal.style.left = `${Math.round(rect.left)}px`;
    portal.style.top = `${Math.round(rect.bottom + 4)}px`;
    portal.style.minWidth = `${Math.round(Math.max(rect.width, 200))}px`;
    portal.style.display = "block";
  }

  selection.addEventListener("click", () => {
    if (portal.style.display === "block") closeAtsxDropdowns();
    else open();
  });

  paint();

  return {
    reset() {
      current = "";
      paint();
      closeAtsxDropdowns();
    },
  };
}

document.addEventListener("DOMContentLoaded", () => {
  atsxWidgets.education = mountAtsxSelect("f-education", ATSX_EDU);
  atsxWidgets.politics = mountAtsxSelect("f-politics", ATSX_POLITICS);
  atsxWidgets.city = mountAtsxSelect("f-city", ATSX_CITIES);

  document.getElementById("btn-fill-feishu")?.addEventListener("click", runFill);
  document.getElementById("btn-reset-feishu")?.addEventListener("click", resetAll);
});

async function runFill() {
  const msg = document.getElementById("feishu-msg");
  msg.className = "msg";
  msg.textContent = "";

  try {
    const { resumes = {}, activeResumeId } = await chrome.storage.local.get([
      "resumes",
      "activeResumeId",
    ]);
    const resume = resumes[activeResumeId || "default"];
    if (!resume || !resume.data) {
      msg.className = "msg error";
      msg.textContent = "还没有保存过简历，请先打开插件面板填写并保存。";
      return;
    }

    const result = await fillResume(resume.data);
    msg.textContent = `已填充 ${result.filled.length} 个字段` +
      (result.missed.length ? `，${result.missed.length} 个未匹配` : "") + "。";
  } catch (e) {
    console.error("[飞书演示页] 填充失败：", e);
    msg.className = "msg error";
    msg.textContent = "填充出错：" + e.message;
  }
}

function resetAll() {
  Object.values(atsxWidgets).forEach((w) => w && w.reset && w.reset());
  ["f-name", "f-phone", "f-email", "f-school", "f-major"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const msg = document.getElementById("feishu-msg");
  msg.className = "msg";
  msg.textContent = "已重置。";
}
