# AGENTS.md · 简填 JobFill（求职简历助手）开发交接

> 给接手这个仓库的 AI 编码助手看的说明书。读完这一页，你应该能在不动手确认的情况下直接改代码、跑测试、打包。
> 版本：v0.12.0 ｜ 最后更新：2026-11-07

---

## 1. 这是什么

一个 Chrome Extension（Manifest V3），两件事：

1. **填表**：把 44 项中文简历字段一键填进招聘网站的网申表单（Moka、快手、飞书招聘、京东校招等都实测过）。
2. **入库**（v0.11.0 新增）：反过来，把一份简历 PDF 在浏览器本地抽成文字，交给用户自己配置的大模型映射成 44 字段，确认后新建一个简历版本。v0.12.0 起也收图片（JPG/PNG/WebP），走多模态模型直读——**图片本体会上传**（压缩后），与 PDF「只发文字」的隐私边界不同，UI 和文档都必须分开说。

**没有构建步骤。** 不是 npm 项目，没有 `package.json`、没有打包器、没有 TypeScript。所有 `.js` 都是浏览器直接加载的普通脚本（少数按 UMD 写法同时兼容 Node `require`，好让单测能直接跑）。

---

## 2. 环境与命令（Windows 11）

本机 **bash 基本不可用**（`dirname`、`ls`、`head`、`tail` 全都没有），**PowerShell 5.1 捕获 node 的 stdout 也不可靠**（写出来的文件是 GBK 乱码，正则匹配中文/`✓` 全部数到 0）。所以下面统一用 **Node + `execFileSync`** 的方式跑和统计。

```bat
:: Node（管理版，优先用它）
set NODE=C:\Users\hcir0\.workbuddy\binaries\node\versions\22.22.2-3\node.exe

:: 单测（不依赖浏览器，vm 沙箱 + mock chrome.*）
%NODE% tests\resume-schema.test.js

:: 端到端（需要 puppeteer-core + 本机 Edge）
set NODE_PATH=C:\Users\hcir0\.workbuddy\binaries\node\workspace\node_modules
%NODE% tests\e2e-import.js

:: 打发布包 + 校验（两条命令，别手工压 zip）
%NODE% tools\pack.js
%NODE% tools\verify-pack.js D:\jh-dist\job-helper-extension-v0.12.0.zip
```

- git 用便携版：`C:\Users\hcir0\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe`
- **`git push` 会因沙箱拦截 `C:\Users\hcir0\.ssh\*` 而失败，不要反复重试**，直接告诉用户手动推。
- 测试结果想批量统计，就写个临时 Node 脚本 `execFileSync(..., {encoding:"utf8"})` 再数 `✓` / `✗`，不要试图用 PowerShell 管道。
- 更细的开发历史见 `notes/`（只在本地，不进仓库）。

---

## 3. 目录与职责

```
manifest.json          MV3 配置。permissions: storage / activeTab / scripting；host_permissions: <all_urls>
background.js          Service Worker：按需动态注入、LLM_PROXY 代发请求、投递记录写入
content.js             注入网页：字段识别、填充、伪下拉点击、页面诊断、悬浮入口（约 45 KB，最复杂的文件）
field-dictionary.js    44 字段 × 别名的单一数据源（JH_FIELD_GROUPS），面板/词典/预设三处都从它派生
site-adapters.js       站点与组件库适配器、招聘站点域名表、公司/岗位探测
popup.html/.js/.css    面板（同时注册为 options 页）

lib/                   纯函数层，每个都能 Node 单测
  option-match.js      下拉选项打分与选优、级联拆分、表格行选择
  date-value.js        日期归一化（2027年6月 → 2027-06 → 控件要的格式）
  date-group.js        年月分离双下拉的配对
  ledger.js            投递记录去重 / CSV
  llm-client.js        OpenAI 兼容调用：三级结构化输出降级、错误分类、重试、代理 fetch
  resume-schema.js     44 字段契约：JSON Schema、枚举收敛、手机/邮箱/日期规范化、定向修补 prompt
  resume-extract.js    抽取编排：拼 prompt → 调模型 → 校验 → 只修坏字段 → 分块合并
  pdf-text.js          pdf.js 文字层抽取：按坐标还原行序、扫描件判定、分块
  vision-image.js      图片简历纯函数：类型判定、压缩尺寸、多模态消息构造、报错识别
  pdfjs-boot.js        ESM 动态加载内置 pdf.js 并挂 window.pdfjsLib

vendor/                必须提交进仓库（MV3 禁止从 CDN 加载脚本）
  pdf.min.mjs          359 KB
  pdf.worker.min.mjs   1.06 MB

tests/                 11 个单测 + 4 个 e2e，合计 297 条断言
tools/pack.js          手写 ZIP 打包（排除 .git/node_modules/docs/tests/tools）
tools/verify-pack.js   逐条验 CRC + 核对 manifest/popup 引用的资源是否都在包里
demo*.html/.js         演示页，e2e 也靠它们当被测页面
```

---

## 4. 必须遵守的约束（踩过的坑，别再踩一遍）

| 约束 | 具体表现 |
|---|---|
| **Service Worker 不能访问 DOM** | 所有 DOM 操作只能在 content script / popup 里做 |
| **MV3 禁止远程脚本** | `content_security_policy.extension_pages` 已锁 `script-src 'self'`；pdf.js 必须放 `vendor/` 内置 |
| **ESM 动态 import 必须写相对路径** | `import("vendor/pdf.min.mjs")` 会报 `Failed to resolve module specifier`，要写 `"../vendor/pdf.min.mjs"`（相对 `lib/`） |
| **弹窗失焦即销毁** | 长任务（调模型）不能挂在 popup 上，必须 `chrome.runtime.sendMessage({type:"LLM_PROXY"})` 让 SW 代发 |
| **直连第三方 API 会撞 CORS 预检** | `Authorization` 头不在允许列表里，所以请求只能由 SW 发（靠 `host_permissions: <all_urls>` 绕过页面同源限制） |
| **`chrome.tabs.sendMessage` 不带 frameId 会广播** | 回调只拿最先回话的那帧 → 会填到右下角客服 iframe。必须逐帧派发、按控件数量打分 |
| **React 受控组件** | 直接 `el.value = x` 会被框架覆盖，要走原型链上的原生 setter + 派发 `input`/`change`/`blur` |
| **PDF 行序不能靠阅读顺序** | `textContent.items` 的数组顺序不等于视觉顺序，必须按 `transform[4]`(x) / `transform[5]`(y) 重排 |

---

## 5. v0.11.0/v0.12.0 的抽取链路（改这块之前先读）

```
PDF 文件（留在本地，不上传）                      图片文件（压缩后上传）
  → lib/pdf-text.js      pdf.js 抽文字，按坐标还原行序；      → popup.js canvas 等比压缩（≤2000px/JPEG 0.85）
                         不转 Markdown（两栏简历会串行）      → lib/vision-image.js  类型判定/消息构造
  → lib/llm-client.js    POST {baseURL}/v1/chat/completions（两条链路共用）
                          response_format: json_schema → json_object → prompt_only
                          只在 HTTP 400/422（参数不支持）时降档，401/403/网络错误不降档
  → lib/resume-schema.js 确定性校验：枚举收敛、日期/手机/邮箱规范化、白名单、超长截断
  → lib/resume-extract.js 只对「有值但格式不合格」的字段定向修补，最多 2 轮，只接受这些字段的新值
                          extract()（文本）与 extractFromImages()（图片）共用同一个 repairLoop
```

**三个不要动的设计决策**：

1. **44 字段全部 required + 没有就填空字符串**。允许缺失就分不清「简历没写」和「模型漏了」。
2. **能确定性验证的绝不交给 prompt**。「学士→本科」「硕士研究生→硕士」「统招→全日制」必须写在代码里，prompt 只能提概率。
3. **定向修补，不重写整份**。整份重写既贵又容易把上一轮对的字段改坏。

---

## 6. 测试策略

- **单测**（218 条）：`vm` 沙箱加载真实脚本，mock `chrome.*` 和最小的 DOM。能在提交前抓出「按钮没绑事件」「字段与词典不一致」这类问题。
- **e2e**（79 条）：真实 Edge + Puppeteer 加载真实扩展。`e2e-import.js` 会自己拼一份带文字层的 PDF（不引第三方库）、在页面里用 canvas 现画一张简历 PNG（图片链路）、起一个本地假模型服务（故意对 `json_schema` 回 400 逼出降级），断言整条链路直到填进 `demo.html`。
- **puppeteer 的坑**：`page.click()` 点不到视口外的元素（会静默失败），面板比视口长时改用 `page.evaluate(() => el.click())`；`uploadFile` 对同一个输入框第二次喂文件**不触发 change**，要改用页面内 `DataTransfer` 构造 File 派发事件；`waitForFunction` 默认按 RAF 轮询，**后台标签页的 RAF 被冻结**会永远超时，开过别的标签页后要 `bringToFront()` 或 `polling: 250`。
- 改字段相关代码后，至少跑：`integration-smoke`（字段一致性）、`resume-schema`、以及 `e2e-import`。

---

## 7. 提交与发布约定

- 提交信息：`feat:` / `fix:` / `docs:` / `chore:` 前缀，中文描述，一次功能一个提交。
- 版本号只改 `manifest.json` 的 `version`，面板右上角显示的就是它。
- 发版：改 manifest → 更新 CHANGELOG → 跑全量测试 → `tools\pack.js` → `tools\verify-pack.js` → 提交 → 打 tag → （用户手动）push + 建 Release。
- 发布包不该包含：`.git/`、`node_modules/`、`tests/`、`docs/`、`tools/`、`notes/`、`.tmp-*`。当前包是 **35 个文件 / 约 0.53 MB**，其中 pdf.js 占 1.4 MB 未压缩。

---

## 8. 这个仓库绝对不要做的事

- **不要加构建步骤**。它的卖点之一就是「解压即用」，引入 npm/bundler 会毁掉这个定位。
- **不要把 pdf.js 换成 CDN**。MV3 会直接拒绝加载。
- **不要为了「更聪明」让模型推算简历上没有的信息**（比如根据经历区间算工作年限）。抽取只搬运。
- **不要自动覆盖已有简历版本**。导入 PDF 一律新建版本。
- **不要在没跑 `e2e-import.js` 的情况下改 `popup.js` 的导入流程**。弹窗销毁、CORS、pdfjs 加载这三处只有真浏览器能暴露问题。
