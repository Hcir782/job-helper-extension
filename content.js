/**
 * content.js —— 注入招聘网站的脚本（阶段 1：骨架版）
 *
 * 职责规划：
 *  - 阶段 2：接收 popup 下发的简历数据，匹配页面表单并自动填充
 *  - 阶段 3：提供"记录投递"所需的页面上下文（公司名/岗位名）
 *
 * 当前职责：最小通信骨架——监听来自 popup 的消息并响应 PING，
 * 保证 popup ↔ content 通道可用，后续功能在此基础上迭代。
 */

(() => {
  console.log("[求职简历助手] content script 已注入:", location.hostname);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true, pong: true, url: location.href });
        break;

      // 阶段 2 预留：popup 发送简历数据后执行填充
      case "FILL_RESUME":
        // TODO(阶段2): msg.payload = 简历字段对象
        sendResponse({ ok: false, reason: "填充功能将在阶段 2 实现" });
        break;

      default:
        break;
    }

    return false; // 同步响应，无需异步保持通道
  });
})();
