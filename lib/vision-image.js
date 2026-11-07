/**
 * lib/vision-image.js —— 图片简历的纯函数层（v0.12.0）
 *
 * 与 pdf-text.js 的分工：PDF 走「本地抽文字，只上传文字」；
 * 图片没有文字层可抽，走多模态模型——**压缩后的图片本身会上传**给用户配置的模型服务。
 * 这条隐私边界必须在 UI 和 README 里讲清楚，不能混在一起说。
 *
 * 这里只放能在 Node 单测里跑的纯函数：
 *   - 文件类型判定、压缩尺寸计算（压缩本体在 popup.js 里，那一步需要 canvas / DOM）
 *   - 多模态消息的 content 数组构造（OpenAI 兼容的 image_url 写法）
 *   - 「模型不支持图片」的错误识别（把 400 翻译成「换一个多模态模型」的提示）
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_VISION = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** 支持的图片类型：扩展名 → MIME */
  const IMAGE_MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };

  /** popup.html 文件选择框的 accept 值，与 IMAGE_MIME 保持同源 */
  const ACCEPT_ATTR =
    "application/pdf,.pdf," +
    Object.keys(IMAGE_MIME).map((e) => `.${e}`).join(",") +
    "," +
    Object.values(IMAGE_MIME).join(",");

  /** 原始图片上限：手机直出的照片可能 8~12 MB，压缩前的宽容值 */
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  /** 压缩后最长边：超过这个分辨率对 OCR 没有额外收益，只会烧 token */
  const MAX_EDGE = 2000;

  /** JPEG 压缩质量：0.85 在清晰度与体积之间的经验值 */
  const JPEG_QUALITY = 0.85;

  /** 取文件扩展名（小写，无点）；没有扩展名返回空串 */
  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
    return m ? m[1].toLowerCase() : "";
  }

  /**
   * 判断是不是支持的图片文件。
   * MIME 与扩展名任一命中即可——拖拽进来的文件 MIME 可能为空，
   * 而部分系统给 .jpg 的 File.type 可能是空串，只信一边会漏。
   */
  function isImageFile(name, mime) {
    const m = String(mime || "").toLowerCase();
    if (m && Object.values(IMAGE_MIME).indexOf(m) !== -1) return true;
    return !!IMAGE_MIME[extOf(name)];
  }

  /**
   * 等比缩到最长边不超过 maxEdge；已经够小就原样返回。
   * 返回 { width, height }，至少 1px，避免 0 尺寸画布报错。
   */
  function computeScaledSize(width, height, maxEdge) {
    const w = Math.max(1, Math.floor(Number(width) || 1));
    const h = Math.max(1, Math.floor(Number(height) || 1));
    const limit = Math.max(1, Math.floor(Number(maxEdge) || MAX_EDGE));
    if (w <= limit && h <= limit) return { width: w, height: h };
    const scale = limit / Math.max(w, h);
    return {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    };
  }

  /** 是否是支持的图片 dataURL（jpeg / png / webp，base64） */
  function isImageDataUrl(url) {
    return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(url || ""));
  }

  /** 估算 dataURL 对应的原始字节数（base64 每 4 字符 3 字节） */
  function estimateDataUrlBytes(url) {
    const s = String(url || "");
    const i = s.indexOf(",");
    if (i < 0) return 0;
    const b64 = s.slice(i + 1);
    return Math.floor((b64.length * 3) / 4);
  }

  /** 单张图片 → OpenAI 兼容多模态消息里的一段 content part */
  function buildImagePart(dataUrl) {
    if (!isImageDataUrl(dataUrl)) {
      throw new Error("图片不是合法的 dataURL，无法发给模型。");
    }
    return { type: "image_url", image_url: { url: dataUrl } };
  }

  /**
   * 拼多模态 user 消息的 content 数组：图片在前、文字指令在后。
   * 返回的是数组（而不是字符串），llm-client 的 buildBody 原样透传，不需要改。
   * @param {string[]} dataUrls
   * @param {string} text 文字指令
   */
  function buildImageContent(dataUrls, text) {
    const urls = (Array.isArray(dataUrls) ? dataUrls : [dataUrls]).filter(Boolean);
    if (!urls.length) throw new Error("没有可发送的图片。");
    const parts = urls.map(buildImagePart);
    if (text) parts.push({ type: "text", text: String(text) });
    return parts;
  }

  /**
   * 识别「模型不支持图片输入」的报错。
   * 各家措辞不一（image_url 不支持 / not a vision model / 无法识别图片），
   * 抓「图片类关键词 + 拒绝类措辞」同时出现，避免把别的 400 误判成这个。
   */
  function isVisionUnsupported(message) {
    const msg = String(message || "");
    const aboutImage = /(\bimage|image_url|图片|图像|vision|multimodal|多模态|视觉)/i.test(msg);
    const refused = /(不支持|not support|unsupported|无法处理|cannot process|无可用|invalid_image|does not support)/i.test(msg);
    return aboutImage && refused;
  }

  return {
    IMAGE_MIME,
    ACCEPT_ATTR,
    MAX_IMAGE_BYTES,
    MAX_EDGE,
    JPEG_QUALITY,
    extOf,
    isImageFile,
    computeScaledSize,
    isImageDataUrl,
    estimateDataUrlBytes,
    buildImagePart,
    buildImageContent,
    isVisionUnsupported,
  };
});
