# 求职简历助手（job-helper-extension）

一款纯本地的求职效率 Chrome 插件：中文简历一键填充、多简历版本管理、投递记录台账与 CSV 导出。所有数据保存在浏览器本地（`chrome.storage.local`），不依赖任何云端服务。

> 技术栈：Chrome Extension Manifest V3 · 原生 HTML/CSS/JS · chrome.storage.local

## 功能规划

| 功能 | 状态 |
| --- | --- |
| 插件基础骨架（Manifest V3 + Popup + Content Script） | ✅ 已完成 |
| 简历信息本地存储 + 招聘网页一键填充 | 🔨 开发中 |
| 多简历版本管理（通用版 / 岗位定制版切换） | 📋 计划中 |
| 投递记录台账（公司 / 岗位 / 时间 / 简历版本） | 📋 计划中 |
| 投递记录导出 CSV（Excel 可直接打开） | 📋 计划中 |

## 支持的招聘网站

Boss 直聘、猎聘、智联招聘、前程无忧、拉勾（后续按实际测试逐步扩充选择器适配）。

## 安装步骤（开发者模式）

1. 下载或克隆本仓库：
   ```bash
   git clone https://github.com/Hcir782/job-helper-extension.git
   ```
2. 打开 Chrome，地址栏输入 `chrome://extensions/`
3. 打开右上角【开发者模式】
4. 点击【加载已解压的扩展程序】，选中本项目文件夹
5. 工具栏出现插件图标即安装成功

## 使用教程

> 当前为骨架版本，完整使用教程将随功能开发同步更新。

- 点击插件图标打开弹窗，可以看到本地存储自检状态。

## 目录结构

```
job-helper-extension/
├─ manifest.json   # Manifest V3 核心配置（权限、popup、content script 注入规则）
├─ popup.html      # 点击插件图标弹出的面板
├─ popup.js        # 弹窗交互逻辑（存储自检、后续简历表单）
├─ popup.css       # 弹窗样式
├─ content.js      # 注入招聘网页：表单读取与自动填充
└─ .gitignore      # 忽略编辑器缓存、日志、系统垃圾文件
```

## 设计原则

- **本地优先**：简历与投递数据只存浏览器本地，不接入云端 API，隐私可控、无网络依赖。
- **小步迭代**：每个功能开发完成并实测通过后单独提交，遵循 `feat:` / `fix:` 提交规范。

## License

暂未定，随项目成熟度补充开源协议。
