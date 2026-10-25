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

/* ============ 招聘站点域名表 + 页面信息探测（阶段 3：投递记录） ============ */

/** 已内置适配器的招聘站点主域名（含子域名） */
const JH_JOB_DOMAINS = [
  "zhipin.com",
  "liepin.com",
  "zhaopin.com",
  "51job.com",
  "lagou.com",
];

/** host 是否属于已知招聘站点（投递记录只在这些站点自动登记，避免全网页记录） */
function jhIsJobSite(host) {
  if (!host) return false;
  return JH_JOB_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

/**
 * 公司名特征，分两级：
 *  - 强：以 有限公司/公司/集团 等结尾（真实公司名几乎都有）
 *  - 弱：以 科技/网络 等词结尾（"某某科技"这类简称）
 * 必须强优先，否则"某某科技有限公司"会被"科技"截成"某某科技"。
 */
const JH_COMPANY_RE_STRONG =
  /^(.{2,20}?(?:集团有限公司|有限公司|股份有限公司|公司|集团|研究院|事业部|工作室))/;
const JH_COMPANY_RE_WEAK = /^(.{2,20}?(?:科技|网络|信息技术))/;

/** 从段首提取公司名（强优先，弱兜底），不命中返回 null */
function jhMatchCompany(part) {
  return part.match(JH_COMPANY_RE_STRONG) || part.match(JH_COMPANY_RE_WEAK);
}

/**
 * 岗位名特征：前缀用贪婪匹配，保证"运维工程师"不会被"运维"截短
 * （"运维"作为核心词在"工程师"之前出现，惰性前缀会提前命中）。
 */
const JH_POSITION_RE =
  /([A-Za-z\u4e00-\u9fa5]{0,6}(?:工程师|开发|运维|测试|设计|产品|运营|经理|主管|专员|顾问|实习|分析师|架构师))/;
/** 站点自身名称，切分后要丢掉的噪音 */
const JH_SITE_NAME_RE =
  /^(boss直聘|直聘|猎聘|智联招聘|智联|前程无忧|51job|拉勾招聘|拉勾|招聘网|找工作|jobs?)$/i;

/** 清理提取到的岗位名：去符号、去"招聘"类前后缀 */
function jhCleanPosition(text) {
  return String(text || "")
    .replace(/^[\s【\[(（<〔]+/, "")
    .replace(/[\s】\]）)>〕]+$/, "")
    .replace(/^(招聘|急招|高薪|直招|社招|校招)+/, "")
    .replace(/(招聘|急招|直招)$/, "")
    .trim();
}

/**
 * 把页面 title / og:title 切成候选片段。
 * 招聘站点 title 基本是「公司_岗位_站点」或「岗位_公司_站点」的拼接。
 */
function jhSplitTitle(title) {
  return String(title || "")
    .split(/[_|｜\-—·、,，/\\\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 从当前页面探测「公司 + 岗位」，用于投递记录自动登记。
 * 策略：
 *   1. 优先 og:title / document.title
 *   2. 按分隔符切段，过滤站点名噪音（BOSS直聘/猎聘/智联/51job/拉勾…）
 *   3. 段首命中公司特征词的当公司；公司词之后/其余段里命中岗位关键词的当岗位
 *      （兼容"某某科技公司招聘运维工程师"这种公司岗位写在同一段的情况）
 *   4. 公司还可以用 og:site_name 兜底
 *   5. 都识别不出就返回空串，记录时显示"未知公司/未知岗位"，URL 仍在台账里
 * 返回 { company, position }
 */
function jhDetectJobPage(doc) {
  doc = doc || document;
  let company = "";
  let position = "";

  const ogTitle = doc.querySelector
    ? doc.querySelector('meta[property="og:title"]')
    : null;
  const raw =
    (ogTitle && ogTitle.getAttribute("content")) ||
    doc.title ||
    "";
  const parts = jhSplitTitle(raw);

  for (const part of parts) {
    if (JH_SITE_NAME_RE.test(part.toLowerCase())) continue;
    if (/招聘$/.test(part) && part.length <= 6) continue;

    const companyMatch = jhMatchCompany(part);
    const rest = companyMatch ? part.slice(companyMatch[0].length) : part;

    if (!company && companyMatch) {
      company = companyMatch[1].trim();
      // 公司名后面可能紧跟岗位（"某某科技公司招聘运维工程师"）
      if (!position) {
        const posMatch = rest.match(JH_POSITION_RE);
        if (posMatch) position = jhCleanPosition(posMatch[1]);
      }
      continue;
    }

    if (!position) {
      const posMatch = rest.match(JH_POSITION_RE);
      if (posMatch) position = jhCleanPosition(posMatch[1]);
    }
  }

  // 有些站点把公司名放 og:site_name
  if (!company && doc.querySelector) {
    const siteName = doc.querySelector('meta[property="og:site_name"]');
    const v = siteName && siteName.getAttribute("content");
    if (v) {
      const m = jhMatchCompany(v);
      if (m) company = m[1].trim();
    }
  }

  return { company, position };
}

window.JH_JOB_DOMAINS = JH_JOB_DOMAINS;
window.jhIsJobSite = jhIsJobSite;
window.jhDetectJobPage = jhDetectJobPage;
