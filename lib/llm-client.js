/**
 * lib/llm-client.js —— 大模型调用层（OpenAI 兼容协议）
 *
 * 只做三件事：拼请求、发请求、把各种失败翻译成人能看懂的话。
 * 不碰 DOM、不含业务判断（字段怎么校验在 resume-schema.js），
 * 所以既能在 Node 单测里对着一个假服务跑，也能在扩展的 service worker 里跑。
 *
 * 为什么走 OpenAI 兼容协议：DeepSeek / 通义 / 智谱 / Moonshot / 本地 Ollama
 * 都提供 /v1/chat/completions，换一家只要改 baseURL + model + key，
 * 不用为每家写适配器。用户在设置里填哪个地址，就打到哪个地址。
 *
 * 结构化输出采用三级降级（能力探测 + 缓存）：
 *   1. response_format: { type: "json_schema", json_schema: {...} }  ← 服务端强约束，最可靠
 *   2. response_format: { type: "json_object" }                      ← 只保证是 JSON
 *   3. 什么都不传，靠 prompt 里的字段清单约束                      ← 老服务 / 本地小模型
 * 探测结果按 baseURL+model 记在本地，下次直接用能成功的那一档，避免每次都多花一次失败请求。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.JH_LLM = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** 三种结构化输出档位，从强到弱 */
  const MODES = ["json_schema", "json_object", "prompt_only"];

  const DEFAULTS = {
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: 60000,
    maxAttempts: 3,
  };

  /** 网络层错误：可重试（超时、连接断开、5xx、429） */
  class RetryableError extends Error {
    constructor(message, retryAfterMs) {
      super(message);
      this.name = "RetryableError";
      this.retryAfterMs = retryAfterMs || 0;
    }
  }

  /** 配置/鉴权类错误：重试没用，直接告诉用户改哪里 */
  class FatalError extends Error {
    constructor(message, hint) {
      super(message);
      this.name = "FatalError";
      this.hint = hint || "";
    }
  }

  /** 把 baseURL 收敛成 "xxx/v1/chat/completions"，容忍用户只填到域名 */
  function chatURL(baseURL) {
    const base = String(baseURL || DEFAULTS.baseURL).trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  /**
   * 拼请求体。
   * @param {object} p
   * @param {string} p.model
   * @param {Array<{role:string, content:any}>} p.messages
   * @param {object} [p.schema]  JSON Schema；传了才可能用 json_schema 档位
   * @param {string} [p.mode]    MODES 之一；不传用 json_object
   */
  function buildBody(p) {
    const mode = MODES.includes(p.mode) ? p.mode : "json_object";
    const body = {
      model: p.model || DEFAULTS.model,
      messages: p.messages,
      temperature: typeof p.temperature === "number" ? p.temperature : DEFAULTS.temperature,
      max_tokens: p.maxTokens || DEFAULTS.maxTokens,
      stream: false,
    };

    if (mode === "json_schema" && p.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "resume_fields", strict: true, schema: p.schema },
      };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    // prompt_only：不带 response_format
    return body;
  }

  /** 从各家返回结构里把正文抠出来（OpenAI 兼容 / 少数网关会塞在 data 里） */
  function pickContent(json) {
    const choice = json && json.choices && json.choices[0];
    const msg = choice && choice.message;
    let content = msg && msg.content;

    // 部分网关对 json_schema 的返回放在 message.tool_calls 里
    if (!content && msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const args = msg.tool_calls[0].function && msg.tool_calls[0].function.arguments;
      if (args) content = args;
    }
    if (!content && choice && typeof choice.text === "string") content = choice.text;
    if (!content && json && typeof json.output_text === "string") content = json.output_text;

    if (!content) {
      const reason = choice && choice.finish_reason;
      if (reason === "length") {
        throw new FatalError("模型输出被 max_tokens 截断，拿不到完整 JSON。", "把 max_tokens 调大，或把简历拆成两页分别抽取。");
      }
      throw new FatalError("模型返回里没有正文内容。", "检查模型名是否正确，或换一个支持 chat/completions 的服务。");
    }
    return content;
  }

  /** 读 Retry-After（秒或 http 日期），拿不到就用指数退避 */
  function retryDelay(resp, attempt) {
    const header = resp && resp.headers && typeof resp.headers.get === "function"
      ? resp.headers.get("retry-after")
      : null;
    if (header) {
      const sec = Number(header);
      if (!Number.isNaN(sec) && sec >= 0) return Math.min(sec * 1000, 30000);
    }
    return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
  }

  /** 把 HTTP 状态码翻译成错误：哪些值得重试，哪些该停下来让用户改配置 */
  function classifyStatus(status, text) {
    const snippet = String(text || "").slice(0, 300);
    if (status === 401 || status === 403) {
      return new FatalError(
        `API Key 被拒绝（HTTP ${status}）。${snippet}`,
        "到设置里检查 Key 是否填对、是否已过期、账户是否还有余额。"
      );
    }
    if (status === 404) {
      return new FatalError(
        `接口地址或模型名不存在（HTTP 404）。${snippet}`,
        "检查 baseURL（一般以 /v1 结尾）与模型名是否匹配。"
      );
    }
    if (status === 400 || status === 422) {
      // 参数不被支持（比如服务不认 response_format）→ 交给上层降级
      const err = new FatalError(`请求被拒绝（HTTP ${status}）。${snippet}`, "");
      err.unsupportedParam = true;
      return err;
    }
    if (status === 429) {
      return new RetryableError(`触发限流（HTTP 429）。${snippet}`);
    }
    if (status >= 500) {
      return new RetryableError(`服务端错误（HTTP ${status}）。${snippet}`);
    }
    return new FatalError(`请求失败（HTTP ${status}）。${snippet}`, "");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 扩展里的 fetch：转给后台 Service Worker 发。
   * 原因见 background.js 的 proxyLLM —— 弹窗会被销毁、跨域预检会被挡。
   * 返回对象刻意做成和浏览器 Response 同形的子集，好让上层代码保持单一实现。
   */
  function createProxyFetch() {
    return async function proxyFetch(url, init) {
      const resp = await chrome.runtime.sendMessage({
        type: "LLM_PROXY",
        payload: {
          url,
          method: (init && init.method) || "POST",
          headers: (init && init.headers) || {},
          body: init && init.body,
        },
      });
      if (!resp) throw new TypeError("后台没有响应，请重新加载扩展。");
      if (resp.network) throw new TypeError(resp.message || "网络请求失败");
      return {
        ok: !!resp.ok,
        status: resp.status || 0,
        headers: { get: (k) => (String(k).toLowerCase() === "retry-after" ? resp.retryAfter || null : null) },
        json: async () => JSON.parse(resp.text || "{}"),
        text: async () => resp.text || "",
      };
    };
  }

  /**
   * 单次调用（不含重试）。
   * @param {object} cfg  { baseURL, apiKey, model, mode, schema, temperature, maxTokens, timeoutMs }
   * @param {Array} messages
   * @param {object} [deps] { fetch, sleep } 便于单测注入
   */
  async function callOnce(cfg, messages, deps) {
    const d = deps || {};
    const doFetch = d.fetch || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new FatalError("当前环境没有 fetch。", "");
    if (!cfg || !cfg.apiKey) {
      throw new FatalError("还没有填 API Key。", "在「大模型设置」里填上 Key，它只保存在本浏览器本地。");
    }

    const timeoutMs = cfg.timeoutMs || DEFAULTS.timeoutMs;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    if (controller) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const started = Date.now();
    try {
      const resp = await doFetch(chatURL(cfg.baseURL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(buildBody(Object.assign({}, cfg, { messages }))),
        signal: controller ? controller.signal : undefined,
      });

      if (!resp.ok) {
        const text = await safeText(resp);
        throw classifyStatus(resp.status, text);
      }

      const json = await resp.json();
      const content = pickContent(json);
      const usage = json.usage || {};
      return {
        content,
        ms: Date.now() - started,
        usage: {
          prompt: usage.prompt_tokens || 0,
          completion: usage.completion_tokens || 0,
          total: usage.total_tokens || 0,
        },
        finishReason: (json.choices && json.choices[0] && json.choices[0].finish_reason) || "",
      };
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw new RetryableError(`请求超过 ${Math.round(timeoutMs / 1000)} 秒没有响应。`);
      }
      // fetch 抛的 TypeError（断网、DNS、CORS）都归为可重试
      if (e && (e.name === "TypeError" || /Failed to fetch|NetworkError/i.test(e.message || ""))) {
        throw new RetryableError(`网络请求失败：${e.message}`);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function safeText(resp) {
    try {
      return await resp.text();
    } catch (e) {
      return "";
    }
  }

  /**
   * 带重试的调用。
   * 可重试错误按指数退避重试；不可重试错误立刻抛。
   */
  async function callWithRetry(cfg, messages, deps) {
    const d = deps || {};
    const wait = d.sleep || sleep;
    const maxAttempts = cfg.maxAttempts || DEFAULTS.maxAttempts;
    let lastErr = null;
    let attempts = 0;
    let backoffMs = 0;

    for (let i = 1; i <= maxAttempts; i++) {
      attempts = i;
      try {
        const r = await callOnce(cfg, messages, d);
        return Object.assign(r, { attempts, backoffMs });
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RetryableError) || i === maxAttempts) break;
        const delay = e.retryAfterMs || Math.min(1000 * Math.pow(2, i - 1), 8000);
        backoffMs += delay;
        await wait(delay);
      }
    }
    lastErr.attempts = attempts;
    lastErr.backoffMs = backoffMs;
    throw lastErr;
  }

  /**
   * 自动降级调用：按 modes 顺序试，遇到「参数不被支持」就换下一档。
   * @param {object} cfg
   * @param {Array} messages
   * @param {object} [deps] { fetch, sleep, modes }
   * @returns {Promise<{content, mode, ms, usage, attempts, degraded:boolean}>}
   */
  async function callAuto(cfg, messages, deps) {
    const d = deps || {};
    const modes = (d.modes || MODES.slice()).filter((m) => m !== "json_schema" || cfg.schema);
    const tried = [];
    let lastErr = null;

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i];
      try {
        const r = await callWithRetry(Object.assign({}, cfg, { mode }), messages, d);
        return Object.assign(r, {
          mode,
          degraded: i > 0,
          triedModes: tried.concat([{ mode, ok: true }]),
        });
      } catch (e) {
        lastErr = e;
        tried.push({ mode, ok: false, error: e.message });
        // 只有「该参数不被支持」才值得换档；鉴权/网络问题换档也没用
        if (!e.unsupportedParam) break;
      }
    }
    lastErr.triedModes = tried;
    throw lastErr;
  }

  /**
   * 校验 Key 是否可用：发一个只要 1 个 token 的最小请求。
   * 返回 { ok, ms, model, message }
   */
  async function ping(cfg, deps) {
    try {
      const r = await callOnce(
        Object.assign({}, cfg, { maxTokens: 16, mode: "prompt_only" }),
        [{ role: "user", content: "回答一个词：ok" }],
        deps
      );
      return { ok: true, ms: r.ms, model: cfg.model, message: r.content.trim().slice(0, 40) };
    } catch (e) {
      // 联网探活不该消耗重试预算：ping 自己只发一次
      return { ok: false, message: e.message, hint: e.hint || "" };
    }
  }

  return {
    MODES,
    DEFAULTS,
    RetryableError,
    FatalError,
    chatURL,
    buildBody,
    pickContent,
    classifyStatus,
    callOnce,
    callWithRetry,
    callAuto,
    ping,
    createProxyFetch,
    sleep,
  };
});
