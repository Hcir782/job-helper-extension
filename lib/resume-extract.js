/**
 * lib/resume-extract.js —— 抽取编排：拼 prompt → 调模型 → 校验 → 定向修补
 *
 * 这一层只负责「流程」，具体的请求发送交给 llm-client，字段校验交给 resume-schema，
 * 三层的边界清晰，才能各自被单测钉住。
 *
 * 流程（也是简历里要写的那段）：
 *   1. 按 JSON Schema 约束输出（json_schema → json_object → prompt_only 三级降级）
 *   2. 确定性校验：字段白名单、枚举收敛、日期/手机/邮箱规范化、超长截断
 *   3. 只对「格式不合格」的字段发起定向修补（最多 2 轮），不让模型重写整份——
 *      重写既贵又容易把上一轮对的字段改坏
 *   4. 全程记账：每轮用的档位、耗时、token、重试次数，最终一起回给 UI
 *
 * 有一类特殊的失败：简历里写的是「2026.10 - 至今」，模型把它算成了「1 年工作经验」。
 * 抽取阶段绝不替人做这种推算，prompt 里明确禁止编造，校验阶段也拦不住——
 * 所以只能靠 prompt 约束 + UI 上「逐字段对比预览」让人自己看。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_EXTRACT = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const S = typeof JH_SCHEMA !== "undefined" ? JH_SCHEMA : require("./resume-schema.js");

  /** 修补轮次上限：两轮之后还修不好，基本是简历本身没写这个信息，继续问也只会得到编造 */
  const MAX_REPAIR_ROUNDS = 2;

  /** 中文简历一次送进 prompt 的字数上限，超了要分块 */
  const CHUNK_CHARS = 12000;

  /**
   * system prompt。
   * 写法上的几个决定：
   *   - 把「禁止编造」写成硬约束而不是建议，因为抽取任务最大的风险是幻觉补齐
   *   - 明确「字段名只能用给定的英文 key」，避免模型翻译成中文键名
   *   - 枚举值逐个列出来，并说明「简历里没有就填空串」——否则模型倾向猜一个最像的
   *   - 长文本字段要求保留原格式（换行、项目符号），因为它是直接灌进网申大框的
   */
  function buildSystemPrompt() {
    const enumLines = Object.keys(S.ENUMS)
      .map((f) => `  - ${f}：只能是 ${S.ENUMS[f].join(" / ")}，或空字符串`)
      .join("\n");

    return [
      "你是一个简历信息抽取器。用户会给你一份中文简历的文本（可能来自 PDF 抽取，行序和空格可能不规整）。",
      "你的任务：把简历里的信息映射到下面 44 个固定字段，输出一个 JSON 对象。",
      "",
      "【硬性要求】",
      "1. 只输出 JSON，不要任何解释、不要 markdown 代码围栏。",
      `2. 必须包含全部 44 个字段，字段名只能用下面给出的英文 key，不要新增、不要改名。`,
      "3. 简历里没有提到的字段，值必须是空字符串 \"\"。绝对不要猜测、推断、编造。",
      "4. 不要因为某个字段常见就填一个典型值；宁可留空。",
      "5. 不要做任何计算或推算（例如根据入学年份算年龄、根据经历区间算工作年限）。",
      "",
      "【字段清单】",
      "基本信息：name 姓名、gender 性别、birth 出生日期、phone 手机号、email 邮箱、",
      "idType 证件类型、idCard 证件号码、nationality 国籍、nation 民族、politics 政治面貌、",
      "address 现居住地、emergencyContact 紧急联系人、emergencyPhone 紧急联系人电话",
      "教育背景：education 最高学历、graduationYear 毕业时间、school 毕业院校、college 学院、",
      "major 专业、studyMode 学习形式、gpaRank 成绩排名或绩点、isOverseas 是否境外留学、",
      "eduDetail 教育经历明细、highSchool 高中经历",
      "求职意向：expectPosition 期望职位、expectCity 期望城市、expectSalary 期望薪资、",
      "workYears 工作年限、acceptRelocate 是否接受调剂、availableIntern 是否可实习、",
      "sourceChannel 了解渠道、referrerCode 推荐码",
      "经历与能力：internshipExp 实习经历、projectExp 项目经历、campusExp 在校职务、",
      "awards 获奖经历、certificates 证书、languageLevel 语言能力、portfolio 作品、",
      "skills 技能、papers 论文",
      "工作与补充：currentCompany 当前公司、currentPosition 当前职位、selfIntro 自我评价、hobbies 兴趣爱好",
      "",
      "【枚举字段】",
      enumLines,
      "",
      "【格式约定】",
      "- graduationYear 统一写成 YYYY-MM，例如 2027-06；只知道年份就写 2027。",
      "- phone 只保留数字，可带开头的 +；email 全部小写。",
      "- projectExp / internshipExp / eduDetail 这类长文本字段：保留简历原有的分段与项目符号，",
      "  多条经历之间用换行分隔，不要压成一段，也不要总结缩写——要能被直接贴进网申的大文本框。",
      "- 简历里同时有中英文姓名时，name 取中文名。",
      "",
      "【示例】（仅示范格式，实际按用户简历抽取）",
      '示例输入：「王瑞瑶 / 女 / 大连科技学院 网络工程 本科 2023.09-2027.06 / 电话 152-4852-2685」',
      '示例输出：{"name":"王瑞瑶","gender":"女","birth":"","phone":"15248522685","email":"",',
      '"idType":"","idCard":"","nationality":"","nation":"","politics":"","address":"",',
      '"emergencyContact":"","emergencyPhone":"","education":"本科","graduationYear":"2027-06",',
      '"school":"大连科技学院","college":"","major":"网络工程","studyMode":"","gpaRank":"",',
      '"isOverseas":"","eduDetail":"2023.09-2027.06 大连科技学院 网络工程 本科","highSchool":"",',
      '"expectPosition":"","expectCity":"","expectSalary":"","workYears":"","acceptRelocate":"",',
      '"availableIntern":"","sourceChannel":"","referrerCode":"","internshipExp":"","projectExp":"",',
      '"campusExp":"","awards":"","certificates":"","languageLevel":"","portfolio":"","skills":"",',
      '"papers":"","currentCompany":"","currentPosition":"","selfIntro":"","hobbies":""}',
      // 末尾补一个空行：示例是数组最后一项，join 之后没有换行符，
      // 而 tests/resume-extract.test.js 用 /\{[\s\S]*?\}\n/ 抓示例来验证它本身合法。
      "",
    ].join("\n");
  }

  /** 把简历文本拼成 user 消息；分块时说明这是第几段 */
  function buildUserPrompt(text, chunkInfo) {
    const head = chunkInfo && chunkInfo.total > 1
      ? `这是同一份简历的第 ${chunkInfo.index}/${chunkInfo.total} 段，只需要抽这一段里出现的信息，其余字段填空字符串。\n\n`
      : "";
    return `${head}简历文本如下：\n<<<\n${text}\n>>>`;
  }

  /**
   * 从多个分块的结果做字段级合并。
   * 规则：第一个非空值优先（前面的段落通常是基本信息，更权威）；
   * 长文本字段如果后面段落还有内容，按换行追加而不是覆盖。
   */
  function mergeChunks(parts) {
    const out = S.emptyData();
    const LONG = S.LONG_FIELDS;
    parts.forEach((p) => {
      S.FIELDS.forEach((f) => {
        const v = p[f];
        if (!v) return;
        if (!out[f]) {
          out[f] = v;
        } else if (LONG.includes(f) && !out[f].includes(v)) {
          out[f] = `${out[f]}\n${v}`;
        }
      });
    });
    return out;
  }

  /**
   * 单段抽取：调用 + 校验。
   * 失败（网络/鉴权/格式烂）时先修一次再抛出——
   * 重试由 llm-client 在传输层做，这里处理的是「传回来了但内容没法用」。
   */
  async function extractOne(ctx, messages) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const call = await ctx.llm.callAuto(ctx.cfg, messages, ctx.deps);
      const usage = call.usage || {};
      ctx.meter.promptTokens += usage.prompt || 0;
      ctx.meter.completionTokens += usage.completion || 0;
      ctx.meter.ms += call.ms || 0;
      ctx.meter.calls += 1;
      ctx.meter.backoffMs += call.backoffMs || 0;
      ctx.meter.modes.push({ mode: call.mode, degraded: !!call.degraded, ms: call.ms });

      const parsed = S.stripFence(call.content);
      const v = S.validate(parsed, { minFillRatio: ctx.minFillRatio });
      if (v.ok) return v;

      lastError = new Error(
        (v.issues.find((i) => i.kind === "not_object" || i.kind === "too_few_fields") || {}).detail ||
          "模型输出无法解析成 44 字段"
      );
      // 第二次把失败原因告诉模型，让它自己纠偏
      if (attempt === 1) {
        messages = messages.concat(
          { role: "assistant", content: String(call.content).slice(0, 2000) },
          {
            role: "user",
            content: `上面的输出不合格：${lastError.message}。请重新输出，只输出 JSON 对象，必须包含全部 44 个字段。`,
          }
        );
      }
    }
    const err = new Error(`抽取失败：${lastError ? lastError.message : "未知原因"}`);
    err.stage = "parse";
    throw err;
  }

  /**
   * 主入口：从简历文本抽出 44 字段。
   *
   * @param {string} text 简历纯文本
   * @param {object} options
   * @param {object} options.llm        lib/llm-client 的导出对象
   * @param {object} options.cfg        { baseURL, apiKey, model, maxAttempts, timeoutMs }
   * @param {object} [options.deps]     { fetch, sleep } 测试注入
   * @param {(stage:string, detail:object)=>void} [options.onProgress]
   * @param {number} [options.maxRepairRounds=2]
   * @param {number} [options.chunkChars=12000]
   * @returns {Promise<object>} 抽取结果汇总
   */
  async function extract(text, options) {
    const opts = options || {};
    const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    const maxRepair = typeof opts.maxRepairRounds === "number" ? opts.maxRepairRounds : MAX_REPAIR_ROUNDS;
    const chunkChars = opts.chunkChars || CHUNK_CHARS;

    const clean = S.normalizeText(text);
    if (!clean) {
      throw new Error("没有可抽取的文本：简历里读不到字（可能是扫描件），请改用图片或手动填写。");
    }

    const ctx = {
      llm: opts.llm,
      cfg: Object.assign({ schema: S.buildJsonSchema() }, opts.cfg || {}),
      deps: opts.deps || {},
      minFillRatio: opts.minFillRatio,
      meter: { promptTokens: 0, completionTokens: 0, ms: 0, calls: 0, backoffMs: 0, modes: [] },
    };
    if (!ctx.llm) throw new Error("缺少大模型客户端。");

    const system = buildSystemPrompt();
    const chunks = splitByChars(clean, chunkChars);
    const rounds = [];

    // ---------- 第一轮：分段抽取 ----------
    progress("extract", { total: chunks.length });
    const firstParts = [];
    const allIssues = [];
    for (let i = 0; i < chunks.length; i++) {
      const messages = [
        { role: "system", content: system },
        { role: "user", content: buildUserPrompt(chunks[i], { index: i + 1, total: chunks.length }) },
      ];
      const v = await extractOne(ctx, messages);
      firstParts.push(v.data);
      allIssues.push(...v.issues);
      rounds.push({ label: `主抽取 ${i + 1}/${chunks.length}`, filled: v.filled });
      progress("extract-done", { index: i + 1, total: chunks.length, filled: v.filled });
    }

    let data = chunks.length > 1 ? mergeChunks(firstParts) : firstParts[0];
    let issues = allIssues;
    let repairRounds = 0;

    // ---------- 第二轮起：定向修补 ----------
    let fps = badFields(data);
    while (fps.length && repairRounds < maxRepair) {
      repairRounds++;
      const problems = fps.map((f) => ({ field: f, kind: "bad_format", value: data[f] }));
      progress("repair", { round: repairRounds, fields: fps });

      const messages = [
        { role: "system", content: system },
        { role: "user", content: buildUserPrompt(clean, null) },
        { role: "assistant", content: JSON.stringify(data) },
        { role: "user", content: S.buildRepairPrompt(problems) },
      ];

      try {
        const v = await extractOne(ctx, messages);
        // 只接受修补回来的「原本不合格」的字段，其余保持原样——
        // 防止模型顺手把已经抽对的部分改坏
        const applied = [];
        fps.forEach((f) => {
          if (v.data[f] && v.data[f] !== data[f]) {
            data[f] = v.data[f];
            applied.push(f);
          }
        });
        issues = issues.concat(v.issues);
        rounds.push({ label: `修补第 ${repairRounds} 轮`, applied, filled: v.filled });
        const next = badFields(data);
        // 模型这一轮没给出任何新内容 → 再问也只是重复，提前收手
        if (!applied.length) {
          fps = next;
          break;
        }
        fps = next;
      } catch (e) {
        // 修补失败不该让整次抽取白跑，保留第一轮的结果
        rounds.push({ label: `修补第 ${repairRounds} 轮`, error: e.message });
        break;
      }
    }

    const final = S.validate(data, { minFillRatio: opts.minFillRatio });
    progress("done", { filled: final.filled });

    return {
      ok: true,
      data: final.data,
      filled: final.filled,
      total: final.total,
      missing: final.missing,
      issues: final.issues,
      unrepaired: fps,
      rounds,
      repairRounds,
      chunks: chunks.length,
      meter: ctx.meter,
      // 有字段最终仍不合格，UI 要提示「这机项建议人工核对」
      needsReview: fps.length > 0,
    };
  }

  /** 找出「有值但格式不合格」的字段 */
  function badFields(data) {
    return S.FIELDS.filter((f) => {
      const v = data[f];
      if (!v) return false;
      if (f === "email") return !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
      if (f === "phone") return !/^\+?\d{7,15}$/.test(v);
      return false;
    });
  }

  /** 按字符数切段，尽量在换行处断开（与 pdf-text.chunkText 同一策略，但独立实现避免耦合） */
  function splitByChars(text, limit) {
    const s = String(text || "");
    if (s.length <= limit) return [s];
    const out = [];
    let rest = s;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf("\n", limit);
      if (cut < limit * 0.6) cut = limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  return {
    MAX_REPAIR_ROUNDS,
    CHUNK_CHARS,
    buildSystemPrompt,
    buildUserPrompt,
    mergeChunks,
    splitByChars,
    extract,
  };
});
