/**
 * lib/ledger.js —— 投递记录台账核心逻辑（阶段 3）
 *
 * 纯函数库，不依赖 DOM / chrome API，三个环境共用：
 *   - background.js（Service Worker）：importScripts 引入，负责写入与去重
 *   - popup.html（面板）：<script> 引入，负责渲染与 CSV 导出
 *   - Node 单测（tests/ledger.test.js）：直接 require
 *
 * 记录结构：
 *   { company, position, resumeId, resumeName, url, sentAt }
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_LEDGER = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** CSV 表头（中文，方便直接用 Excel 打开） */
  const CSV_HEADER = ["公司", "岗位", "简历版本", "投递时间", "页面链接"];

  /** 台账在 chrome.storage.local 里的键名 */
  const STORAGE_KEY = "applications";

  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  /** 自然日键：同一天的记录视为"同一天投的" */
  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /**
   * 是否重复：同公司 + 同岗位 + 同自然日。
   * 避免刷新页面、反复打开同一个职位页时台账被刷爆。
   */
  function jhIsDuplicate(list, rec) {
    if (!Array.isArray(list) || !list.length) return false;
    const key = dayKey(rec.sentAt);
    const company = normalize(rec.company);
    const position = normalize(rec.position);
    return list.some(
      (r) =>
        dayKey(r.sentAt) === key &&
        normalize(r.company) === company &&
        normalize(r.position) === position
    );
  }

  /**
   * 追加一条投递记录（带去重）。
   * 返回 { list, added }，added=false 表示是重复记录、未写入。
   */
  function jhAddApplication(list, rec) {
    const arr = Array.isArray(list) ? list.slice() : [];
    if (jhIsDuplicate(arr, rec)) return { list: arr, added: false };

    arr.push({
      company: String(rec.company || "").trim() || "未知公司",
      position: String(rec.position || "").trim() || "未知岗位",
      resumeId: rec.resumeId || "",
      resumeName: String(rec.resumeName || "").trim() || "未命名版本",
      url: String(rec.url || "").trim(),
      sentAt: rec.sentAt || Date.now(),
    });
    return { list: arr, added: true };
  }

  /** 单单元格 CSV 转义：含逗号/引号/换行时加双引号，内部引号翻倍 */
  function csvCell(value) {
    const s = value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * 生成 CSV 文本（带 BOM，Excel 直接打开中文不乱码）。
   * 按时间倒序输出：最新投递的在第一行。
   */
  function jhToCSV(list) {
    const rows = (Array.isArray(list) ? list.slice() : [])
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
      .map((r) =>
        [
          r.company,
          r.position,
          r.resumeName,
          jhFormatTime(r.sentAt),
          r.url,
        ]
          .map(csvCell)
          .join(",")
      );

    return (
      "\ufeff" + [CSV_HEADER.join(",")].concat(rows).join("\r\n") + "\r\n"
    );
  }

  /** 时间戳 → "2026-10-25 14:30" */
  function jhFormatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** 建议的 CSV 文件名：投递记录_2026-10-25_1430.csv */
  function jhCsvFileName(now) {
    const d = new Date(now || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return `投递记录_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  }

  return {
    CSV_HEADER,
    STORAGE_KEY,
    jhIsDuplicate,
    jhAddApplication,
    jhToCSV,
    jhFormatTime,
    jhCsvFileName,
    // 暴露给单测/调试
    _internals: { normalize, dayKey, csvCell },
  };
});
