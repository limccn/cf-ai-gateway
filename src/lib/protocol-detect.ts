// 入站协议自动感知（08-31-protocol-auto-detect，R1/R2）：/v1/messages 双协议检测器。
// 纯函数：给定请求体（已 JSON 解析）与请求头，判定 Anthropic Messages / OpenAI Chat Completions。
//
// 规则（design §3，PRD R2）：
// - 硬信号优先：任一 Anthropic 硬信号 / 任一 OpenAI 硬信号（key 存在即计，值类型宽松防御）。
// - 双向冲突（两表各 ≥1 命中）→ 抛 ProtocolDetectionError（中间件转 400）。
// - 均无信号 → 模型名动态兜底：`gpt-*`（剥离 [1m] 后，大小写不敏感）→ openai；
//   `claude-*` → anthropic；其他 → openai（默认）。
// - 排除项：max_tokens / temperature / top_p / stream / messages / model（两协议共有）。
//   tool_choice 对象 type:"auto"：Anthropic 合法 / OpenAI 非法 → 不算信号（交兜底），防误判。
import { strip1mSuffix } from "./model-id";

export type Protocol = "anthropic" | "openai";

/** 双向协议字段混合（PRD R2.3）：中间件捕获转 400（不抛异常出错误链）。 */
export class ProtocolDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolDetectionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ANTHROPIC_TOP_LEVEL = new Set([
  "system",
  "stop_sequences",
  "metadata",
  "thinking",
]);
const OPENAI_TOP_LEVEL = new Set([
  "max_completion_tokens",
  "n",
  "stream_options",
  "response_format",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "seed",
  "stop",
  "parallel_tool_calls",
]);
const ANTHROPIC_CONTENT_TYPES = new Set(["image", "tool_use", "tool_result"]);
const OPENAI_CONTENT_TYPES = new Set(["image_url", "input_audio"]);

/** 顶层字段命中扫描（存在即计，值类型不校验——宽松防御）。 */
function scanTopLevel(body: Record<string, unknown>): {
  anthropic: string[];
  openai: string[];
} {
  const anthropic: string[] = [];
  const openai: string[] = [];
  for (const key of Object.keys(body)) {
    if (ANTHROPIC_TOP_LEVEL.has(key)) {
      anthropic.push(key);
    }
    if (OPENAI_TOP_LEVEL.has(key)) {
      openai.push(key);
    }
  }
  return { anthropic, openai };
}

/**
 * messages[].content 数组中的 content block 类型扫描（design §3.3 防御遍历）：
 * 仅当 content 为数组时遍历；元素非对象 / type 非字符串跳过；只查一层。
 */
function scanContentTypes(body: Record<string, unknown>): {
  anthropic: string[];
  openai: string[];
} {
  const anthropic: string[] = [];
  const openai: string[] = [];
  const messages = body["messages"];
  if (!Array.isArray(messages)) {
    return { anthropic, openai };
  }
  for (const msg of messages) {
    if (!isRecord(msg)) {
      continue;
    }
    const content = msg["content"];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const type = block["type"];
      if (typeof type !== "string") {
        continue;
      }
      if (ANTHROPIC_CONTENT_TYPES.has(type)) {
        anthropic.push(type);
      }
      if (OPENAI_CONTENT_TYPES.has(type)) {
        openai.push(type);
      }
    }
  }
  return { anthropic, openai };
}

/**
 * tools / tool_choice 扫描（design §3.1 表）：tool 含 input_schema（无 function 键）
 * → anthropic；tool type:"function" → openai；tool_choice 字符串/type:"function"/含
 * function 键 → openai；tool_choice 对象 type ∈ {any, tool} → anthropic；
 * type:"auto" 不算信号（防误判，交兜底）。
 */
function scanTools(body: Record<string, unknown>): {
  anthropic: string[];
  openai: string[];
} {
  const anthropic: string[] = [];
  const openai: string[] = [];
  const tools = body["tools"];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isRecord(tool)) {
        continue;
      }
      if (tool["input_schema"] !== undefined && tool["function"] === undefined) {
        anthropic.push("tool:input_schema");
      }
      if (tool["type"] === "function") {
        openai.push("tool:function");
      }
    }
  }
  const tc = body["tool_choice"];
  if (typeof tc === "string") {
    openai.push("tool_choice:string");
  } else if (isRecord(tc)) {
    const type = tc["type"];
    if (type === "any" || type === "tool") {
      anthropic.push("tool_choice:any/tool");
    } else if (type === "function" || tc["function"] !== undefined) {
      openai.push("tool_choice:function");
    }
    // type:"auto"：两协议歧义，不算信号（交兜底）
  }
  return { anthropic, openai };
}

/** 模型名动态兜底（PRD 决策 3）：gpt-* → openai；claude-* → anthropic；其他 → openai。 */
export function fallbackByModel(model: unknown): Protocol {
  if (typeof model !== "string" || model.length === 0) {
    return "openai";
  }
  const stripped = strip1mSuffix(model).toLowerCase();
  if (stripped.startsWith("claude-")) {
    return "anthropic";
  }
  return "openai";
}

/**
 * 协议判定（PRD R2，design §3）：硬信号优先 → 冲突 400 → 模型名兜底。
 * @param headers 请求头（anthropic-version 大小写不敏感）；缺失按无头处理。
 * @throws ProtocolDetectionError 双向冲突（R2.3）
 */
export function detectProtocol(body: unknown, headers?: Headers): Protocol {
  const hits = { anthropic: [] as string[], openai: [] as string[] };

  // 请求头硬信号（R2.1）：anthropic-version（大小写不敏感）
  if (headers !== undefined && headers.get("anthropic-version") !== null) {
    hits.anthropic.push("header:anthropic-version");
  }

  if (isRecord(body)) {
    const top = scanTopLevel(body);
    hits.anthropic.push(...top.anthropic);
    hits.openai.push(...top.openai);
    const content = scanContentTypes(body);
    hits.anthropic.push(...content.anthropic);
    hits.openai.push(...content.openai);
    const tools = scanTools(body);
    hits.anthropic.push(...tools.anthropic);
    hits.openai.push(...tools.openai);

    if (hits.anthropic.length > 0 && hits.openai.length > 0) {
      throw new ProtocolDetectionError(
        `request mixes OpenAI and Anthropic protocol fields: ` +
          `anthropic={${[...hits.anthropic].join(",")}} openai={${[...hits.openai].join(",")}}`,
      );
    }
    if (hits.anthropic.length > 0) {
      return "anthropic";
    }
    if (hits.openai.length > 0) {
      return "openai";
    }
    return fallbackByModel(body["model"]);
  }

  // 非对象 body（防御性兜底，design §3.3）：无信号无模型 → openai
  if (hits.anthropic.length > 0) {
    return "anthropic";
  }
  return "openai";
}
