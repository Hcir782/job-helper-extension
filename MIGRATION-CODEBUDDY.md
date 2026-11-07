# 交接 · 在 CodeBuddy 里继续做 JobFill

> 写于 2026-11-07，从 WorkBuddy 切到 CodeBuddy 时用。同一台电脑，项目原地复用，**不需要复制代码**。

---

## 一、打开就能干活

1. CodeBuddy 里打开文件夹：`D:\job-helper-extension`
2. 它会自动读到仓库根目录的 **`AGENTS.md`**（我刚写的），里面是环境命令、目录职责、必须遵守的约束、测试策略、发布约定。**有这一份就够开始了**，不需要再喂其它上下文。

如果 CodeBuddy 不自动读 `AGENTS.md`，就在第一句话里说：

```
先读 AGENTS.md，再读 .workbuddy/memory/ 下最近几天的记录，然后我们继续 v0.11.0 的待办。
```

---

## 二、项目现在到哪了

| 项 | 状态 |
|---|---|
| 代码 | v0.11.0 完成，4 个 lib 模块 + 接入层，核心约 1,240 行 |
| 测试 | 267 条断言（单测 196 + 端到端 71），2026-11-07 复跑 0 失败 |
| 打包 | `D:\jh-dist\job-helper-extension-v0.11.0.zip`，32 文件 / 526 KB，CRC 全过 |
| Git | 4 个提交，工作区 clean，tag `v0.11.0` 已指向最新提交 `d34be1f` |
| 仓库领先远端 | 2 个提交（`762a39d`、`d34be1f`） |

---

## 三、待办清单（按顺序）

### ① 推送到 GitHub —— 需要你手动执行

```bat
cd /d D:\job-helper-extension
git push origin main
git push -f origin v0.11.0
```

- 第二条带 `-f`：tag 被重新指向过新提交，远端若已有同名 tag 会拒绝普通推送。
- AI 助手在沙箱里推不了（`C:\Users\hcir0\.ssh\*` 被拒），别让它反复重试。

### ② 建 GitHub Release

- 网页：仓库 → Releases → Draft a new release → 选 tag `v0.11.0`
- 标题：`v0.11.0 · 简历 PDF 导入`
- 附件上传：`D:\jh-dist\job-helper-extension-v0.11.0.zip`
- 说明可以直接粘 `CHANGELOG.md` 里 v0.11.0 那一节

### ③ 改仓库 About 描述

现在是错的（写着「本地 Ollama Qwen2 模型」，v0.11.0 早就不止如此）。改成：

```
简历 PDF 智能解析 + 44 项字段一键填网申 · Chrome 扩展
```

### ④ 可选的下一步功能

| 功能 | 工作量 | 建议 |
|---|---|---|
| 图片简历直接上传（走多模态模型） | 1–2 天 | 投 AI 岗可加分，但现有链路已够撑叙事，可缓 |
| 扫描件 OCR | 2–3 天 | **不建议做**：几十兆识别模型与「解压即用」定位冲突，README 已把这个取舍写成设计亮点 |
| Boss 直聘在线简历页适配（卡片式，需点开编辑器再填） | 1–2 天 | 实用价值高，投递时真会遇到 |

---

## 四、上下文搬家的三个地方

| 内容 | 位置 | CodeBuddy 能否读到 |
|---|---|---|
| 项目规则 | `D:\job-helper-extension\AGENTS.md` | ✅ 自动（仓库内） |
| 开发记忆（四层架构、关键决策、踩坑、测试数） | `D:\新建文件夹 (2)\2026-10-25-09-00-50\.workbuddy\memory\2026-11-07.md` | ⚠️ 在代码仓库外，需要手动指路（见下） |
| 简历话术（版本 F · AI 应用版） | `D:\新建文件夹 (2)\2026-10-25-09-00-50\项目经历-简填JobFill.md` | ⚠️ 同上 |

想让记忆也跟着走，把上面那个 `memory` 目录里的文件复制到仓库下（**注意别提交**，加入 `.gitignore`）：

```bat
mkdir D:\job-helper-extension\notes
copy "D:\新建文件夹 (2)\2026-10-25-09-00-50\.workbuddy\memory\*.md" D:\job-helper-extension\notes\
echo notes/ >> D:\job-helper-extension\.gitignore
```

然后 `AGENTS.md` 第 2 节末尾加一行「更细的开发历史见 `notes/`」。

---

## 五、CodeBuddy 里要先确认的三件事

1. **Node 路径**：`C:\Users\hcir0\.workbuddy\binaries\node\versions\22.22.2-3\node.exe` 能不能调用。如果 CodeBuddy 自带 Node，直接用它的也行，测试不挑版本（18+ 均可）。
2. **puppeteer-core 的 `NODE_PATH`**：指向 `C:\Users\hcir0\.workbuddy\binaries\node\workspace\node_modules`。这个目录属于 WorkBuddy，短期内不会消失，但如果你想彻底解耦，可以在 `D:\job-helper-extension` 下 `npm i -D puppeteer-core`（这会新建 `package.json`，**记得它只服务测试、不影响扩展运行**）。
3. **Edge 浏览器路径**：e2e 用的是 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，换机器要改。

---

## 六、一句话总结

**代码和文档都已经在仓库里了，CodeBuddy 打开 `D:\job-helper-extension` 读 `AGENTS.md` 就能无缝接手。** 真正要你动手的只有「push + 建 Release + 改 About」三件事，其余我可以继续做。
