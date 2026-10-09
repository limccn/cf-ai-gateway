// /models 价格表的角色展示逻辑单测（批次 P，2026-09-23）。纯函数、无 DOM、无 Worker ——
// 与 provider-form.unit.test.ts / menu-position.unit.test.ts 同一类。
//
// 为什么值得单测：本仓库**没有 DOM 测试框架**，所以「member 到底看到几列」的真实防线是
//   (a) 服务端：tests/models-api.test.ts 断行过滤与价格置 0；
//   (b) 这里：断**列集合**（哪些列、什么顺序）；
//   (c) 探针（scripts/ui-audit）：断像素与交互。
// 少了 (b)，「member 少三列」就只剩 (c) 一条防线，而 (c) 不在 CI 里。
//
// 这里钉的是三条**判别力最强**的不变量（不是「跑一遍看没炸」）：
//   ① 差集**恰好**是三列 —— 多藏一列（如 member 看不到 Output）同样得红，不只是「少了点什么」。
//   ② 表头与表体的**响应式**藏列集合逐列相等 —— 窄屏下表头/表体错位是这个表最真实的风险
//      （两处类名分属两个数组元素，改一处忘另一处不会有任何编译错误）。
//   ③ 徽章的**受众按徽章分** —— `Free` 两种角色都看得到（对 member 它解释那三格 `$0.00`），
//      `Hidden` 恒不泄漏给 member。写成「非 admin 恒空数组」会把这条受众差异一起锁死。
import { describe, expect, it } from "vitest";
import {
  MODEL_CAP_OPTIONS,
  isUnofferedCap,
  modelBadges,
  modelTableColumns,
  snapToTier,
  type ModelTableColumn,
} from "../app/modules/models/display";
// 标签格式的**真源**（批次 Q 复核补）：display.ts 声称「标签由值推导 ⇒ 标签不可能与值漂移」，
// 这条声称得有断言兜着，否则改坏标签（漏掉倍率前缀 / 不格式化数字）无人发现。
import { formatNumber } from "../app/lib/format";
// 交叉校验的**真源**：前端档位表里的数字必须等于运行时那条公式的取值，而不是各写一份字面量。
// 后端改了常数（MODELCAP_BASE_TOKENS/MULTIPLIER）或 seed 引入了新档位 ⇒ 这里变红，逼一次显式决定。
import { DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER } from "../src/lib/modelcaps";
import { MODELCAPS } from "../src/generated/modelcaps";

/** 从类名里抽出「响应式显隐」相关的 token（藏列/断点变体），其余排版类不参与比较。 */
function responsiveTokens(className: string): string[] {
  return className
    .split(/\s+/)
    .filter((token) => token === "hidden" || token.endsWith(":table-cell"))
    .sort();
}

function keysOf(columns: ModelTableColumn[]): string[] {
  return columns.map((c) => c.key);
}

describe("modelTableColumns — 角色决定列集合", () => {
  it("admin 拿全部 7 列，Actions 在末位", () => {
    // Actions 必须**恰好在最后**：verify-responsive.mjs AC5 断言末列表头是 /^actions$/i，
    // 而该断言是「Actions 未冻结」这条负向锁的锚点。
    expect(keysOf(modelTableColumns(true))).toEqual([
      "model",
      "input",
      "inputCached",
      "output",
      "maxOutput",
      "updated",
      "actions",
    ]);
  });

  it("member 拿前 4 列，差集恰好是 maxOutput / updated / actions", () => {
    const admin = keysOf(modelTableColumns(true));
    const member = keysOf(modelTableColumns(false));

    expect(member).toEqual(["model", "input", "inputCached", "output"]);
    // 差集写出来而不是写「长度差 3」：将来多一个 admin-only 列时，长度断言仍绿，这条会红。
    expect(admin.filter((k) => !member.includes(k))).toEqual(["maxOutput", "updated", "actions"]);
    // 方向二：member 不得出现任何 admin 没有的列（真的写反了角色判断时这条会红）
    expect(member.filter((k) => !admin.includes(k))).toEqual([]);
  });

  it("member 的末列不是 Actions（两个行控制对 member 整列消失）", () => {
    const member = modelTableColumns(false);
    expect(member[member.length - 1]?.key).toBe("output");
  });

  it("列 key 唯一（重复 key 会让 React 渲染串行，且表头顺序难以察觉地错位）", () => {
    for (const isAdmin of [true, false]) {
      const keys = keysOf(modelTableColumns(isAdmin));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("每列表头与表体的响应式藏列一致（窄屏错位的结构防线）", () => {
    for (const isAdmin of [true, false]) {
      for (const column of modelTableColumns(isAdmin)) {
        expect(
          responsiveTokens(column.cellClassName),
          `列 ${column.key} 的表头/表体响应式类名不一致`,
        ).toEqual(responsiveTokens(column.headClassName));
      }
    }
  });
});

describe("modelBadges — 受众按徽章分（Free 双角色 / Hidden 仅 admin）", () => {
  it("admin + 两个标记都为真 ⇒ Free 在前、Hidden 在后，语义色各就各位", () => {
    const badges = modelBadges({ freeMode: true, hiddenFromMembers: true }, true);
    expect(badges.map((b) => [b.key, b.label, b.variant])).toEqual([
      ["free", "Free", "success"],
      ["hidden", "Hidden", "muted"],
    ]);
    // 每个徽章都得有 title：4 个字符说不出「这不等于停用 / 不等于改价」
    for (const badge of badges) {
      expect(badge.title.length).toBeGreaterThan(0);
    }
  });

  it("admin + 两个标记都为假 ⇒ 空数组（不会渲染出空徽章）", () => {
    expect(modelBadges({ freeMode: false, hiddenFromMembers: false }, true)).toEqual([]);
  });

  it("admin + 只开 Hidden ⇒ 只有 Hidden（两个标记互不牵连）", () => {
    expect(modelBadges({ freeMode: false, hiddenFromMembers: true }, true).map((b) => b.key)).toEqual([
      "hidden",
    ]);
  });

  it("member + 免费 ⇒ 看得到 Free（与那三格 $0.00 互为佐证）", () => {
    expect(modelBadges({ freeMode: true, hiddenFromMembers: false }, false).map((b) => [b.key, b.label, b.variant]))
      .toEqual([["free", "Free", "success"]]);
  });

  it("member 即便两端标记为真也只拿得到 Free —— Hidden 是纵深防御，恒不下发", () => {
    expect(modelBadges({ freeMode: true, hiddenFromMembers: true }, false).map((b) => b.key)).toEqual(["free"]);
    // 只开 Hidden 时对 member 是**空**数组：这条才是「泄漏」的真正反面（上面那条有 Free 兜着，看不出漏没漏）
    expect(modelBadges({ freeMode: false, hiddenFromMembers: true }, false)).toEqual([]);
  });

  it("同一行两种角色的 Free title **不同**（admin 看真价、member 看免费价，一句话说不通两边）", () => {
    const asAdmin = modelBadges({ freeMode: true, hiddenFromMembers: false }, true)[0]?.title;
    const asMember = modelBadges({ freeMode: true, hiddenFromMembers: false }, false)[0]?.title;
    expect(asAdmin).toBeTruthy();
    expect(asMember).toBeTruthy();
    // 两两不等的候选值才有判别力：相等 ⇒ 必有一条在说假话（admin 那句对 member 恰好说反）
    expect(asMember).not.toEqual(asAdmin);
  });
});

// ============= Max output 档位下拉（批次 Q，2026-09-23）=============
// 表单从自由输入换成下拉后，「能存进库的值」= 下面这份表的取值集合。四条不变量：
//   ① 数值与运行时公式**同源**（后端改常数 → 红）；
//   ② 候选值两两不等（值重复时「选中哪一档」无法判别，断言会退化成恒真）；
//   ③ 生成物里的每一档都选得到（seed 加了新档位 → 红，逼一次显式决定）；
//   ④ 离网值吸附规则（D22：就近预选，并列取大，低于网格取 0.5x）。
describe("MODEL_CAP_OPTIONS — 档位下拉的取值", () => {
  it("数值等于真源公式（基准 × 倍率），不是抄来的字面量", () => {
    for (const option of MODEL_CAP_OPTIONS) {
      if (option.multiplier === null) {
        continue;
      }
      expect(option.tokens).toBe(
        DEFAULT_MODELCAP_BASE_TOKENS * DEFAULT_MODELCAP_MULTIPLIER * option.multiplier,
      );
      expect(option.value).toBe(String(option.tokens));
    }
  });

  it("形状：Unlimited 在首位，五档升序，value/label 两两不等", () => {
    expect(MODEL_CAP_OPTIONS.length).toBe(6);
    expect(MODEL_CAP_OPTIONS[0]).toEqual({
      value: "",
      label: "Unlimited — no cap",
      multiplier: null,
      tokens: null,
    });
    const tiers = MODEL_CAP_OPTIONS.filter((o) => o.tokens !== null);
    expect(tiers.map((o) => o.multiplier)).toEqual([0.5, 1, 2, 4, 8]);

    // 候选值两两不等 —— 判别力来自这里，不是「值非空」
    const values = MODEL_CAP_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    const labels = MODEL_CAP_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);

    // 标签**格式**（不只是两两不等）：倍率前缀 + 经 formatNumber 的 token 数。少了任何一段，
    // 「标签由值推导」这句声称就落空了 —— 两两不等挡不住「全部去掉倍率前缀」这种一起漂移。
    for (const option of MODEL_CAP_OPTIONS) {
      if (option.tokens === null || option.multiplier === null) {
        // 哨兵只有一条；将来多出第二条无值选项，这里变红（而不是被 loop 静默跳过）
        expect(option.label).toBe("Unlimited — no cap");
        continue;
      }
      expect(option.label).toBe(`${option.multiplier}x — ${formatNumber(option.tokens)} tokens`);
    }
  });

  it("生成物里每一档都选得到（先断非空，空集合不得平凡通过）", () => {
    const models = Object.entries(MODELCAPS);
    expect(models.length).toBeGreaterThan(0);
    const offered = new Set(MODEL_CAP_OPTIONS.map((o) => o.tokens));
    for (const [model, tier] of models) {
      if (tier === null) {
        continue; // 不限永远可选（"" 哨兵）
      }
      const cap = DEFAULT_MODELCAP_BASE_TOKENS * DEFAULT_MODELCAP_MULTIPLIER * tier;
      expect(offered.has(cap), `${model}（档位 ${tier} → ${cap} tokens）不在下拉选项里`).toBe(true);
    }
  });
});

describe("snapToTier / isUnofferedCap — 不在选项里的上限怎么处理（D22）", () => {
  it("null（不限）→ 空哨兵；在网格上 → 原值", () => {
    expect(snapToTier(null)).toBe("");
    for (const tokens of [8192, 16384, 32768, 65536, 131072]) {
      expect(snapToTier(tokens)).toBe(String(tokens));
    }
  });

  it("离网 → 最近档：16,000 → 1x，10,000 → 0.5x，200,000 → 8x", () => {
    expect(snapToTier(16000)).toBe("16384");
    expect(snapToTier(10000)).toBe("8192");
    expect(snapToTier(200000)).toBe("131072");
  });

  it("并列取**较大**档：12,288 距 0.5x/1x 各 4,096 → 1x；24,576 距 1x/2x 各 8,192 → 2x", () => {
    expect(snapToTier(12288)).toBe("16384");
    expect(snapToTier(24576)).toBe("32768");
  });

  it("低于网格下限 → 0.5x（只能向上取，没有更小的档）", () => {
    expect(snapToTier(4096)).toBe("8192");
    expect(snapToTier(3000)).toBe("8192");
    expect(snapToTier(1)).toBe("8192");
  });

  it("isUnofferedCap：不限恒不算「不在选项里」；合法但不提供的档位（1.5x）算", () => {
    expect(isUnofferedCap(null)).toBe(false);
    expect(isUnofferedCap(8192)).toBe(false);
    expect(isUnofferedCap(131072)).toBe(false);
    expect(isUnofferedCap(16000)).toBe(true);
    expect(isUnofferedCap(4096)).toBe(true);
    // 24,576 是**合法档位**（1.5x，构建侧放行）却不在下拉的五档里 —— 网格合法性 ≠ 下拉可选项，
    // 两者刻意不同源：前者是构建期闸门（scripts/lib/modelcap-grid.mjs），后者是管理台呈现。
    // 函数名原为 isOffGrid，与构建期网格同名 ⇒ 复核时改名，别再把两个集合混着说。
    expect(isUnofferedCap(24576)).toBe(true);
  });
});
