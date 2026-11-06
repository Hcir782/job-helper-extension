/**
 * 端到端测试：页面里有多个框架时，插件能不能把「简历表单」那一帧挑出来
 *
 * 运行：node tests/e2e-frames.js
 *
 * 为什么需要它：`chrome.tabs.sendMessage` 不带 frameId 时会把消息广播给所有框架，
 * 但回调只拿到最先回话的那一个。京东校招简历页（campus.jd.com/api/wx/position/index#/resume）
 * 右下角挂着一个客服 iframe（salary-collect-pro.pf.jd.com，只有一个「向我提问」输入框），
 * 它先回话 → 面板显示「iframe 内 扫描到 文本框 1」，真正的表单在主文档里没被处理。
 *
 * 这个测试加载**真实的扩展**、起一个本地 http 服务、复刻「主文档表单 + 客服 iframe」的结构，
 * 然后从扩展页面发 RUN_IN_TAB，验证：
 *   - 填充发生在主文档，客服 iframe 的输入框一个字符都没被写
 *   - 返回的诊断里标注了框架数量
 *
 * 依赖：Microsoft Edge + puppeteer-core。缺任一条件跳过，退出码 0。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function skip(reason) {
  console.log(`e2e（多框架）：跳过 —— ${reason}`);
  process.exit(0);
}

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch (e) {
  skip("未安装 puppeteer-core");
}

const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) skip("未找到 Microsoft Edge");

const preset = JSON.parse(
  fs.readFileSync(path.join(ROOT, "presets", "resume-wangruiyao.json"), "utf8")
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

/** 起一个只读的静态服务：扩展的 host_permissions 是 <all_urls>，http 页面才注入得了 */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

(async () => {
  console.log("多框架（主文档表单 + 客服 iframe）端到端测试：");

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: "new",
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      // Chrome/Edge 138 起 --load-extension 默认被关掉，必须显式打开
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-sandbox",
      "--hide-scrollbars",
    ],
  });

  try {
    // 1. 拿到扩展 id（service worker 的 URL 里带着）
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 20000 }
    );
    const extId = new URL(target.url()).host;
    console.log(`      扩展已加载：${extId}`);

    // 2. 打开被测页面（主文档表单 + 右下角客服 iframe）
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 900 });
    await page.goto(`${base}/demo-frames.html`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const frames = page.frames().length;
    check("页面里有 2 个框架（主文档 + 客服 iframe）", frames, 2);

    // 3. 从扩展页面里发指令（等价于面板点「一键填充」）
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 500));

    const payload = {
      name: preset.data.name,
      phone: preset.data.phone,
      email: preset.data.email,
    };

    const fillResp = await extPage.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith("http://127.0.0.1:"));
      if (!tab) return { ok: false, reason: "没找到被测标签页" };
      return await chrome.runtime.sendMessage({
        type: "RUN_IN_TAB",
        tabId: tab.id,
        action: "FILL_RESUME",
        payload: p,
      });
    }, payload);

    await new Promise((r) => setTimeout(r, 400));

    const state = await page.evaluate(() => {
      const cs = document.getElementById("cs-frame");
      const doc = cs && cs.contentDocument;
      return {
        name: document.getElementById("f-name")?.value || "",
        phone: document.getElementById("f-phone")?.value || "",
        email: document.getElementById("f-email")?.value || "",
        chat: (doc && doc.getElementById("cs-input")?.value) || "",
      };
    });

    // 4. 核心断言：填的是主文档，不是客服 iframe
    check("填充返回 ok", fillResp && fillResp.ok, true);
    check(
      "主文档三个字段都填上了",
      [state.name, state.phone, state.email],
      [preset.data.name, preset.data.phone, preset.data.email]
    );
    check("客服 iframe 的输入框没被写入", state.chat, "");
    check("结果里标注了框架数量（≥2）", fillResp && fillResp.scan && fillResp.scan.frames >= 2, true);

    // 5. 诊断要合并多帧，并标出来源
    const diag = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith("http://127.0.0.1:"));
      return await chrome.runtime.sendMessage({ type: "RUN_IN_TAB", tabId: tab.id, action: "DIAGNOSE" });
    });

    const items = (diag && diag.items) || [];
    check("诊断合并了 2 个框架", diag && diag.frames, 2);
    check("诊断条目里标了「主文档」", items.some((it) => (it.ctx || "").includes("主文档")), true);
    check("诊断条目里标了「iframe」", items.some((it) => (it.ctx || "").includes("iframe")), true);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n结果：${passed}/${passed + failed} 通过`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("e2e 出错：", e);
  process.exit(1);
});
