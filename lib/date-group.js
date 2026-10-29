/**
 * 年月分离控件的配对与拆分（v0.10.0）。
 *
 * 很多网申表单把「入学时间 / 出生年月」拆成两个控件：
 *   <select>2023 2024 …</select>  <select>01 02 … 12</select>
 * 或者两个伪下拉，占位文案分别写「年」「月」。
 * 这种情况只按字段名找不到「入学时间」这个整体，单个控件看着都是「年」「月」，
 * 所以必须先配对成一组，再把简历里的 `2023-09` 拆成 2023 + 09 分别填。
 *
 * 这个文件只做纯判断（不碰 DOM），方便单测：
 *   jhControlKind({ label, options })  → 'year' | 'month' | ''
 *   jhPairYearMonth([{ id, label, options, group }]) → [{ yearId, monthId, group }]
 *
 * `group` 由调用方给（同类控件的共同祖先标识），只有在同一组内的相邻两个控件才会配对，
 * 避免把「毕业年」和另一个表单的「月份」错配在一起。
 */
(function (root) {
  "use strict";

  /** 2023 / 2023年 / 19xx / 20xx */
  const YEAR_TEXT = /^((?:19|20)\d{2})\s*年?$/;
  /** 1 / 01 / 12 / 1月 / 十二月 */
  const MONTH_NUM = /^(\d{1,2})\s*月?$/;
  const MONTH_CN = /^(十|十一|十二|[一二三四五六七八九])\s*月$/;
  const CN_NUM = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
  };

  function clean(texts) {
    return (texts || []).map((t) => String(t == null ? "" : t).trim()).filter(Boolean);
  }

  /**
   * 一组选项文案是不是「年份列表」。
   * 阈值取 80%：部分年份下拉会混进「请选择」这类占位项，但不该因此判失败。
   */
  function jhOptionsLookLikeYears(options) {
    const list = clean(options);
    if (list.length < 3) return false;
    const hits = list.filter((t) => YEAR_TEXT.test(t)).length;
    return hits / list.length >= 0.8;
  }

  /** 一组选项文案是不是「月份列表」（1-12 / 01-12 / 一月-十二月） */
  function jhOptionsLookLikeMonths(options) {
    const list = clean(options);
    if (list.length < 3) return false;
    const hits = list.filter((t) => {
      let m = t.match(MONTH_NUM);
      if (m) {
        const n = Number(m[1]);
        return n >= 1 && n <= 12;
      }
      m = t.match(MONTH_CN);
      return !!(m && CN_NUM[m[1]]);
    }).length;
    return hits / list.length >= 0.8;
  }

  /** 只能看文案时的兜底判断：「年份」→ year，「月份」→ month，「出生年月」→ 无法判断 */
  function jhKindFromLabel(label) {
    const s = String(label == null ? "" : label).trim();
    if (!s) return "";
    const hasYear = /年/.test(s);
    const hasMonth = /月/.test(s);
    if (hasYear && !hasMonth) return "year";
    if (hasMonth && !hasYear) return "month";
    return "";
  }

  /**
   * 判断一个控件是「年」还是「月」。
   * 有可读选项时以选项为准（原生 select 最可靠）；
   * 选项读不到（伪下拉要展开才有）时退回看占位文案。
   */
  function jhControlKind(desc) {
    const d = desc || {};
    const options = clean(d.options);

    if (options.length >= 3) {
      if (jhOptionsLookLikeYears(options)) return "year";
      if (jhOptionsLookLikeMonths(options)) return "month";
      // 选项读得到但不是年月（学历、民族之类），不要靠文案硬猜
      return "";
    }

    return jhKindFromLabel(d.label);
  }

  /**
   * 把相邻的「年 + 月」两个控件配成一组。
   * 只配相邻项：表单里年月几乎总是挨着写的，隔着别的控件配对风险太高。
   * @returns {Array<{yearId:*, monthId:*, group:*}>}
   */
  function jhPairYearMonth(descs) {
    const items = (descs || []).map((d) => ({
      id: d.id,
      group: d.group,
      kind: jhControlKind(d),
    }));

    const out = [];
    const used = new Set();

    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i];
      const b = items[i + 1];
      if (!a.kind || !b.kind) continue;
      if (a.kind === b.kind) continue;
      if (a.group !== b.group) continue;
      if (used.has(a.id) || used.has(b.id)) continue;

      const year = a.kind === "year" ? a : b;
      const month = a.kind === "year" ? b : a;
      out.push({ yearId: year.id, monthId: month.id, group: a.group });
      used.add(a.id);
      used.add(b.id);
      i++; // 已配对的两个控件不参与下一轮
    }

    return out;
  }

  const API = {
    jhOptionsLookLikeYears,
    jhOptionsLookLikeMonths,
    jhKindFromLabel,
    jhControlKind,
    jhPairYearMonth,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.JH_DATEGROUP = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
