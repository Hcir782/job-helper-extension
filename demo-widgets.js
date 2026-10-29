/**
 * demo-widgets.js —— 自定义下拉控件演示页逻辑
 *
 * 目的：用原生 DOM 复刻 Ant Design / Element 那类「假下拉」的真实行为——
 * 选项不在表单里，而是点击后 appendChild 到 body 末尾的浮层中，
 * 这样插件必须「模拟点击 → 等浮层渲染 → 点中选项」才能填上值。
 *
 * 只用于本地演示与联调，不参与真实站点逻辑。
 */

const EDU_OPTIONS = ["大专", "本科", "硕士", "博士"];
const NATION_OPTIONS = ["汉族", "回族", "满族", "蒙古族", "壮族", "维吾尔族", "朝鲜族"];
/** v0.10.0：故意放一个「CET-6（520 分）」，用来验证括号被忽略后同分取更短的 */
const LANG_OPTIONS = ["CET-4", "CET-6", "CET-6（520 分）", "专业英语四级", "无"];
const WORKYEAR_OPTIONS = ["应届生", "1 年以内", "1-3 年", "3-5 年"];
const CASCADE = {
  辽宁省: ["沈阳市", "大连市", "鞍山市"],
  吉林省: ["长春市", "吉林市", "四平市"],
  黑龙江省: ["哈尔滨市", "大庆市"],
};
const DEPTS = [
  { name: "系统运维工程师", level: "技术类" },
  { name: "运维开发工程师", level: "技术类" },
  { name: "网络工程师", level: "技术类" },
  { name: "产品经理", level: "非技术类" },
];

/** 简历里只存城市名（"大连"），级联控件要「省 / 市」路径，演示页负责补全 */
const CITY_PATH = {
  大连: "辽宁省 / 大连市",
  沈阳: "辽宁省 / 沈阳市",
  长春: "吉林省 / 长春市",
  哈尔滨: "黑龙江省 / 哈尔滨市",
};

/* ==================== 通用工具 ==================== */

function placePortal(portal, anchor) {
  const rect = anchor.getBoundingClientRect();
  portal.style.position = "fixed";
  portal.style.left = `${Math.round(rect.left)}px`;
  portal.style.top = `${Math.round(rect.bottom + 4)}px`;
  portal.style.minWidth = `${Math.round(Math.max(rect.width, 200))}px`;
}

function closeAllPortals(except) {
  document.querySelectorAll("[data-widget-portal]").forEach((p) => {
    if (p !== except) p.style.display = "none";
  });
  document.querySelectorAll(".ant-select-open").forEach((el) => el.classList.remove("ant-select-open"));
}

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("[data-widget-portal]") && !e.target.closest(".ant-select-selector, .jh-ts-trigger, .el-input__inner")) {
    closeAllPortals();
  }
});

/* ==================== ① Ant 风格自定义下拉 ==================== */

function mountAntSelect(wrap, options, { searchable = false } = {}) {
  const selector = wrap.querySelector(".ant-select-selector");
  const searchInput = wrapperInput();
  const placeholder = wrap.querySelector(".ant-select-selection-placeholder");
  const itemText = wrap.querySelector(".ant-select-selection-item");

  const portal = document.createElement("div");
  portal.className = "ant-select-dropdown ant-select-dropdown-hidden";
  portal.setAttribute("data-widget-portal", "select");
  document.body.appendChild(portal);

  let current = "";

  function wrapperInput() {
    return wrap.querySelector(".ant-select-selection-search-input");
  }

  function render(keyword) {
    const kw = (keyword || "").replace(/\s/g, "").toLowerCase();
    const list = options.filter((o) => !kw || o.toLowerCase().includes(kw));

    portal.innerHTML = "";
    if (!list.length) {
      portal.innerHTML = '<div class="ant-empty">暂无数据</div>';
      return;
    }

    const box = document.createElement("div");
    box.setAttribute("role", "listbox");
    list.forEach((text) => {
      const item = document.createElement("div");
      item.className = "ant-select-item ant-select-item-option";
      item.setAttribute("role", "option");
      if (text === current) item.classList.add("ant-select-item-option-selected");
      item.textContent = text;
      item.addEventListener("click", () => {
        current = text;
        if (placeholder) placeholder.style.display = "none";
        if (itemText) {
          itemText.style.display = "";
          itemText.textContent = text;
        }
        if (searchInput) searchInput.value = text;
        closeAllPortals();
      });
      box.appendChild(item);
    });
    portal.appendChild(box);
  }

  function open() {
    closeAllPortals(portal);
    wrap.classList.add("ant-select-open");
    selector.setAttribute("aria-expanded", "true");
    render(searchable ? searchInput.value : "");
    placePortal(portal, selector);
    portal.style.display = "block";
  }

  selector.addEventListener("click", () => {
    if (portal.style.display === "block") closeAllPortals();
    else open();
  });

  if (searchable && searchInput) {
    searchInput.addEventListener("input", () => render(searchInput.value));
    searchInput.addEventListener("focus", open);
  }

  render("");
  return {
    reset() {
      current = "";
      if (placeholder) placeholder.style.display = "";
      if (itemText) {
        itemText.textContent = "";
        itemText.style.display = "none";
      }
      if (searchInput) searchInput.value = "";
      closeAllPortals();
    },
  };
}

/* ==================== ② Element 风格级联选择 ==================== */

function mountCascader(wrap) {
  const input = wrap.querySelector(".el-input__inner");
  const portal = document.createElement("div");
  portal.className = "el-cascader__dropdown";
  portal.setAttribute("data-widget-portal", "cascader");
  document.body.appendChild(portal);

  let picked = "";

  function renderLevel1() {
    portal.innerHTML = "";
    const menu1 = document.createElement("div");
    menu1.className = "el-cascader-menu";
    Object.keys(CASCADE).forEach((province) => {
      const node = document.createElement("div");
      node.className = "el-cascader-node";
      node.setAttribute("role", "option");
      node.textContent = province;
      node.addEventListener("click", () => {
        menu1.querySelectorAll(".el-cascader-node").forEach((n) => n.classList.remove("is-active"));
        node.classList.add("is-active");
        renderLevel2(province);
      });
      menu1.appendChild(node);
    });
    portal.appendChild(menu1);
  }

  function renderLevel2(province) {
    portal.querySelectorAll(".el-cascader-menu")[1]?.remove();
    const menu2 = document.createElement("div");
    menu2.className = "el-cascader-menu";
    CASCADE[province].forEach((city) => {
      const node = document.createElement("div");
      node.className = "el-cascader-node";
      node.setAttribute("role", "option");
      node.textContent = city;
      node.addEventListener("click", () => {
        picked = `${province} / ${city}`;
        input.value = picked;
        closeAllPortals();
      });
      menu2.appendChild(node);
    });
    portal.appendChild(menu2);
  }

  function open() {
    closeAllPortals(portal);
    renderLevel1();
    placePortal(portal, input);
    portal.style.display = "flex";
  }

  input.addEventListener("click", () => {
    if (portal.style.display === "flex") closeAllPortals();
    else open();
  });

  return {
    reset() {
      picked = "";
      input.value = "";
      closeAllPortals();
    },
  };
}

/* ==================== ③ 下拉表格 ==================== */

function mountTableSelect(wrap) {
  const trigger = wrap.querySelector(".jh-ts-trigger");
  const valueEl = wrap.querySelector(".jh-ts-value");

  const portal = document.createElement("div");
  portal.className = "jh-ts-popup";
  portal.setAttribute("data-widget-portal", "table");
  portal.style.display = "none";
  document.body.appendChild(portal);

  let pickedIndex = -1;

  function render() {
    portal.innerHTML = "";
    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th></th><th>职位</th><th>类别</th></tr></thead>";
    const tbody = document.createElement("tbody");

    DEPTS.forEach((dept, i) => {
      const tr = document.createElement("tr");
      tr.setAttribute("role", "option");
      if (i === pickedIndex) tr.classList.add("is-picked");
      tr.innerHTML =
        `<td><input type="radio" name="jh-dept" value="${dept.name}" ${i === pickedIndex ? "checked" : ""}></td>` +
        `<td>${dept.name}</td><td>${dept.level}</td>`;
      tr.addEventListener("click", () => {
        pickedIndex = i;
        tbody.querySelectorAll("tr").forEach((row) => row.classList.remove("is-picked"));
        tr.classList.add("is-picked");
        const radio = tr.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    portal.appendChild(table);

    const actions = document.createElement("div");
    actions.className = "jh-ts-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => closeAllPortals());

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ok";
    ok.textContent = "确定";
    ok.addEventListener("click", () => {
      if (pickedIndex >= 0) {
        valueEl.textContent = DEPTS[pickedIndex].name;
        valueEl.classList.remove("is-empty");
      }
      closeAllPortals();
    });

    actions.appendChild(cancel);
    actions.appendChild(ok);
    portal.appendChild(actions);
  }

  function open() {
    closeAllPortals(portal);
    render();
    placePortal(portal, trigger);
    portal.style.display = "block";
  }

  trigger.addEventListener("click", () => {
    if (portal.style.display === "block") closeAllPortals();
    else open();
  });

  return {
    reset() {
      pickedIndex = -1;
      valueEl.textContent = "请选择职位";
      valueEl.classList.add("is-empty");
      closeAllPortals();
    },
  };
}

/* ==================== 页面装配 ==================== */

const widgets = {};

document.addEventListener("DOMContentLoaded", () => {
  widgets.education = mountAntSelect(document.getElementById("w-education"), EDU_OPTIONS);
  widgets.nation = mountAntSelect(document.getElementById("w-nation"), NATION_OPTIONS, { searchable: true });
  widgets.city = mountCascader(document.getElementById("w-city"));
  widgets.position = mountTableSelect(document.getElementById("w-position"));
  // v0.10.0：多两个自定义下拉，用来验证「控件变多后不会因为时间预算被跳过」
  widgets.language = mountAntSelect(document.getElementById("w-language"), LANG_OPTIONS, { searchable: true });
  widgets.workyears = mountAntSelect(document.getElementById("w-workyears"), WORKYEAR_OPTIONS);
  mountYearMonthPair();

  document.getElementById("btn-fill-custom")?.addEventListener("click", runFill);
  document.getElementById("btn-reset-custom")?.addEventListener("click", resetAll);
});

/**
 * 演示页把简历数据「翻译」成这类控件能吃的值：
 * 简历里存的是城市名（"大连"），级联控件要「省 / 市」路径。
 * 属于演示页自己的适配，插件本身不做这种补全。
 */
function buildDemoPayload(data) {
  const payload = Object.assign({}, data);
  const city = String(payload.expectCity || "").replace(/\s/g, "");
  if (CITY_PATH[city]) payload.expectCity = CITY_PATH[city];
  // 演示页专用补位：真实简历里「出生年月」按用户要求留空，
  // 但年月分离控件需要一个值才能验证「2005-08 → 2005 / 08」的拆分。
  // 只在这里补，不写回简历，不污染用户数据。
  if (!payload.birth) payload.birth = "2005-08";
  return payload;
}

async function runFill() {
  const msg = document.getElementById("custom-msg");
  msg.className = "msg";
  msg.textContent = "";

  try {
    const { resumes = {}, activeResumeId } = await chrome.storage.local.get(["resumes", "activeResumeId"]);
    const resume = resumes[activeResumeId || "default"];
    if (!resume || !resume.data) {
      msg.className = "msg error";
      msg.textContent = "还没有保存过简历，请先打开插件面板填写并保存。";
      return;
    }

    const result = await fillResume(buildDemoPayload(resume.data));
    const filled = result.filled.length;
    const custom = (result.filledCustom || []).map((x) => x.field);

    msg.className = "msg";
    msg.textContent =
      `已填充 ${filled} 个字段` +
      (custom.length ? `（其中自定义控件 ${custom.length} 个：${custom.join("、")}）` : "") +
      (result.missed.length ? `，${result.missed.length} 个未匹配（${result.missed.join("、")}）` : "") +
      "。";
  } catch (e) {
    console.error("[自定义控件演示页] 填充失败：", e);
    msg.className = "msg error";
    msg.textContent = "填充出错：" + e.message;
  }
}

/**
 * 年月分离控件（v0.10.0）。
 * 真实网申常把「出生年月 / 入学时间」拆成两个原生 select：
 * 一个是年份列表，一个是 01-12 月份列表，各自带「年」「月」占位。
 * 这类控件按字段名匹配不到「出生年月」，必须靠 lib/date-group.js 先配对再拆值。
 */
function mountYearMonthPair() {
  const y = document.getElementById("w-birth-year");
  const m = document.getElementById("w-birth-month");
  if (!y || !m) return;

  const yOpts = ['<option value="">年</option>'];
  for (let i = 2010; i >= 2000; i--) yOpts.push(`<option value="${i}">${i}</option>`);
  y.innerHTML = yOpts.join("");

  const mOpts = ['<option value="">月</option>'];
  for (let i = 1; i <= 12; i++) {
    const v = String(i).padStart(2, "0");
    mOpts.push(`<option value="${v}">${v}</option>`);
  }
  m.innerHTML = mOpts.join("");
}

function resetAll() {
  Object.values(widgets).forEach((w) => w && w.reset && w.reset());
  ["w-politics", "w-gradmonth", "w-birth-year", "w-birth-month"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const msg = document.getElementById("custom-msg");
  msg.className = "msg";
  msg.textContent = "控件已重置。";
}
