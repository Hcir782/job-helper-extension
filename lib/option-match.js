/**
 * lib/option-match.js —— 下拉选项匹配的纯函数库（阶段 4）
 *
 * 自定义下拉（Ant Design / Element / Moka 自研）的选项文案五花八门：
 *   "本科（全日制）"、"IT运维工程师（2027届）"、"CET-4（520 分）"、
 *   "辽宁省 / 大连市"、"技术部　一级　单选"
 * 这里只做「给一批候选文案 + 用户填的值，选哪个最合适」的判断，
 * 不碰 DOM、不碰 chrome API，方便 Node 单测覆盖。
 *
 * 三个环境共用：
 *   - content.js（注入网页）：<script> 先加载，负责真正的点击
 *   - Node 单测（tests/option-match.test.js）：直接 require
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_OPTION = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /**
   * 归一化文案：去掉所有空白（含全角空格、&nbsp;）、去掉括号补充说明、转小写。
   * 去括号是为了让 "CET-4（520 分）" 能匹配上选项 "CET-4"，
   * 因为两边都会被同样处理，不会造成误判。
   */
  function jhFlatten(text) {
    return String(text == null ? "" : text)
      .replace(/[\s\u00a0\u3000]+/g, "")
      .replace(/[（(][^（()）]*[)）]/g, "")
      .toLowerCase();
  }

  /**
   * 给单个选项打分（0 = 不匹配，越大越好）：
   *   100 归一化后完全相等
   *    70~90 选项文本包含目标值（"本科（全日制）" ← "本科"）
   *    40~60 目标值包含选项文本（"红帽 RHCSA、RHCE" → "RHCE"）
   * 门槛：短于 2 个字符的反向包含不算，避免 "男" 命中 "男/女" 之类噪音。
   */
  function jhScoreOption(optionText, value) {
    const a = jhFlatten(optionText);
    const b = jhFlatten(value);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b)) return 70 + Math.min(b.length, 20);
    if (a.length >= 2 && b.includes(a)) return 40 + Math.min(a.length, 20);
    return 0;
  }

  /**
   * 从一批候选文案里挑最合适的一个，返回下标；都不合适返回 -1。
   * 两个约束：
   *  1. 同分时取原文更短的（更接近精确匹配），避免「本科」选中「本科（专升本）」
   *  2. 只在弱匹配区间（值里包含选项，如「RHCSA、RHCE；CET-4」）出现多个候选时
   *     视为歧义返回 -1 —— 宁可让用户手选，也不能替人瞎挑一个证书
   */
  function jhPickOption(optionTexts, value) {
    const list = Array.isArray(optionTexts) ? optionTexts : [];
    const scored = [];
    list.forEach((text, i) => {
      const score = jhScoreOption(text, value);
      if (score) scored.push({ i, score });
    });
    if (!scored.length) return -1;

    const max = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === max);

    // 弱匹配（40~60 段）有多个候选 = 无法确定，宁可不填
    if (max < 70 && top.length > 1) return -1;

    top.sort((a, b) => String(list[a.i]).length - String(list[b.i]).length);
    return top[0].i;
  }

  /**
   * 级联选择器的值拆分："辽宁省/大连市" → ["辽宁省", "大连市"]
   * 支持 / > , 、 以及两个以上连续空格；单个空格不拆（"大连 上海" 可能是两个城市）。
   */
  function jhSplitCascade(value) {
    const parts = String(value == null ? "" : value)
      .split(/[\/>＞,，、|]+|\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts : [];
  }

  /**
   * 下拉表格里选行：rows 是「每行文案用 | 拼起来」的数组（如 "技术部|一级|单选"）。
   * 单元格完全相等（90）优于整行包含（60）优于单元格包含（50）。
   */
  function jhPickRow(rowTexts, value) {
    const list = Array.isArray(rowTexts) ? rowTexts : [];
    const b = jhFlatten(value);
    if (!b) return -1;

    let best = -1;
    let bestScore = 0;

    list.forEach((row, i) => {
      const cells = String(row == null ? "" : row)
        .split("|")
        .map(jhFlatten)
        .filter(Boolean);
      if (!cells.length) return;

      let score = 0;
      if (cells.some((c) => c === b)) score = 90;
      else if (cells.some((c) => c.includes(b))) score = 60;
      else if (cells.some((c) => c.length >= 2 && b.includes(c))) score = 50;

      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });

    return best;
  }

  /**
   * 判断点击后是否成功：触发器文案里应该出现目标值的某个片段。
   * 有些控件把值藏在 data-value 里、文案不变，这种交给调用方放宽处理。
   */
  function jhLooksApplied(triggerText, value) {
    const a = jhFlatten(triggerText);
    const b = jhFlatten(value);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    // 级联选择器常显示成 "辽宁省 / 大连市"，逐段确认
    const parts = jhSplitCascade(value);
    return parts.length > 1 && parts.every((p) => a.includes(jhFlatten(p)));
  }

  return {
    jhFlatten,
    jhScoreOption,
    jhPickOption,
    jhSplitCascade,
    jhPickRow,
    jhLooksApplied,
  };
});
