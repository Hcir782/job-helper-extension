/**
 * lib/pdf-text.js —— 把 PDF 的文本层抽成带行序的纯文本
 *
 * 为什么不用别人写好的 PDF「解析成 Markdown」库：
 *   简历 PDF 是单页/双页、两栏、表格混排，Markdown 化会把姓名和联系方式挤进同一行，
 *   给大模型反而更难分辨「哪段是教育经历」。这里只做两件事——按页取文本块、
 *   按坐标还原成行——把版面信息保留下来，交给模型去理解。
 *
 * 依赖 pdfjs-dist 的 legacy 构建，通过 file:// 作用域的 worker 加载，
 * 全程在浏览器本地解析，PDF 文件本身不会上传。只有抽出来的文本会发给大模型。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_PDF = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** 低于这个字数，基本可以判定是扫描件（图片版 PDF），没有文本层可抽 */
  const MIN_TEXT_LENGTH = 30;

  /** A4 页面高度量级的容差：纵坐标差小于它就认为是同一行 */
  const LINE_TOLERANCE = 2.5;

  /**
   * 把 pdfjs 的 textContent.items 还原成多行文本。
   *
   * items 是按内容流顺序给出的碎片，坐标在 transform[4]（x）与 transform[5]（y）。
   * 两栏简历的两栏 y 坐标会交错，所以这里先按 y 从大到小分组（PDF 原点在左下，
   * y 越大越靠上），组内再按 x 从小到大拼。这样左右两栏各自成行，而不是串成一行。
   *
   * @param {Array<{str:string, transform:number[], width:number}>} items
   * @returns {string}
   */
  function itemsToLines(items) {
    if (!Array.isArray(items) || !items.length) return "";

    const tokens = items
      .filter((it) => it && typeof it.str === "string" && it.str.length)
      .map((it) => ({
        str: it.str,
        x: (it.transform && it.transform[4]) || 0,
        y: (it.transform && it.transform[5]) || 0,
        w: it.width || 0,
      }));
    if (!tokens.length) return "";

    // 按 y 降序（从上到下），同一行内按 x 升序（从左到右）
    tokens.sort((a, b) => (Math.abs(a.y - b.y) > LINE_TOLERANCE ? b.y - a.y : a.x - b.x));

    const lines = [];
    let cur = null;
    tokens.forEach((t) => {
      if (!cur || Math.abs(cur.y - t.y) > LINE_TOLERANCE) {
        cur = { y: t.y, parts: [t] };
        lines.push(cur);
      } else {
        cur.parts.push(t);
      }
    });

    return lines
      .map((line) => {
        const parts = line.parts.sort((a, b) => a.x - b.x);
        let out = "";
        parts.forEach((p, i) => {
          if (i > 0) {
            const prev = parts[i - 1];
            const gap = p.x - (prev.x + prev.w);
            // 只有明显拉开距离才补空格；中文之间通常不该有空格
            const needSpace =
              gap > 1.2 &&
              /[A-Za-z0-9]$/.test(prev.str) &&
              /^[A-Za-z0-9]/.test(p.str);
            if (needSpace) out += " ";
          }
          out += p.str;
        });
        return out.replace(/[ \t]+$/g, "");
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * 从 Uint8Array 里抽文本。
   * @param {Uint8Array} bytes
   * @param {object} [opts] { pdfjs, workerSrc, maxPages }
   * @returns {Promise<{text:string, pages:number, chars:number, scanned:boolean, perPage:number[]}>}
   */
  async function extractText(bytes, opts) {
    const options = opts || {};
    const pdfjs = options.pdfjs || (typeof pdfjsLib !== "undefined" ? pdfjsLib : null);
    if (!pdfjs) throw new Error("PDF 解析库没有加载，请重新打开扩展面板。");

    const doc = await pdfjs.getDocument({
      data: bytes,
      // worker 由调用方（pdfjs-boot.js）设好；这里再兜一层，防止传进来的实例没配
      workerSrc: options.workerSrc,
      isEvalSupported: false,
    }).promise;

    const total = doc.numPages;
    const maxPages = Math.min(options.maxPages || 8, total);
    const perPage = [];
    const chunks = [];

    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = itemsToLines(content.items);
      perPage.push(text.length);
      if (text) chunks.push(`【第 ${p} 页】\n${text}`);
      page.cleanup();
    }

    const text = chunks.join("\n\n");
    const chars = text.replace(/\s/g, "").length;
    // 判定扫描件的依据是「每页都没字」，而不是总字数少——
    // 一张只有「个人简历」四字的封面页也该算有文本层
    const emptyPages = perPage.filter((n) => n === 0).length;
    return {
      text,
      pages: total,
      parsedPages: maxPages,
      chars,
      scanned: chars < MIN_TEXT_LENGTH && emptyPages === perPage.length,
      perPage,
    };
  }

  /** 按字符预算切块：超长简历分两次抽取，避免被 max_tokens 截断 */
  function chunkText(text, maxChars) {
    const limit = maxChars || 12000;
    const s = String(text || "");
    if (s.length <= limit) return [s];

    const out = [];
    let rest = s;
    while (rest.length > limit) {
      // 优先在换行处断开，避免把一句话劈成两半。
      // lastIndexOf 的 fromIndex 是「起点」，返回的 cut 位于 \n 本身，所以 cut+1 才是断点；
      // 用切片长度（cut）来比阈值会让 90 字的行被判成「太靠前」，退回按字数硬切。
      let cut = rest.lastIndexOf("\n", limit - 1);
      cut = cut >= 0 ? cut + 1 : -1;
      if (cut < limit * 0.6) cut = limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  /** 给用户看的文件大小 */
  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  return { extractText, itemsToLines, chunkText, humanSize, MIN_TEXT_LENGTH };
});
