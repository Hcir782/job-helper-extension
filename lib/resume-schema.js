/**
 * lib/resume-schema.js —— 44 字段的抽取契约（JSON Schema）与结果校验
 *
 * 这是「简历 PDF → 结构化 JSON」模块的地基，只做纯逻辑，不碰 DOM、不碰网络，
 * 所以 Node 单测能直接 require 覆盖。
 *
 * 三层职责：
 *   1. 定义 schema   —— 告诉大模型它能输出哪些字段、什么类型、哪些只能是枚举值
 *   2. 校验与修补    —— 模型输出难免越界（编字段、编枚举、把日期写成"2027年6月"），
 *                       这里做确定性清洗，能救的就救，救不了的记为缺陷
 *   3. 生成反馈      —— 把缺陷整理成第二轮 prompt 的文字，做定向修补
 *
 * 字段集合的唯一真源是 field-dictionary.js 的 JH_FIELD_GROUPS，
 * 本文件不重复维护 44 个字段名，避免三处各写一遍、改一处漏两处。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_SCHEMA = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** 44 字段（顺序与面板一致）。浏览器里取词典，Node 里取不到就按同一顺序兜底 */
  const FIELDS =
    typeof JH_FIELD_GROUPS !== "undefined" && JH_FIELD_GROUPS.length
      ? JH_FIELD_GROUPS.flatMap((g) => g.fields)
      : [
          "name", "gender", "birth", "phone", "email",
          "idType", "idCard", "nationality", "nation", "politics",
          "address", "emergencyContact", "emergencyPhone",
          "education", "graduationYear", "school", "college", "major",
          "studyMode", "gpaRank", "isOverseas", "eduDetail", "highSchool",
          "expectPosition", "expectCity", "expectSalary", "workYears",
          "acceptRelocate", "availableIntern", "sourceChannel", "referrerCode",
          "internshipExp", "projectExp", "campusExp", "awards",
          "certificates", "languageLevel", "portfolio", "skills", "papers",
          "currentCompany", "currentPosition", "selfIntro", "hobbies",
        ];

  /**
   * 单选 / 枚举字段。
   * 网申表单里这些是下拉框，写错一个字就选不中，所以抽取阶段就要收敛到标准值。
   * 值域来自 field-dictionary.js 里对应字段的别名表的「标准写法」，
   * 以及 popup.html 下拉框实际提供的选项。
   */
  const ENUMS = {
    gender: ["男", "女"],
    education: ["大专", "本科", "硕士", "博士"],
    studyMode: ["全日制", "非全日制"],
    isOverseas: ["是", "否"],
    acceptRelocate: ["是", "否"],
    availableIntern: ["是", "否"],
  };

  /** 字段长度上限（字符）。超长的多半是模型把整段经历塞进单行字段，要截断并记录 */
  const MAX_LEN = {
    name: 40,
    phone: 30,
    email: 80,
    idCard: 40,
    gender: 4,
    birth: 20,
    education: 10,
    studyMode: 10,
    isOverseas: 4,
    acceptRelocate: 4,
    availableIntern: 4,
    graduationYear: 20,
    school: 60,
    college: 60,
    major: 60,
    expectPosition: 60,
    expectCity: 60,
    expectSalary: 40,
    workYears: 20,
    languageLevel: 40,
    currentCompany: 80,
    currentPosition: 60,
    nationality: 20,
    nation: 20,
    politics: 20,
    hobbies: 200,
  };

  /** 长文本字段：允许多行，长度上限放宽 */
  const LONG_FIELDS = [
    "address", "emergencyContact", "emergencyPhone", "gpaRank",
    "eduDetail", "highSchool", "sourceChannel", "referrerCode",
    "internshipExp", "projectExp", "campusExp", "awards",
    "certificates", "portfolio", "skills", "papers", "selfIntro",
  ];

  /** 枚举字段的常见写法 → 标准值。匹配时先归一化再查表 */
  const ENUM_ALIASES = {
    gender: { 男性: "男", 女士: "女", male: "男", female: "女", m: "男", f: "女" },
    education: {
      大学本科: "本科", 学士: "本科", bachelor: "本科",
      研究生: "硕士", 硕士研究生: "硕士", master: "硕士",
      博士研究生: "博士", phd: "博士",
      专科: "大专", 高职: "大专",
    },
    studyMode: { 统招: "全日制", 全日制本科: "全日制", "full-time": "全日制", 非全: "非全日制" },
    isOverseas: { 有: "是", true: "是", yes: "是", 无: "否", false: "否", no: "否" },
    acceptRelocate: { 有: "是", 可以: "是", 接受: "是", true: "是", 不接受: "否", false: "否" },
    availableIntern: { 有: "是", 可以: "是", true: "是", 不可以: "否", false: "否" },
  };

  /* ========== Schema 生成 ========== */

  /**
   * 生成 JSON Schema。
   * 刻意用「所有 44 个字段都 required + 没有信息就填空字符串」的写法：
   *   - 如果允许字段缺失，模型会自作主张省略，我们就分不清「简历里没有」和「模型漏了」
   *   - 全 required + 空串约定后，缺字段本身就是可检测的异常
   */
  function buildJsonSchema() {
    const properties = {};
    FIELDS.forEach((f) => {
      const prop = { type: "string" };
      if (ENUMS[f]) {
        prop.enum = ENUMS[f].concat("");
        prop.description = `只能取 ${ENUMS[f].join(" / ")}，简历中没有就填空字符串`;
      } else if (MAX_LEN[f]) {
        prop.maxLength = MAX_LEN[f];
      }
      properties[f] = prop;
    });

    return {
      type: "object",
      additionalProperties: false,
      required: FIELDS.slice(),
      properties,
    };
  }

  /* ========== 归一化工具 ========== */

  /** 去掉不可见字符、统一全角空格，收掉首尾空白（保留换行，长文本要用） */
  function normalizeText(v) {
    return String(v == null ? "" : v)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u00a0\u3000]/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** 枚举匹配用的键：去空白、去括号、小写 */
  function enumKey(v) {
    return String(v == null ? "" : v)
      .replace(/[\s\u00a0\u3000]+/g, "")
      .replace(/[（(][^（()）]*[)）]/g, "")
      .toLowerCase();
  }

  /**
   * 把模型给的枚举值收敛到标准值。
   * 返回 { value, changed }：changed=true 表示做了改写，需要记进诊断里。
   */
  function coerceEnum(field, raw) {
    const allowed = ENUMS[field];
    if (!allowed) return { value: raw, changed: false };

    const text = normalizeText(raw);
    if (!text) return { value: "", changed: false };
    if (allowed.includes(text)) return { value: text, changed: false };

    const key = enumKey(text);
    // 先查别名词典
    const alias = ENUM_ALIASES[field] || {};
    for (const [k, v] of Object.entries(alias)) {
      if (enumKey(k) === key) return { value: v, changed: true };
    }
    // 再退一步：标准值被包含（"本科（全日制）" → 本科）
    for (const v of allowed) {
      if (key === enumKey(v)) return { value: v, changed: true };
    }
    // 兜底用中文包含判断，处理 "全日制本科在读" 这类。
    // 命中多个就取最长的那个（"非全日制" 同时包含 "全日制"，取长才能选对）
    const hits = allowed.filter((v) => key.includes(enumKey(v)));
    if (hits.length === 1) return { value: hits[0], changed: true };
    if (hits.length > 1) {
      const longest = hits.reduce((a, b) => (b.length > a.length ? b : a));
      const unique = hits.filter((h) => h.length === longest.length);
      if (unique.length === 1) return { value: longest, changed: true };
    }
    return { value: "", changed: false, invalid: true };
  }

  /**
   * 规范毕业时间。网申表单的日期控件认 "2027-06" 这类短格式，
   * 自由文本的 "2027年6月" / "2027.6" / "2027/06/30" 统一压成 YYYY-MM。
   * 认不出来的（"应届"、"2027"）保留原文，交给后面的表单引擎自己处理。
   */
  function normalizeGraduation(raw) {
    const text = normalizeText(raw);
    if (!text) return { value: "", changed: false };

    const m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/);
    if (!m) return { value: text, changed: false };

    const year = m[1];
    const month = Number(m[2]);
    if (month < 1 || month > 12) return { value: text, changed: false };
    const out = `${year}-${String(month).padStart(2, "0")}`;
    return { value: out, changed: out !== text };
  }

  /** 手机号：保留数字与开头的 +，去掉空格/横线/括号 */
  function normalizePhone(raw) {
    const text = normalizeText(raw);
    if (!text) return { value: "", changed: false };
    const cleaned = text.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
    return { value: cleaned, changed: cleaned !== text };
  }

  /** 邮箱：去空白、小写域名。格式明显不对的返回 invalid，让上层要求模型重抽 */
  function normalizeEmail(raw) {
    const text = normalizeText(raw).replace(/\s+/g, "");
    if (!text) return { value: "", changed: false };
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text);
    if (!ok) return { value: text, changed: false, invalid: true };
    // 域名不区分大小写必须转小写；本地部分按 RFC 5321 也允许全小写化，
    // 统一转小写便于与已有的简历数据做等值比对
    const value = text.toLowerCase();
    return { value, changed: value !== raw };
  }

  /**
   * 计算需要针对某个字段发起第二轮修补的原因。
   * 空字符串不算缺陷——简历里没写就是没写，不能逼模型编。
   */
  function fieldProblem(field, value) {
    if (!value) return null;
    if (MAX_LEN[field] && value.length > MAX_LEN[field]) return "too_long";
    if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return "bad_format";
    if (field === "phone" && !/^\+?\d{7,15}$/.test(value)) return "bad_format";
    return null;
  }

  /* ========== 主校验入口 ========== */

  /**
   * 校验并修补模型输出。
   *
   * @param {object} raw  模型返回的对象（可能带 markdown 围栏、多字段、字段名大小写不对）
   * @param {object} [opts]
   * @param {number} [opts.minFillRatio=0.15] 有效字段低于该比例视为抽取失败
   * @returns {{
   *   ok: boolean, data: object, filled: number, total: number,
   *   issues: Array<{field: string, kind: string, detail: string}>,
   *   fps: string[]
   * }}
   */
  function validate(raw, opts) {
    const options = opts || {};
    const minFillRatio = typeof options.minFillRatio === "number" ? options.minFillRatio : 0.15;

    const issues = [];
    const data = {};
    let source = raw;

    // 模型偶尔会把结果包一层：{ "resume": {...} } 或直接返回被围栏包住的字符串
    if (typeof source === "string") source = stripFence(source);
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const keys = Object.keys(source);
      const hit = keys.filter((k) => FIELDS.includes(k)).length;
      const nested = keys.find(
        (k) => source[k] && typeof source[k] === "object" && !Array.isArray(source[k])
      );
      if (hit === 0 && nested) {
        issues.push({ field: "*", kind: "nested", detail: `结果被包在 ${nested} 里，已拆开` });
        source = source[nested];
      }
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return { ok: false, data: emptyData(), filled: 0, total: FIELDS.length, issues: [
        { field: "*", kind: "not_object", detail: "模型没有返回 JSON 对象" },
      ], fps: [] };
    }

    // 越界字段：模型自己发明的字段名，一律丢弃但要记账
    Object.keys(source).forEach((k) => {
      if (!FIELDS.includes(k)) {
        issues.push({ field: k, kind: "unknown_field", detail: "不在 44 字段清单内，已丢弃" });
      }
    });

    const fps = [];
    FIELDS.forEach((f) => {
      const rawVal = source[f];
      if (rawVal != null && typeof rawVal !== "string") {
        issues.push({ field: f, kind: "not_string", detail: `期望字符串，实际 ${typeof rawVal}，已转成文本` });
      }
      let value = normalizeText(rawVal);

      if (ENUMS[f]) {
        const r = coerceEnum(f, value);
        if (r.changed) issues.push({ field: f, kind: "enum_coerced", detail: `"${value}" → "${r.value}"` });
        if (r.invalid) issues.push({ field: f, kind: "enum_invalid", detail: `"${value}" 不在允许值内，已清空` });
        value = r.value;
      } else if (f === "graduationYear") {
        const r = normalizeGraduation(value);
        if (r.changed) issues.push({ field: f, kind: "date_normalized", detail: `"${value}" → "${r.value}"` });
        value = r.value;
      } else if (f === "phone") {
        const r = normalizePhone(value);
        if (r.changed) issues.push({ field: f, kind: "phone_normalized", detail: `"${value}" → "${r.value}"` });
        value = r.value;
      } else if (f === "email") {
        const r = normalizeEmail(value);
        if (r.changed) issues.push({ field: f, kind: "email_normalized", detail: `"${value}" → "${r.value}"` });
        if (r.invalid) fps.push(f);
        value = r.value;
      }

      if (MAX_LEN[f] && value.length > MAX_LEN[f]) {
        issues.push({
          field: f,
          kind: "too_long",
          detail: `${value.length} 字超过上限 ${MAX_LEN[f]}，已截断`,
        });
        value = value.slice(0, MAX_LEN[f]).trim();
      }

      const problem = fieldProblem(f, value);
      if (problem && !fps.includes(f)) fps.push(f);

      data[f] = value;
    });

    const filled = FIELDS.filter((f) => data[f]).length;
    const missing = FIELDS.filter((f) => !data[f]);
    const ratio = filled / FIELDS.length;
    const ok = ratio >= minFillRatio;

    if (!ok) {
      issues.push({
        field: "*",
        kind: "too_few_fields",
        detail: `只抽到 ${filled}/${FIELDS.length} 个字段（低于 ${Math.round(minFillRatio * 100)}%），疑似没读懂简历`,
      });
    }

    return { ok, data, filled, total: FIELDS.length, issues, fps, missing };
  }

  /** 去掉 ```json ... ``` 围栏，并截取第一个 { 到最后一个 } */
  function stripFence(text) {
    let s = String(text || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function emptyData() {
    const d = {};
    FIELDS.forEach((f) => (d[f] = ""));
    return d;
  }

  /**
   * 为第二轮修补生成提示词片段。
   * 只列有问题的字段 + 它们允许的值，不让模型重写整份简历——
   * 重写容易把原本抽对的字段改坏，也会成倍放大 token 与耗时。
   */
  function buildRepairPrompt(problems) {
    if (!problems || !problems.length) return "";
    const lines = problems.map((p) => {
      const allowed = ENUMS[p.field] ? `（只能是 ${ENUMS[p.field].join(" / ")}）` : "";
      const why = {
        enum_invalid: "上一轮给的值不在允许范围内",
        bad_format: "格式不合法",
        too_long: "内容过长",
        not_string: "类型不对",
      }[p.kind] || p.kind;
      return `- ${p.field}：${why}，上一轮给的是 ${JSON.stringify(p.value || "")}${allowed}`;
    });
    return [
      "上一轮抽取结果有以下几个字段不合格：",
      ...lines,
      "请只重新抽取这几个字段，仍然严格按同一份 JSON Schema 输出完整对象；",
      "其余字段按你上一轮的判断原样保留；简历里确实没有的填空字符串。",
    ].join("\n");
  }

  return {
    FIELDS,
    ENUMS,
    MAX_LEN,
    LONG_FIELDS,
    buildJsonSchema,
    validate,
    coerceEnum,
    normalizeGraduation,
    normalizePhone,
    normalizeEmail,
    normalizeText,
    buildRepairPrompt,
    stripFence,
    emptyData,
  };
});
