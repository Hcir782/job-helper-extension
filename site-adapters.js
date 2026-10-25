/**
 * site-adapters.js —— 站点适配器注册表
 *
 * 不同招聘网站的 DOM 结构差异巨大：label 可能是 <label>、可能是兄弟 <span>，
 * 也可能藏在 Ant Design / Element UI 这类组件库的固定类名里。
 * 每个适配器声明"怎么找字段容器"和"怎么取字段文案"，找不到站点专属配置时，
 * 会退回到框架级适配（antd / element / arco），最后再退回到通用启发式规则。
 *
 * ⚠️ 版权说明：适配器结构参考了开源项目 OpenJobAutofill
 *    （MIT License, Copyright (c) 2026 Br1an67）的 SITE_ADAPTERS 设计，
 *    本项目按需裁剪并重写为更小的选择器集合。
 */

const JH_SITE_ADAPTERS = [
  {
    id: "zhipin",
    name: "BOSS直聘",
    hostPattern: /(?:^|\.)zhipin\.com$/i,
    confidence: 0.9,
    indicators: [".form-item", '[class*="form-item"]', '[class*="resume"]', '[class*="geek"]'],
    containerSelector: '.form-item,[class*="form-item"],[class*="field"],[class*="resume-item"],[class*="info-item"]',
    labelSelector: 'label,[class*="label"],[class*="title"],[class*="name"]',
  },
  {
    id: "liepin",
    name: "猎聘",
    hostPattern: /(?:^|\.)liepin\.com$/i,
    confidence: 0.88,
    indicators: [".form-item", '[class*="resume"]', '[class*="apply"]', '[class*="edit"]'],
    containerSelector: '.form-item,[class*="form-item"],[class*="formItem"],[class*="field"],[class*="apply"],[class*="resume-item"]',
    labelSelector: 'label,[class*="label"],[class*="Label"],[class*="title"],[class*="name"]',
  },
  {
    id: "zhaopin",
    name: "智联招聘",
    hostPattern: /(?:^|\.)zhaopin\.com$/i,
    confidence: 0.86,
    indicators: [".form-item", '[class*="resume"]', '[class*="form"]'],
    containerSelector: '.form-item,[class*="form-item"],[class*="resume-field"],[class*="field-row"],[class*="item"]',
    labelSelector: 'label,[class*="label"],[class*="title"]',
  },
  {
    id: "51job",
    name: "前程无忧",
    hostPattern: /(?:^|\.)51job\.com$/i,
    confidence: 0.85,
    indicators: [".form-item", '[class*="resume"]', '[class*="form"]'],
    containerSelector: '.form-item,[class*="form-item"],[class*="field"],[class*="item"]',
    labelSelector: 'label,[class*="label"],[class*="title"]',
  },
  {
    id: "lagou",
    name: "拉勾",
    hostPattern: /(?:^|\.)lagou\.com$/i,
    confidence: 0.84,
    indicators: [".form-item", '[class*="resume"]', '[class*="form"]'],
    containerSelector: '.form-item,[class*="form-item"],[class*="field"]',
    labelSelector: 'label,[class*="label"],[class*="title"]',
  },
  // ===== 框架级适配：企业自建招聘系统大量基于这些组件库 =====
  {
    id: "antd",
    name: "Ant Design 表单",
    hostPattern: null,
    confidence: 0.8,
    indicators: [".ant-form-item", ".ant-select", ".ant-radio-wrapper"],
    containerSelector: ".ant-form-item",
    labelSelector: ".ant-form-item-label,label",
  },
  {
    id: "element",
    name: "Element UI 表单",
    hostPattern: null,
    confidence: 0.78,
    indicators: [".el-form-item", ".el-select", ".el-radio"],
    containerSelector: ".el-form-item",
    labelSelector: ".el-form-item__label,label",
  },
  {
    id: "arco",
    name: "Arco Design 表单",
    hostPattern: null,
    confidence: 0.76,
    indicators: [".arco-form-item", ".arco-select-view"],
    containerSelector: ".arco-form-item",
    labelSelector: ".arco-form-item-label,label",
  },
];

/**
 * 选出当前页面适用的适配器：
 *  1. 域名精确匹配的站点适配器
 *  2. 页面上出现组件库特征类名的框架适配器
 *  3. 都没有则返回 null，走通用启发式
 */
function jhPickAdapter() {
  const host = location.hostname;

  const byHost = JH_SITE_ADAPTERS.find((a) => a.hostPattern && a.hostPattern.test(host));
  if (byHost) return byHost;

  for (const adapter of JH_SITE_ADAPTERS) {
    if (adapter.hostPattern) continue;
    const hit = (adapter.indicators || []).some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (e) {
        return false;
      }
    });
    if (hit) return adapter;
  }

  return null;
}

window.JH_SITE_ADAPTERS = JH_SITE_ADAPTERS;
window.jhPickAdapter = jhPickAdapter;
