// 段感知渲染的纯函数单测（09-22-env-config-unification，决策 D14「一套变量名、每环境一份值」）。
//
// 被测对象是 scripts/lib/toml-sections.mjs —— 特意抽成**零依赖纯函数**：它同时被 Node 侧的
// scripts/render-wrangler-config.mjs import，而 vitest 跑在 Workers pool（workerd）里没有 node:fs，
// 判定逻辑留在这边才测得到。需要读**生成物** wrangler.toml 的逐字段断言在
// scripts/verify-render-config.mjs（Node 侧）里做，两边互补。
//
// 为什么值得单独锁：段判定写错**不会报错**。把 `[vars]` 也当成环境段（X-E1）会让顶层变量全取
// staging 值 —— `name` / `routes` / D1 id 全部错位，而生成物本身看起来完全正常，只有部署时才炸。
// 故这里既有合成夹具的边界用例，也有直接跑**真实模板**（`?raw`，构建期内联）的结构契约。
import { describe, expect, it } from "vitest";
import {
  SECTION_BASE,
  SECTION_ENV,
  classifySections,
  collectTokenOccurrences,
  extractWorkerNames,
  renderBySection,
  sectionOf,
} from "../scripts/lib/toml-sections.mjs";
import template from "../wrangler.toml.template?raw";

/** 段内 ALL_CAPS 键名 —— `[vars]` 的键全是大写，而 name / pattern / assets 是小写，天然排除。 */
function upperKey(line: string): string | null {
  const m = /^([A-Z0-9_]+)\s*=/.exec(line.trim());
  return m?.[1] ?? null;
}

/** 取某段的键集合（含两侧表头之间的所有大写赋值行）。 */
function keysInSection(lines: string[], section: string): Set<string> {
  const keys = new Set<string>();
  for (const { line, section: sec } of classifySections(lines)) {
    if (sec !== section) continue;
    const key = upperKey(line);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * 渲染时给每个 (token, 段) 一个**可判别**的值：段标记做前缀 —— 段归属错了必然断言失败。
 * 标记刻意选 `base::` / `env::`（小写 + 双冒号）：token 名是大写加下划线，
 * 用 `BASE_` 当标记会被 `MODELCAP_BASE_TOKENS` 这种自带该字样的 token 名污染（假阳性）。
 */
const tagged = (token: string, section: string) =>
  section === SECTION_ENV ? `env::${token}` : `base::${token}`;

const MARK_BASE = "base::";
const MARK_ENV = "env::";

/** 全局复核段串味：返回「取了另一段的值」的行（表头 / 续行没有值，跳过）。 */
function leakedAcrossSections(rendered: string): string[] {
  const leaked: string[] = [];
  for (const { line, section } of classifySections(rendered.split("\n"))) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const wrong = section === SECTION_BASE ? MARK_ENV : MARK_BASE;
    if (line.slice(eq + 1).includes(wrong)) leaked.push(`${section}: ${line.trim()}`);
  }
  return leaked;
}

describe("sectionOf — 表头归属", () => {
  it.each([
    ["vars", SECTION_BASE, null],
    ["placement", SECTION_BASE, null],
    ["env", SECTION_BASE, null], // 段数不足：`[env]` 不是环境表头
    ["environment.staging", SECTION_BASE, null], // 前缀相似但不相等
    ["envx.staging", SECTION_BASE, null],
    ["env.staging", SECTION_ENV, "staging"],
    ["env.staging.vars", SECTION_ENV, "staging"],
    ["env.staging.queues.producers", SECTION_ENV, "staging"],
  ])("%s → %s（envName=%s）", (header, section, envName) => {
    expect(sectionOf(header)).toEqual({ section, envName });
  });

  it("表头两侧空白被裁掉（`[ vars ]` 仍是基段、`[ env.staging ]` 仍是环境段）", () => {
    expect(sectionOf(" vars ").section).toBe(SECTION_BASE);
    expect(sectionOf(" env.staging ")).toEqual({ section: SECTION_ENV, envName: "staging" });
  });
});

describe("classifySections — 逐行状态机", () => {
  it("表头之前的顶层键、以及 [vars] 都归基段；[env.*] 之后归环境段", () => {
    const classified = classifySections([
      'name = "gateway"', // 任何表头之前
      "[vars]",
      'API_KEY_PREFIX = "sk-"',
      "[[env.staging.d1_databases]]", // 双括号数组表
      'database_id = "x"',
      "[env.staging.vars]",
      'API_KEY_PREFIX = "sk-"',
    ]);
    expect(classified.map((c) => c.section)).toEqual([
      SECTION_BASE,
      SECTION_BASE,
      SECTION_BASE,
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
    ]);
    expect(classified[5]?.envName).toBe("staging");
  });

  it("环境段之后回到非 env 表头 → 复位为基段（不依赖「env 段总在文件末尾」这个偶然事实）", () => {
    const classified = classifySections(["[env.staging]", "a = 1", "[vars]", "b = 2"]);
    expect(classified.map((c) => c.section)).toEqual([
      SECTION_ENV,
      SECTION_ENV,
      SECTION_BASE,
      SECTION_BASE,
    ]);
  });

  it("注释行里的 [env.staging] 文字不是表头（否则整段落错段）", () => {
    const classified = classifySections([
      "[vars]",
      "# [env.staging] 这一段是说明文字",
      'API_KEY_PREFIX = "sk-"',
    ]);
    expect(classified.map((c) => c.section)).toEqual([
      SECTION_BASE,
      SECTION_BASE,
      SECTION_BASE,
    ]);
  });

  // 判别性用例：危险形态是**注释以方括号词结尾** —— 表头正则若丢了行首锚点，`[vars]` 会一路匹配到
  // 行尾被当成表头，于是这一段被复位成基段（环境段的行全部取到顶层值，生成物却看不出异常）。
  // 上面那条带尾随正文的注释挡不住这种变异（正则的 `$` 兜住了），故必须有这一条。
  it("注释以方括号词结尾时也不当表头（行首锚点的判别性用例）", () => {
    const classified = classifySections([
      "[env.staging]",
      "# 这一段是说明文字 [env.staging]",
      "# 参见 [vars]",
      'BETTER_AUTH_URL = "{BETTER_AUTH_URL}"',
    ]);
    expect(classified.map((c) => c.section)).toEqual([
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
    ]);
  });

  it("表头允许行尾注释", () => {
    expect(classifySections(["[env.staging] # 预发环境"])[0]?.section).toBe(SECTION_ENV);
  });

  it("多行数组的续行（`  { pattern = ... },` 与收尾 `]`）不是表头", () => {
    const classified = classifySections([
      "[env.staging]",
      "routes = [",
      '  { pattern = "stg.example.com", custom_domain = true },',
      "]",
    ]);
    expect(classified.map((c) => c.section)).toEqual([
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
      SECTION_ENV,
    ]);
  });

  it("保留全部输入行与顺序（注释、空行不丢）", () => {
    const input = ["# c", "", "[env.staging]", ""];
    expect(classifySections(input).map((c) => c.line)).toEqual(input);
  });
});

describe("renderBySection — 段感知的落点（X-E1 判别性用例）", () => {
  const lines = [
    'name = "{WORKER_NAME}"',
    "[[d1_databases]]",
    'database_name = "{D1_DB_NAME}"',
    "[env.staging]",
    'name = "{WORKER_NAME}"',
    "[[env.staging.d1_databases]]",
    'database_name = "{D1_DB_NAME}"',
    "[env.staging.vars]",
    'BETTER_AUTH_URL = "{BETTER_AUTH_URL}"',
  ];

  it("同一 token 名在两段渲染出不同的值，且互不污染", () => {
    const rendered = renderBySection(classifySections(lines), tagged);
    const out = rendered.split("\n");
    expect(out[0]).toBe('name = "base::WORKER_NAME"');
    expect(out[2]).toBe('database_name = "base::D1_DB_NAME"');
    expect(out[4]).toBe('name = "env::WORKER_NAME"');
    expect(out[6]).toBe('database_name = "env::D1_DB_NAME"');
    expect(out[8]).toBe('BETTER_AUTH_URL = "env::BETTER_AUTH_URL"');
  });

  it("按段归属全局复核：基段无 ENV_ 值、环境段无 BASE_ 值", () => {
    // 渲染后表头未变，故仍可用同一个状态机给结果分行定段。
    expect(leakedAcrossSections(renderBySection(classifySections(lines), tagged))).toEqual([]);
  });

  it("注释行不替换（注释里的 {KEY} 是说明文字，不是 token）", () => {
    const rendered = renderBySection(classifySections(["# 值来自 {WORKER_NAME}"]), tagged);
    expect(rendered).toBe("# 值来自 {WORKER_NAME}");
  });

  it("取值缺失（undefined/null）时保留 {TOKEN} 原样 —— 交给渲染脚本的残留检查兜底", () => {
    const rendered = renderBySection(classifySections(['name = "{A}"']), () => undefined);
    expect(rendered).toBe('name = "{A}"');
  });

  it("值里的 $ 不被当成替换模式（字符串形式的 replaceAll 会静默改写 `$&` / `$1`）", () => {
    const rendered = renderBySection(classifySections(['p = "{A}"']), () => "$&$1");
    expect(rendered).toBe('p = "$&$1"');
  });
});

describe("collectTokenOccurrences", () => {
  it("带段标注地收集 token，且跳过注释行", () => {
    const occurrences = collectTokenOccurrences(
      classifySections([
        'name = "{WORKER_NAME}"',
        "# {IGNORED} 只是说明",
        "[env.staging]",
        'queue = "{QUEUE_NAME}"',
      ]),
    );
    expect(occurrences).toEqual([
      { token: "WORKER_NAME", section: SECTION_BASE },
      { token: "QUEUE_NAME", section: SECTION_ENV },
    ]);
  });

  it("同一行的多个 token 都收（assets = { binding = ... } 这类行不含大写 token）", () => {
    const occurrences = collectTokenOccurrences(
      classifySections(['x = "{A}-{B}"']),
    );
    expect(occurrences.map((o) => o.token)).toEqual(["A", "B"]);
  });
});

describe("extractWorkerNames", () => {
  it("只认键名恰为 name 的行 —— database_name 不算（这正是要防的误判）", () => {
    // 把 database_name 放在 name 之前：若误判，top 会取到数据库名。
    const text = [
      "[[d1_databases]]",
      'database_name = "{D1_DB_NAME}"',
      "",
      'name = "gateway"',
      "[env.staging]",
      'database_name = "db-stg"',
      'name = "gateway-staging"',
    ].join("\n");
    expect(extractWorkerNames(text)).toEqual({
      top: "gateway",
      envNames: new Map([["staging", "gateway-staging"]]),
    });
  });

  it("同一环境的多个表段只记首个 name（[env.staging] / [[env.staging.d1_databases]] 同属一个环境）", () => {
    const text = [
      "[env.staging]",
      'name = "gw-stg"',
      "[[env.staging.d1_databases]]",
      'name = "not-the-worker-name"',
    ].join("\n");
    expect(extractWorkerNames(text).envNames).toEqual(new Map([["staging", "gw-stg"]]));
  });

  it("注释行与单引号值", () => {
    const text = ["# name = \"commented\"", "name = 'gw'"].join("\n");
    expect(extractWorkerNames(text).top).toBe("gw");
  });
});

describe("真实模板 wrangler.toml.template 的结构契约", () => {
  const lines = template.split(/\r?\n/);

  it("[env.staging.vars] 的键集合与顶层 [vars] **逐键相等**（D14 契约：同名变量两段各一份值）", () => {
    const baseKeys = keysInSection(lines, SECTION_BASE);
    const envKeys = keysInSection(lines, SECTION_ENV);
    // 空集合会让下面的相等断言恒真（恒真假绿），先钉住规模。
    expect(baseKeys.size).toBeGreaterThanOrEqual(13);
    expect([...envKeys].sort()).toEqual([...baseKeys].sort());
  });

  it("infra 结构 token 在两段都出现（同一 token 名，两段各自取值）", () => {
    const occurrences = collectTokenOccurrences(classifySections(lines));
    const inBase = new Set(
      occurrences.filter((o) => o.section === SECTION_BASE).map((o) => o.token),
    );
    const inEnv = new Set(
      occurrences.filter((o) => o.section === SECTION_ENV).map((o) => o.token),
    );
    for (const token of [
      "WORKER_NAME",
      "DOMAIN",
      "D1_DB_NAME",
      "D1_DB_ID",
      "KV_ID",
      "QUEUE_NAME",
      "BILLING_QUEUE_NAME",
      // 双域名分流（09-21-dual-domain-split）：`API_DOMAIN` 两段都有（routes + [vars] 各一处）。
      // 它是**运行时分流的开关**，只在环境段出现的话 stg 会静默回退到基段的生产域名。
      "API_DOMAIN",
      // 旧域转发源：**两段各一条 routes**（prod = router.lmlh.net / stg = stg-router.lmlh.net）。
      // 只在一段出现的话，那一侧的第三条 route 无值可烘 —— 基段缺是 fail-fast，环境段缺则静默
      // 回退成 prod 的旧域（由 verify 脚本的 AC-B11c 直接对账值文件钉住）。
      "LEGACY_DOMAIN",
    ]) {
      expect(inBase.has(token)).toBe(true);
      expect(inEnv.has(token)).toBe(true);
    }
  });

  it("{LEGACY_DOMAIN} 两段都出现（prod 与 stg 各绑自己的旧域做转发）", () => {
    const occurrences = collectTokenOccurrences(classifySections(lines)).filter(
      (o) => o.token === "LEGACY_DOMAIN",
    );
    // 空集合会让 `every` 恒真（恒真假绿），先钉住"确实出现过"。
    expect(occurrences.length).toBeGreaterThan(0);
    // 判据取"两段各有 ≥1 处"而非精确条数：条数由 verify 脚本的 AC-B11a/b（有序全量比对，含
    // "恰好三条"）钉住；这里要抓的是**某一侧的绑定整条消失**（prod 不再绑旧域 ⇒ 基段 0 处）。
    const inBase = occurrences.filter((o) => o.section === SECTION_BASE);
    const inEnv = occurrences.filter((o) => o.section === SECTION_ENV);
    expect(inBase.length).toBeGreaterThan(0);
    expect(inEnv.length).toBeGreaterThan(0);
  });

  it("整份模板渲染后：顶层 name 取基段值、[env.staging].name 取环境段值，且两者不同", () => {
    const rendered = renderBySection(classifySections(lines), tagged);
    const { top, envNames } = extractWorkerNames(rendered);
    expect(top).toBe("base::WORKER_NAME");
    expect(envNames.get("staging")).toBe("env::WORKER_NAME");
    expect(top).not.toBe(envNames.get("staging"));
  });

  it("整份模板渲染后无段串味：基段无 ENV_ 值、环境段无 BASE_ 值", () => {
    expect(leakedAcrossSections(renderBySection(classifySections(lines), tagged))).toEqual([]);
  });

  it("模板自身的段判定稳定：环境段只出现在 [env.staging.*] 之下，且 [vars] 属基段", () => {
    const classified = classifySections(lines);
    const varsIndex = classified.findIndex((c) => c.line.trim() === "[vars]");
    const envIndex = classified.findIndex((c) => c.line.trim() === "[env.staging]");
    expect(varsIndex).toBeGreaterThan(-1);
    expect(envIndex).toBeGreaterThan(varsIndex);
    expect(classified[varsIndex]?.section).toBe(SECTION_BASE);
    expect(classified[envIndex]?.section).toBe(SECTION_ENV);
    // [vars] 与 [env.staging] 之间的每一行都是基段（顶层 [vars] 段内不得混入环境行）
    for (const c of classified.slice(varsIndex, envIndex)) {
      expect(c.section).toBe(SECTION_BASE);
    }
  });
});
