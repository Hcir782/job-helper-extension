/**
 * demo.js —— 演示页脚本
 *
 * 复用 content.js 暴露的 fillResume()（同一个引擎，避免"演示能跑、真实页面不行"）
 * 数据来源与面板一致：chrome.storage.local 里当前激活的那份简历。
 */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-demo-fill")?.addEventListener("click", runFill);
  document.getElementById("btn-demo-clear")?.addEventListener("click", clearForm);
});

async function runFill() {
  const msg = document.getElementById("demo-msg");
  msg.className = "msg";

  try {
    const { resumes = {}, activeResumeId } = await chrome.storage.local.get([
      "resumes",
      "activeResumeId",
    ]);
    const resume = resumes[activeResumeId || "default"];

    if (!resume || !resume.data) {
      msg.className = "msg error";
      msg.textContent = "还没有保存过简历，请先打开插件面板填写并保存。";
      return;
    }

    // fillResume 现在是异步的（伪下拉要模拟点击、等浮层渲染），必须 await
    const result = await fillResume(resume.data);
    const filled = result.filled.length;
    const missed = result.missed.length;

    if (filled === 0) {
      msg.className = "msg error";
      msg.textContent = "一个字段都没填上，请检查简历内容是否有值。";
      return;
    }

    msg.className = "msg";
    msg.textContent = `已填充 ${filled} 个字段${missed ? `，${missed} 个未匹配（${result.missed.join("、")}）` : ""}。`;
  } catch (e) {
    console.error("[演示页] 填充失败：", e);
    msg.className = "msg error";
    msg.textContent = "填充出错：" + e.message;
  }
}

function clearForm() {
  document.querySelectorAll("#d-name, #d-phone, #d-email, #d-year, #d-school, #d-major, #d-pos, #d-city, #d-intro, #d-project, #d-edu").forEach((el) => {
    el.value = "";
  });
  document.querySelectorAll('input[name="gender"]').forEach((el) => {
    el.checked = false;
  });

  const msg = document.getElementById("demo-msg");
  msg.className = "msg";
  msg.textContent = "表单已清空。";
}
