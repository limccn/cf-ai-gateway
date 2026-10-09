// 价格表（/models）的角色相关**展示**逻辑 —— 纯函数、无 React、无 DOM。
//
// 为什么单独成文件而不是写在 models.tsx 的 JSX 里：本仓库**没有 DOM 测试框架**
// （tests/ 下无 jsdom docblock），「哪个角色看到哪些列」若留在 JSX，就只剩
// scripts/ui-audit 的探针一条防线。下沉成数据后可以在 tests/model-price-display.unit.test.ts
// 里直接断言列集合；更重要的是 models.tsx 的**表头与表体从同一份数组渲染**
// （`columns.map` 两处），「member 少一列却只改了一处」这种错位在构造上不可能发生。
//
// ⚠ 本文件只管**展示**。真正的角色隔离在**服务端**（见 .trellis/spec/backend/security.md）：
//   被隐藏的行不进 member 的响应体、免费模型的价在响应里就是 0 —— 前端拿到什么就渲染什么，
//   这里决定的是「怎么画」，不是「能不能看见」。
import type { ModelResponse } from "./types";
// ⚠ 相对导入而非 `@/…`：本文件被 vitest **直接 import**，而测试侧没有 `@/` 别名
//   （vitest.config.ts 无 resolve.alias；tsconfig.test.json 的 paths 继承不到根 tsconfig）。
//   被测试导入的 app 模块一律走相对路径 —— 这条写进 spec/frontend/components.md。
import { formatNumber } from "../../lib/format";

/** 列标识。新增列必须同时在 models.tsx 的 `cellRenderers` 里补渲染器（Record 类型会拦住漏项）。 */
export type ModelTableColumnKey =
  | "model"
  | "input"
  | "inputCached"
  | "output"
  | "maxOutput"
  | "updated"
  | "actions";

export interface ModelTableColumn {
  key: ModelTableColumnKey;
  /**
   * 表头文案。`actions` 必须恰好是 "Actions" —— scripts/verify-responsive.mjs 的 AC5
   * 用 /^actions$/i 断言**末列**是 Actions 且未冻结（position ≠ sticky）。改文案要同步改那条断言。
   */
  label: string;
  /** 表头单元格类名（含响应式藏列：`hidden sm:table-cell` 等，与角色无关的那一维）。 */
  headClassName: string;
  /** 表体单元格类名。响应式藏列必须与表头**同款**，否则窄屏下表头/表体错位。 */
  cellClassName: string;
}

// 四列所有角色都见（member 的价格表就长这样）。
const SHARED_COLUMNS: ModelTableColumn[] = [
  { key: "model", label: "Model", headClassName: "", cellClassName: "" },
  {
    key: "input",
    label: "Input / 1M",
    headClassName: "text-right",
    cellClassName: "text-right whitespace-nowrap",
  },
  {
    key: "inputCached",
    label: "Input cached / 1M",
    headClassName: "hidden text-right sm:table-cell",
    cellClassName: "hidden text-right sm:table-cell",
  },
  {
    key: "output",
    label: "Output / 1M",
    headClassName: "text-right",
    cellClassName: "text-right whitespace-nowrap",
  },
];

// 三列仅 admin 见（批次 P，D18/D19）：
//   maxOutput / updated —— 运维信息，member 用不上；
//   actions —— 两个行控制（Free / Hidden）+ 编辑/删除，全是 admin 动作。
// member 侧**整列消失**（不是渲染成空列）：少 3 列是 AC30 的验收口径。
const ADMIN_COLUMNS: ModelTableColumn[] = [
  {
    key: "maxOutput",
    label: "Max output",
    headClassName: "hidden text-right lg:table-cell",
    cellClassName: "hidden text-right lg:table-cell",
  },
  {
    key: "updated",
    label: "Updated",
    headClassName: "hidden md:table-cell",
    cellClassName: "hidden text-muted-foreground md:table-cell",
  },
  {
    key: "actions",
    label: "Actions",
    headClassName: "text-right",
    cellClassName: "text-right",
  },
];

/**
 * 该角色渲染哪些列（有序）。表头与表体**都**必须用它驱动 —— 两处渲染同一数组是错位的结构性防线。
 *
 * `isAdmin` 为假 ⇒ 恰不含 maxOutput / updated / actions 三列；为真 ⇒ 全 7 列且 actions 在末位。
 */
export function modelTableColumns(isAdmin: boolean): ModelTableColumn[] {
  // 返回新数组：调用方（或未来某次误改）动不了模块级常量
  const columns = [...SHARED_COLUMNS];
  if (isAdmin) {
    columns.push(...ADMIN_COLUMNS);
  }
  return columns;
}

export interface ModelBadge {
  key: "free" | "hidden";
  label: string;
  /** 语义色沿用 providers.tsx 的既有约定：success = 生效中的开关，muted = 收敛态（**不是** disabled）。 */
  variant: "success" | "muted";
  /** 悬停解释。徽章文字只有 4~6 个字符，说不清「这不等于停用 / 不等于改价」。 */
  title: string;
}

/**
 * Model 列的状态徽章（批次 P 建立，2026-09-23 用户调整受众）。
 *
 * ⚠ **受众按徽章分，不是一个开关管两个**：
 *   · `Free` —— **两种角色都渲染**（用户 2026-09-23：「member 用户也应该在模型后面显示绿色 free」）。
 *     对 member 它不是装饰：服务端已把免费行的价置 0（D20），三格 `$0.00` **单独看像「没配价」**，
 *     徽章与零价互为佐证（这也正是它用 success 绿色的原因）。
 *   · `Hidden` —— **仅 admin**：它说的是「这一行对 member 不可见」，而 member 本就不该知道
 *     有这一行（D18 过滤在服务端，整行不进响应体）。传 `isAdmin` 而不是让调用方判断：
 *     调用方漏判 = 徽章泄漏，这里一处兜住（纵深防御 + 让单测无需 DOM）。
 *
 * ⚠ 两个 title **不是措辞差异，是事实不同**：admin 表里显示的是**库里的真价**，故必须说
 *   「不是本表显示的价」；而 member 的表**就是**免费价，同一句话对他说恰好说反。
 */
export function modelBadges(
  item: Pick<ModelResponse, "freeMode" | "hiddenFromMembers">,
  isAdmin: boolean,
): ModelBadge[] {
  const badges: ModelBadge[] = [];
  if (item.freeMode) {
    badges.push({
      key: "free",
      label: "Free",
      variant: "success",
      title: isAdmin
        ? "Free mode: this model is billed at the free-mode rate, not the prices shown in this table"
        : "Free mode: this model is currently free — the prices shown are the free-mode prices",
    });
  }
  if (isAdmin && item.hiddenFromMembers) {
    badges.push({
      key: "hidden",
      label: "Hidden",
      variant: "muted",
      title: "Hidden from members: this row is omitted from the member price table — the model is still served",
    });
  }
  return badges;
}

// ============= Max output 档位下拉（批次 Q，2026-09-23）=============
//
// 这里原来是一个自由数字输入框（`type="number"`，占位符里写着 16000）——能产出任意值，
// 而「上限」在本系统里是有网格的：运行时 `cap = MODELCAP_BASE_TOKENS(8192) ×
// MODELCAP_MULTIPLIER(2) × 档位 = 16384 × 档位`。现在只能从下面这份表里选，
// 库值只可能来自下拉 ⇒ **下拉给不出的值**在输入侧绝迹（服务端仍不校验网格，见下）。
//
// ⚠ 数值写死在此、不 import `src/lib/modelcaps.ts`：SPA 不该背服务端常量
//   （spec/backend/quality.md 记过「import 后端常量拖依赖链」的坑），且前端该有自己的主张 ——
//   两边的一致性由 tests/model-price-display.unit.test.ts 的**交叉校验**承担：后端改了常数，
//   测试变红并逼一次显式决定，而不是让前端静默跟着漂移。
// ⚠ 上限的运行时权威**不是**这张表、也不是库里的值：模型若已在生成常量表里，快路径直接按常量
//   夹取（src/routes/v1/proxy.ts:445-452），抬高立即生效、压低只对超过常量的请求生效。
//   表单帮助文字如实写了这条，别把这张表读成「选了就生效」。

/** 下拉的一条选项。`value` 既喂 `<option>` 也是提交值（`""` = 不限 → payload 送 `null`）。 */
export interface ModelCapOption {
  /** "" = 不限；否则是 token 数的十进制串。 */
  value: string;
  /** 展示文案，**由 multiplier/tokens 推导** ⇒ 标签不可能与值漂移。 */
  label: string;
  /** 相对基准的倍率；null = 不限。 */
  multiplier: number | null;
  /** 绝对 token 数；null = 不限。 */
  tokens: number | null;
}

// 网格常数（缺省 MODELCAP_BASE_TOKENS / MODELCAP_MULTIPLIER / 二者之积）：
//   一个「档位」的绝对 token 数 = 8192 × 2 × 档位 = 16384 × 档位 —— 两个因子都要乘上，
//   只乘基准（8192 × 档位）会整体缩一半。三个常量都给名字，就是为了让这层关系写在脸上。
const GRID_BASE_TOKENS = 8192;
const GRID_MULTIPLIER = 2;
/** 1x 档的绝对 token 数（缺省 16,384）。 */
const GRID_STEP_TOKENS = GRID_BASE_TOKENS * GRID_MULTIPLIER;

function capOption(multiplier: number): ModelCapOption {
  const tokens = GRID_STEP_TOKENS * multiplier;
  return {
    value: String(tokens),
    label: `${multiplier}x — ${formatNumber(tokens)} tokens`,
    multiplier,
    tokens,
  };
}

/** 只含档位（不含「不限」）且 tokens 非空的那部分，供最近档吸附用。 */
const TIER_OPTIONS: readonly ModelCapOption[] = [
  capOption(0.5),
  capOption(1),
  capOption(2),
  capOption(4),
  capOption(8),
];

/**
 * 下拉的全部选项（有序）：**Unlimited 在首位**（哨兵前置，与 billing / users 的 "All …" 同款），
 * 其后按倍率升序。
 */
export const MODEL_CAP_OPTIONS: readonly ModelCapOption[] = [
  { value: "", label: "Unlimited — no cap", multiplier: null, tokens: null },
  ...TIER_OPTIONS,
];

/**
 * 该库值是否是**下拉给不出的**上限（弹窗据此显示「原值不在可选项内」的说明行）。
 * `null`（不限）本身是合法状态、不是「给不出的值」⇒ 恒为 false。
 *
 * ⚠ 这是个**问题判据**（true = 要提示用户），所以名字必须读成「是个没被提供的 cap」——
 *   复核时一度改名 `isOfferedTier` 而函数体没翻，名字与语义正好相反；探针当场抓到
 *   （该出说明行的 16000 一行字都没渲染）。单测**测不出**这种反号错：把标识符一起改了就同义。
 *
 * ⚠ 别与「档位网格」混用：本仓库有**两个不同的集合**，刻意不同源 ——
 *   · **构建期网格**（`scripts/lib/modelcap-grid.mjs` 的 `isGridTier`）：**半档**即合法，
 *     1.5x / 3x 都能写进 `seed.sql` 并通过 `render:modelcaps`；
 *   · **下拉提供集**（本函数）：恰好 `MODEL_CAP_OPTIONS` 里的五档。
 *   1.5x（24,576）在前者合法、在后者选不到 ⇒ 这里返回 true。名称与用户可见文案
 *   都按各自那个集合说话（曾用名 `isOffGrid` 与构建期网格同名，复核时改掉）。
 */
export function isUnofferedCap(tokens: number | null): boolean {
  return tokens !== null && !MODEL_CAP_OPTIONS.some((option) => option.tokens === tokens);
}

/**
 * 表单初值：把库值吸附到最近档，返回 `<option value>` 字符串。
 *
 * 规则（批次 Q 决策 D22，用户裁定「打开即就近预选」）：
 *   - `null` → `""`（不限）；在网格上 → 原值；
 *   - 不在下拉里 → 最近档，**并列取较大档**（16,000 → 1x；24,576 距 1x/2x 各 8,192 → 取 2x）；
 *   - 低于最小档（< 0.5x）→ 取 0.5x（网格下限，只能向上取）。
 *
 * 吸附发生在**打开弹窗时**，保存即写回库 —— 所以弹窗里会显式写出原值（见 models.tsx），
 * 不静默改写。当前全库（seed / 本机 / stg 实查）无这类值，这是为将来兜底。
 */
export function snapToTier(tokens: number | null): string {
  if (tokens === null) {
    return "";
  }
  let bestValue = TIER_OPTIONS[0]?.value ?? "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of TIER_OPTIONS) {
    if (option.tokens === null) {
      continue;
    }
    const distance = Math.abs(option.tokens - tokens);
    // `<=` 而非 `<`：TIER_OPTIONS 升序 ⇒ 并列时后到的（更大的）档胜出
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestValue = option.value;
    }
  }
  return bestValue;
}
