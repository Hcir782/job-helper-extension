/**
 * lib/pdfjs-boot.js —— 以 ES Module 方式加载本地的 pdfjs
 *
 * 为什么单独一个文件：
 *   pdfjs-dist 只发 ESM（.mjs），而扩展的其他脚本都是普通 <script>。
 *   MV3 的内容安全策略禁止从远程加载脚本，所以只能把 pdfjs 打包进扩展
 *   （vendor/pdf.min.mjs + vendor/pdf.worker.min.mjs，约 1.4 MB）。
 *   这个文件负责把它加载好、设好 worker 路径，再挂到 window.pdfjsLib，
 *   让普通脚本里的 JH_PDF 能直接用。
 *
 * 加载失败不影响其他功能：只是「从 PDF 导入」这一段显示为不可用。
 */

// 必须写相对路径：裸模块名（"vendor/..."）在浏览器里无法解析，会报
// "Failed to resolve module specifier"。
const PDFJS_PATH = "../vendor/pdf.min.mjs";
const WORKER_PATH = "../vendor/pdf.worker.min.mjs";

window.__pdfjsReady = import(PDFJS_PATH)
  .then((mod) => {
    const lib = mod.default || mod;
    if (mod.GlobalWorkerOptions) {
      // worker 路径同样是相对的：扩展页面在 chrome-extension://<id>/lib/ 下
      mod.GlobalWorkerOptions.workerSrc = new URL(WORKER_PATH, import.meta.url).href;
    }
    window.pdfjsLib = lib;
    window.dispatchEvent(new CustomEvent("jh-pdfjs-ready"));
    return lib;
  })
  .catch((e) => {
    console.error("[求职简历助手] PDF 解析库加载失败：", e);
    window.__pdfjsError = e;
    return null;
  });
