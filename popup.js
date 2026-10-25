/**
 * popup.js —— 弹窗交互逻辑（阶段 1：骨架版）
 *
 * 当前职责：
 * 1. 显示版本号
 * 2. 自检 chrome.storage.local 是否可用
 * 3. 读取已保存的简历档案状态（阶段 2 开始写入真实数据）
 */

const DEFAULT_VERSION = "v0.1.0";

document.addEventListener("DOMContentLoaded", async () => {
  initVersion();
  await checkStorage();
});

/** 显示插件版本（与 manifest.json 保持一致） */
function initVersion() {
  const el = document.getElementById("version");
  if (!el) return;
  try {
    const { version } = chrome.runtime.getManifest();
    el.textContent = `v${version}`;
  } catch (e) {
    el.textContent = DEFAULT_VERSION;
  }
}

/**
 * 自检本地存储并展示简历档案状态。
 * 约定存储结构（阶段 2/3 实现）：
 *   chrome.storage.local = {
 *     resumes: { [id]: { id, name, data, updatedAt } },  // 简历版本库
 *     activeResumeId: string,                            // 当前激活的简历
 *     applications: [ { company, position, resumeId, sentAt } ] // 投递记录
 *   }
 */
async function checkStorage() {
  const storageEl = document.getElementById("storage-status");
  const resumeEl = document.getElementById("resume-status");

  try {
    const result = await chrome.storage.local.get(["resumes"]);
    const resumes = result.resumes || {};

    setStatus(storageEl, "正常", "ok");

    const count = Object.keys(resumes).length;
    if (count > 0) {
      setStatus(resumeEl, `已保存 ${count} 份`, "ok");
    } else {
      setStatus(resumeEl, "暂无简历", "warn");
    }
  } catch (e) {
    setStatus(storageEl, "异常", "warn");
    setStatus(resumeEl, "不可用", "warn");
    console.error("[求职简历助手] storage 自检失败：", e);
  }
}

function setStatus(el, text, level) {
  if (!el) return;
  el.textContent = text;
  el.className = `value ${level || ""}`.trim();
}
