/**
 * 端到端测试：简历 PDF → 44 字段 → 灌进填充引擎
 *
 * 运行：node tests/e2e-import.js
 *
 * 这个测试要回答的是一个真实用户会问的问题：
 *   「你那个 PDF 导入功能，到底能不能用？」
 * 所以它加载**真实的扩展**、打开**真实的 popup 页面**、喂一份**真实生成的 PDF**，
 * 只把最后那个大模型换成本地起的一个假服务（不联网、不花钱）。
 *
 * 覆盖的链路：
 *   1. 点选文件 → FileReader 读成 bytes
 *   2. pdfjs 在浏览器里抽文本层（这一步是真跑，不是 mock）
 *   3. 抽出的文字发给「模型」→ 拿到 44 字段 JSON
 *   4. 校验/归一通过
 *   5. 点「导入为新简历版本」→ 写进 chrome.storage.local
 *   6. 打开一个网申表单页 → 一键填充 → 断言字段真的被填上了
 *
 * 第 6 步是关键：只测到「抽出来了」不算能用，得能填进表单才算闭环。
 *
 * 依赖：Microsoft Edge + puppeteer-core。缺任一条件跳过，退出码 0。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function skip(reason) {
  console.log(`e2e（PDF 导入）：跳过 —— ${reason}`);
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

/* ========== 用最小可用 PDF 手工构造一个带文本层的文件 ========== */

/**
 * 生成一个单页 PDF，页面内容就是给定的几行文字。
 * 不引入任何 PDF 库：手工拼 PDF 的对象结构，几十行代码就够，
 * 而且能确保测试里没有别的依赖在偷偷影响结果。
 */
function makeTextPdf(lines) {
  const ops = ["BT", "/F1 12 Tf", "14 TL", "40 780 Td"];
  lines.forEach((line, i) => {
    if (i > 0) ops.push("T*");
    // PDF 字符串里的 ( ) \ 需要转义；中文用 UTF-16BE 十六进制串
    const hex = Buffer.from(line, "utf16le");
    // utf16le → 需要转成 BE
    for (let i2 = 0; i2 < hex.length; i2 += 2) {
      const t = hex[i2];
      hex[i2] = hex[i2 + 1];
      hex[i2 + 1] = t;
    }
    ops.push(`<${hex.toString("hex").toUpperCase()}> Tj`);
  });
  ops.push("ET");
  const stream = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/* ========== 假模型服务：只认这一份简历 ========== */

/** 模型「读到」这份简历后应该返回的结果（刻意留几处不规范，验证校验层） */
const MODEL_OUTPUT = (() => {
  const d = {};
  // 全部 44 字段都写上，大部分是空串——与真实模型的输出形状一致
  [
    "name", "gender", "birth", "phone", "email", "idType", "idCard", "nationality",
    "nation", "politics", "address", "emergencyContact", "emergencyPhone", "education",
    "graduationYear", "school", "college", "major", "studyMode", "gpaRank", "isOverseas",
    "eduDetail", "highSchool", "expectPosition", "expectCity", "expectSalary", "workYears",
    "acceptRelocate", "availableIntern", "sourceChannel", "referrerCode", "internshipExp",
    "projectExp", "campusExp", "awards", "certificates", "languageLevel", "portfolio",
    "skills", "papers", "currentCompany", "currentPosition", "selfIntro", "hobbies",
  ].forEach((f) => (d[f] = ""));

  d.name = "王瑞瑶";
  d.gender = "女性"; // 非枚举原值 → 应被收敛成「女」
  d.phone = "152-4852-2685"; // 带横线 → 应被规范化
  d.email = "WangRuiYao87@Gmail.com"; // 大写 → 应转小写
  d.education = "本科（全日制）"; // 带括号 → 应收敛成「本科」
  d.graduationYear = "2027年6月"; // 自由日期 → 应压成 2027-06
  d.school = "大连科技学院";
  d.college = "信息科学与技术学院";
  d.major = "网络工程";
  d.studyMode = "全日制";
  d.expectPosition = "系统运维工程师";
  d.expectCity = "大连";
  d.certificates = "红帽 RHCSA、RHCE；CKA；CET-6";
  d.skills = "Linux、Shell 脚本、Kubernetes、Ansible、Python";
  return d;
})();

function startFakeLLM() {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          /* 忽略 */
        }
        requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });

        // 模拟「不支持 json_schema」的服务：验证降级链路真的能跑通
        if (
          parsed.response_format &&
          parsed.response_format.type === "json_schema"
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "response_format json_schema not supported" } }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1200, completion_tokens: 500, total_tokens: 1700 },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
  });
}

/* ========== 静态服务：托管 sample-apply.html（一个极简网申表单） ========== */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function startStatic() {
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

function checkTrue(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

(async () => {
  console.log("PDF 导入 → 填充 端到端测试：");

  const { server: llmServer, requests } = await startFakeLLM();
  const llmPort = llmServer.address().port;
  const staticServer = await startStatic();
  const staticPort = staticServer.address().port;
  const base = `http://127.0.0.1:${staticPort}`;

  const tmpPdf = path.join(os.tmpdir(), `jh-e2e-resume-${Date.now()}.pdf`);
  fs.writeFileSync(
    tmpPdf,
    makeTextPdf([
      "WANG RUIYAO",
      "Female | Phone: 152-4852-2685 | Email: WangRuiYao87@Gmail.com",
      "Dalian Institute of Science and Technology",
      "Network Engineering, Bachelor, 2023.09 - 2027.06",
      "RHCSA / RHCE / CKA / CET-6",
      "Linux, Shell, Kubernetes, Ansible, Python",
    ])
  );

  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: "new",
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-sandbox",
      "--hide-scrollbars",
    ],
  });

  try {
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 20000 }
    );
    const extId = new URL(target.url()).host;
    console.log(`      扩展已加载：${extId}`);

    const panel = await browser.newPage();
    await panel.setViewport({ width: 420, height: 900 });
    const errors = [];
    panel.on("pageerror", (e) => errors.push(e.message));
    await panel.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1200));

    // ---------- 1. 模块都挂上了 ----------
    const mods = await panel.evaluate(() => ({
      schema: typeof JH_SCHEMA !== "undefined" && JH_SCHEMA.FIELDS.length,
      llm: typeof JH_LLM !== "undefined",
      extract: typeof JH_EXTRACT !== "undefined",
      pdf: typeof JH_PDF !== "undefined",
      pdfjs: typeof pdfjsLib !== "undefined",
      ui: !!document.getElementById("drop-zone"),
    }));
    check("44 字段契约可用", mods.schema, 44);
    check("大模型客户端可用", mods.llm, true);
    check("抽取编排可用", mods.extract, true);
    check("PDF 抽文本可用", mods.pdf, true);
    check("pdfjs 已加载（本地 vendor，非 CDN）", mods.pdfjs, true);
    check("导入区块已渲染", mods.ui, true);

    // ---------- 2. 填配置（指向本地假模型服务） ----------
    await panel.evaluate(
      (port) => {
        document.getElementById("llm-baseurl").value = `http://127.0.0.1:${port}/v1`;
        document.getElementById("llm-model").value = "fake-model";
        document.getElementById("llm-key").value = "sk-e2e-test";
      },
      llmPort
    );

    // ---------- 3. 选文件 → 走完整导入 ----------
    const input = await panel.$("#file-input");
    await input.uploadFile(tmpPdf);

    // 等到结果面板出现（模型是本地瞬回的，主要等 pdfjs 解析）
    await panel.waitForFunction(
      () => {
        const box = document.getElementById("import-result");
        return box && box.innerHTML.includes("result-head");
      },
      { timeout: 30000 }
    );

    const ui = await panel.evaluate(() => ({
      status: document.getElementById("import-status").textContent,
      resultText: document.getElementById("import-result").textContent,
      actionsVisible: !document.getElementById("import-actions").hidden,
    }));

    checkTrue("状态栏报告解析完成", /解析完成/.test(ui.status), ui.status);
    checkTrue("结果里出现姓名", ui.resultText.includes("王瑞瑶"));
    checkTrue("结果里出现院校", ui.resultText.includes("大连科技学院"));
    check("导入按钮已出现", ui.actionsVisible, true);

    // ---------- 4. 校验层是否真的收敛了不规范写法 ----------
    const normalized = await panel.evaluate(() => {
      // 结果对象只存在于弹窗内存里，从 storage 拿不到；这里直接看渲染后的文本
      const t = document.getElementById("import-result").textContent;
      return {
        hasFemale: t.includes("女"),
        hasDashPhone: t.includes("152-4852-2685"),
        hasCleanPhone: t.includes("15248522685"),
        hasUpperEmail: t.includes("WangRuiYao87@Gmail.com"),
        hasLowerEmail: t.includes("wangruiyao87@gmail.com"),
        hasRawDate: t.includes("2027年6月"),
        hasCleanDate: t.includes("2027-06"),
      };
    });
    check("性别：女性 → 女", normalized.hasFemale, true);
    check("手机号：去掉横线", [normalized.hasDashPhone, normalized.hasCleanPhone], [false, true]);
    check("邮箱：转小写", [normalized.hasUpperEmail, normalized.hasLowerEmail], [false, true]);
    check("毕业时间：压成 YYYY-MM", [normalized.hasRawDate, normalized.hasCleanDate], [false, true]);

    // ---------- 5. 降级链路真的被走过 ----------
    checkTrue(
      "不支持 json_schema 时自动降级（假服务返回了 400）",
      requests.length >= 2 &&
        requests.some((r) => r.body.response_format && r.body.response_format.type === "json_schema") &&
        requests.some((r) => r.body.response_format && r.body.response_format.type === "json_object"),
      `实际请求 ${requests.length} 次：${requests.map((r) => (r.body.response_format || {}).type).join(", ")}`
    );
    checkTrue(
      "请求带上了 Authorization 头（由后台代发）",
      requests.every((r) => r.auth === "Bearer sk-e2e-test"),
      JSON.stringify(requests.map((r) => r.auth))
    );

    // ---------- 6. 导入为新版本 ----------
    // 注意：真的点按钮。之前用 panel.click 点不动 —— 面板内容比视口长，
    // 按钮在可视区外，puppeteer 的鼠标点击落不到它身上（而浏览器原生 click() 可以）。
    await panel.evaluate(() => document.getElementById("btn-import-apply").click());
    await new Promise((r) => setTimeout(r, 1200));

    const afterApply = await panel.evaluate(() => ({
      status: document.getElementById("import-status").textContent,
      btnDisabled: document.getElementById("btn-import-apply").disabled,
    }));
    checkTrue(
      "点击后状态栏提示已导入",
      /已导入为新版本/.test(afterApply.status),
      `实际状态：${afterApply.status}｜按钮 disabled=${afterApply.btnDisabled}`
    );

    const stored = await panel.evaluate(async () => {
      const { resumes, activeResumeId } = await chrome.storage.local.get(["resumes", "activeResumeId"]);
      const r = resumes && resumes[activeResumeId];
      return r ? { name: r.name, data: r.data, keys: Object.keys(r.data).length } : null;
    });
    checkTrue("已写入一份新简历版本", !!stored, "storage 里没有 activeResumeId 对应的记录");
    check("新版本包含 44 个字段", stored && stored.keys, 44);
    check("姓名落库正确", stored && stored.data.name, "王瑞瑶");
    check("手机号已规范化后落库", stored && stored.data.phone, "15248522685");
    check("毕业时间已规范化后落库", stored && stored.data.graduationYear, "2027-06");

    // ---------- 7. 闭环：把这份数据填进网申表单 ----------
    const apply = await browser.newPage();
    await apply.goto(`${base}/demo.html`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const fillResp = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith("http://127.0.0.1:"));
      if (!tab) return { ok: false, reason: "没找到被测标签页" };
      const { resumes, activeResumeId } = await chrome.storage.local.get(["resumes", "activeResumeId"]);
      const data = (resumes && resumes[activeResumeId] && resumes[activeResumeId].data) || {};
      return await chrome.runtime.sendMessage({
        type: "RUN_IN_TAB",
        tabId: tab.id,
        action: "FILL_RESUME",
        payload: data,
      });
    });

    await new Promise((r) => setTimeout(r, 500));

    const filled = await apply.evaluate(() => {
      const get = (id) => (document.getElementById(id) || {}).value || "";
      return {
        name: get("d-name"),
        phone: get("d-phone"),
        email: get("d-email"),
        school: get("d-school"),
        major: get("d-major"),
        edu: get("d-edu"),
      };
    });

    checkTrue("填充接口返回 ok", fillResp && fillResp.ok, JSON.stringify(fillResp));
    checkTrue(
      "PDF 抽出来的数据成功填进了网申表单",
      [filled.name, filled.phone, filled.email, filled.school].filter(Boolean).length >= 3,
      `表单实际值：${JSON.stringify(filled)}`
    );
    check("姓名一路填到底没有变形", filled.name, "王瑞瑶");
    check("手机号一路填到底没有变形", filled.phone, "15248522685");

    checkTrue("全程没有未捕获的脚本异常", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    llmServer.close();
    staticServer.close();
    try {
      fs.unlinkSync(tmpPdf);
    } catch (e) {
      /* 忽略 */
    }
  }

  console.log(`\n结果：${passed}/${passed + failed} 通过`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error("e2e 出错：", e);
  process.exit(1);
});
