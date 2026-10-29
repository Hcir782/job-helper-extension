/**
 * lib/date-value.js —— 日期字段取值归一化（阶段 5，纯函数）
 *
 * 招聘表单里的日期有三类控件，三种要求的格式各不相同：
 *   1. <input type="date">            只认 YYYY-MM-DD
 *   2. <input type="month">           只认 YYYY-MM
 *   3. 年月分离的两个下拉（年 / 月）    需要拆成 2027 和 06 分别填
 *
 * 而简历里人写的是「2027-06」「2027/6」「2027年6月」「2027.06」这类，必须先统一。
 *
 * 两个环境共用：
 *   - content.js（注入网页）：<script> 先加载，负责真正写值
 *   - Node 单测（tests/date-value.test.js）：直接 require
 *
 * 设计取舍：只写到「年月」的值填日期控件时，**日补 01**。
 * 因为不补就填不进去（浏览器会当成非法值丢弃），而简历里既然只写到月，
 * 说明具体哪一天本来就没提供。CHANGELOG 与 README 已注明这点。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_DATE = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");

  /**
   * 从任意常见写法里抽出 {year, month, day}，抽不到的段返回空字符串。
   * 支持：2027-06 / 2027/6 / 2027.06 / 2027年6月 / 2027年6月15日 / 2027-06-15 14:30
   */
  function jhParseDate(value) {
    const text = String(value == null ? "" : value).trim();
    const out = { year: "", month: "", day: "", hour: "", minute: "" };
    if (!text) return out;

    // 时间部分（可选）：14:30 / 9:5 / 14:30:00（分钟允许 1 位，统一补零）
    const time = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (time) {
      const h = Number(time[1]);
      const mm = Number(time[2]);
      if (h <= 23 && mm <= 59) {
        out.hour = pad(h);
        out.minute = pad(mm);
      }
    }

    // 日期部分：年必须 4 位；月和日可有可无
    const m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})?\s*[-/.月]?\s*(\d{1,2})?/);
    if (!m) {
      // 只有年份：「2027 年毕业」这类
      const y = text.match(/(19|20)\d{2}/);
      if (y) out.year = y[0];
      return out;
    }

    const year = Number(m[1]);
    if (year < 1900 || year > 2100) return out;
    out.year = String(year);

    if (m[2] != null && m[2] !== "") {
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) out.month = pad(month);
    }
    if (m[3] != null && m[3] !== "") {
      const day = Number(m[3]);
      if (day >= 1 && day <= 31) out.day = pad(day);
    }
    return out;
  }

  /**
   * 按控件类型归一化：返回可直接赋给 el.value 的字符串，无法归一化返回 ""。
   * type 传 el.type（已是小写）。
   */
  function jhNormalizeDateInput(value, type) {
    const t = String(type || "").toLowerCase();
    const d = jhParseDate(value);
    const raw = String(value == null ? "" : value).trim();

    if (t === "time") {
      // 纯时间控件不需要年份
      if (!d.hour) return "";
      return `${d.hour}:${d.minute || "00"}`;
    }

    if (t === "month") {
      // 只有年份时无法填 month
      if (!d.year || !d.month) return "";
      return `${d.year}-${d.month}`;
    }

    if (t === "date") {
      if (!d.year || !d.month) return "";
      // 只到「年月」时按当月 1 日填，见文件头说明
      return `${d.year}-${d.month}-${d.day || "01"}`;
    }

    if (t === "datetime-local") {
      if (!d.year || !d.month) return "";
      return `${d.year}-${d.month}-${d.day || "01"}T${d.hour || "00"}:${d.minute || "00"}`;
    }

    // 普通文本框：保持原样，交给调用方
    return raw;
  }

  /**
   * 拆分成年、月两段，供「年月分离」的两个下拉使用。
   * 返回 {year, month}，缺失的段为空字符串。
   */
  function jhSplitYearMonth(value) {
    const d = jhParseDate(value);
    return { year: d.year, month: d.month };
  }

  /** 是否为需要归一化的日期类控件 */
  function jhIsDateInputType(type) {
    return ["date", "month", "time", "datetime-local"].includes(
      String(type || "").toLowerCase()
    );
  }

  return {
    jhParseDate,
    jhNormalizeDateInput,
    jhSplitYearMonth,
    jhIsDateInputType,
  };
});
