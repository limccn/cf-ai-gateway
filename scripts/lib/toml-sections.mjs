// TOML 段判定（render-wrangler-config.mjs 与 tests/render-config.unit.test.ts 共用）。
// **纯字符串函数，不依赖任何 node 内建** —— 因此可以直接在 vitest 的 Workers pool（workerd）里 import
// （那边的测试没有 node:fs；凡是需要读文件的断言都放在 scripts/verify-render-config.mjs 里跑）。
//
// 段语义（09-22-env-config-unification，决策 D14「一套变量名、每环境一份值」）：
//   `[env.<name>]` / `[env.<name>.*]` / `[[env.<name>.*]]` 表头之后的段落 = **环境段**；
//   其余段落（含任何表头之前的顶层键，如 name / routes / assets）= **基段**。
// 判定依据必须是"当前生效的表头"这一状态机，而**不是字符串包含** —— `[vars]` 与
// `[env.staging.vars]` 同为普通表头，前者段外、后者段内，靠 `includes("env")` 区分不出来。

export const SECTION_BASE = "base";
export const SECTION_ENV = "env";

/**
 * TOML 表头行：`[x]` / `[[x]]`，允许行尾注释。
 * **行首锚点 `^` 是必需的**：去掉它，注释里的 `# [env.staging] 说明` 会被当成表头，
 * 之后的整段行都会被错判成环境段（而生成物看起来完全正常）。注释不会以 `[` 开头，
 * 故 classifySections 里无需再挂一个 `startsWith("#")` 守卫 —— 变异验证证实那是恒等冗余
 * （删掉它一条断言都不变色），已删；真正在挡这件事的是这个锚点。
 * 多行数组内的 `{ pattern = ... }` 行与收尾的 `]` 同理，都不以 `[` 开头。
 */
export const HEADER_RE = /^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;

/**
 * 表头 → 所属段。任何非 `env.` 前缀的表头都把状态**复位回基段**（模板里 [env.*] 段之后不再有
 * 顶层表头，但状态机不能依赖这个偶然事实）。
 */
export function sectionOf(header) {
  const segments = header.split(".").map((s) => s.trim());
  return segments[0] === "env" && segments.length >= 2
    ? { section: SECTION_ENV, envName: segments[1] }
    : { section: SECTION_BASE, envName: null };
}

/**
 * 给每一行标注所属段，返回 `[{ line, section, envName }]`（顺序与输入一致，注释行也保留）。
 * `envName` 是该段所处的环境名（基段为 null），供"环境名不得等于顶层名"的校验使用。
 */
export function classifySections(lines) {
  const classified = [];
  let section = SECTION_BASE;
  let envName = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(HEADER_RE); // HEADER_RE 行首锚定，注释行天然不匹配
    if (header) {
      const next = sectionOf(header[1]);
      section = next.section;
      envName = next.envName;
    }
    classified.push({ line, section, envName });
  }
  return classified;
}

/** 模板中出现的全部 `{TOKEN}` 及其所属段（注释行不参与 —— 注释里的 `{KEY}` 是说明文字，不是 token）。 */
export function collectTokenOccurrences(classified) {
  const occurrences = [];
  for (const { line, section } of classified) {
    if (line.trim().startsWith("#")) continue;
    for (const m of line.matchAll(/\{([A-Z0-9_]+)\}/g)) {
      occurrences.push({ token: m[1], section });
    }
  }
  return occurrences;
}

/**
 * 按行所属段替换 token：`valueOf(token, section)` 为该 (token, 段) 的取值函数。
 * **这是段感知的落点** —— 同一个 token 名在基段与环境段可以渲染出不同的值，正是 D14 的契约。
 * 返回 null/undefined 的取值保持 `{TOKEN}` 原样（残留检查会兜住）。
 */
export function renderBySection(classified, valueOf) {
  return classified
    .map(({ line, section }) => {
      if (line.trim().startsWith("#")) return line;
      let out = line;
      for (const m of line.matchAll(/\{([A-Z0-9_]+)\}/g)) {
        const value = valueOf(m[1], section);
        // 用**函数形式**的替换：字符串形式的 replaceAll 会把值里的 `$&` / `$1` 当替换模式解释，
        // 于是含 `$` 的值会被静默改写（值本身看起来完全正常，生成物却已损坏）。
        if (value !== undefined && value !== null) out = out.replaceAll(`{${m[1]}}`, () => value);
      }
      return out;
    })
    .join("\n");
}

/**
 * 从（已渲染的）TOML 文本中提取 worker 名：顶层的 `name` 与各 `[env.<name>]` 段的 `name`。
 * 只认键名**恰为** `name` 的行 —— `database_name` 不算（这正是要防的误判）。
 * 段内只取该环境的第一处（`[env.staging]` / `[[env.staging.d1_databases]]` / `[env.staging.vars]`
 * 都归属同一环境，后两者里没有 `name` 键）。
 */
export function extractWorkerNames(text) {
  let top = null;
  const envNames = new Map();
  let currentEnv = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(HEADER_RE);
    if (header) {
      currentEnv = sectionOf(header[1]).envName;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv || kv[1] !== "name") continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (currentEnv === null) {
      if (top === null) top = value;
    } else if (!envNames.has(currentEnv)) {
      envNames.set(currentEnv, value);
    }
  }
  return { top, envNames };
}
