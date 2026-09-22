// 账户安全开关的纯函数单测（09-21-email-admin-promotion-switch，design §3.1）：无 DB、无 env。
//
// 为什么这块必须是纯函数测试：miniflare bindings 在测试进程内固定，逐用例改 env 是否对 worker
// 生效本身是要单独验证的机制（implement.md 步骤 3）。判据与解析的**规格**在这里定死，
// 路由级测试只负责证明「这规格确实被接在写边界上」。
//
// ⚠ 真值表是**手写常量**而非按实现公式推导 —— 用同一个公式生成期望值 = 恒真假绿（自证）。
import { describe, expect, it } from "vitest";
import {
  ADMIN_PROMOTION_BLOCKED_MESSAGE,
  ADMIN_PROMOTION_BLOCKED_REASON,
  ADMIN_PROMOTION_POLICY_NOTICE,
  isEmailAccountAdminPromotionEnabled,
  shouldBlockAdminPromotion,
  type PromotionRole,
} from "../src/lib/admin-promotion-policy";

describe("isEmailAccountAdminPromotionEnabled（EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED → 布尔）", () => {
  it("未配置 / 空 / 空白 → 关闭（缺省即关闭，fail-closed）", () => {
    expect(isEmailAccountAdminPromotionEnabled(undefined)).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("   ")).toBe(false);
  });

  it("false / 0 / off / no / 任意乱串 → 关闭（关闭是吸收态：任何不认识的值都落到这里）", () => {
    expect(isEmailAccountAdminPromotionEnabled("false")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("FALSE")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("0")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("off")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("no")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("nope")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("2")).toBe(false);
    // 只认四个正词；「差不多」的串不认（"tru" / "y" / "enable" 都不开）
    expect(isEmailAccountAdminPromotionEnabled("tru")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("y")).toBe(false);
    expect(isEmailAccountAdminPromotionEnabled("enable")).toBe(false);
  });

  it("true / 1 / yes / on（大小写与首尾空白不敏感）→ 开启", () => {
    expect(isEmailAccountAdminPromotionEnabled("true")).toBe(true);
    expect(isEmailAccountAdminPromotionEnabled("TRUE")).toBe(true);
    expect(isEmailAccountAdminPromotionEnabled(" true ")).toBe(true);
    expect(isEmailAccountAdminPromotionEnabled("1")).toBe(true);
    expect(isEmailAccountAdminPromotionEnabled("yes")).toBe(true);
    expect(isEmailAccountAdminPromotionEnabled("ON")).toBe(true);
  });
});

describe("shouldBlockAdminPromotion（唯一判据的真值表）", () => {
  // [开关, 请求角色, 当前角色, 目标有邮箱凭据行, 期望是否拦]
  // 24 行 = 2 × 3 × 2 × 2 全空间，逐行手写。带 ★ 的四行是语义锚点。
  type Row = [boolean, PromotionRole | undefined, PromotionRole, boolean, boolean];
  const TABLE: Row[] = [
    // ---- 开关关闭（默认部署态）----
    [false, "admin", "member", true, true], // ★ 唯一该拦的形态：关闭 + 提升 + 目标还没升 + 邮箱注册
    [false, "admin", "member", false, false], // ★ 判别性：GitHub-only 账户照常可提升（不是一刀切）
    [false, "admin", "admin", true, false], // 幂等 no-op：已是 admin，不构成提升（不倒查存量）
    [false, "admin", "admin", false, false],
    [false, "member", "admin", true, false], // ★ 方向性：降级不受影响
    [false, "member", "admin", false, false],
    [false, "member", "member", true, false], // 写 member（无变化）
    [false, "member", "member", false, false],
    [false, undefined, "member", true, false], // 仅改 status（不带 role）
    [false, undefined, "member", false, false],
    [false, undefined, "admin", true, false],
    [false, undefined, "admin", false, false],
    // ---- 开关开启（能力保留）----
    [true, "admin", "member", true, false], // ★ 开启时邮箱注册账户可提升（证伪「实现成无条件拒绝」）
    [true, "admin", "member", false, false],
    [true, "admin", "admin", true, false],
    [true, "admin", "admin", false, false],
    [true, "member", "admin", true, false],
    [true, "member", "admin", false, false],
    [true, "member", "member", true, false],
    [true, "member", "member", false, false],
    [true, undefined, "member", true, false],
    [true, undefined, "member", false, false],
    [true, undefined, "admin", true, false],
    [true, undefined, "admin", false, false],
  ];

  for (const [enabled, requestedRole, currentRole, hasCredential, expected] of TABLE) {
    it(`开关=${enabled ? "开" : "关"} 请求=${requestedRole ?? "无"} 当前=${currentRole} 邮箱账户=${hasCredential} → ${expected ? "拦" : "放行"}`, () => {
      expect(
        shouldBlockAdminPromotion({
          promotionEnabled: enabled,
          requestedRole,
          currentRole,
          targetHasEmailCredential: hasCredential,
        }),
      ).toBe(expected);
    });
  }

  it("真值表含恰好 1 个「拦」的组合（拦住面必须窄：只有关闭+提升+未升+邮箱注册）", () => {
    const blocked = TABLE.filter(([, , , , expected]) => expected).length;
    expect(blocked).toBe(1);
  });
});

describe("文案红线（AC15：三条文案必须与实现同口径）", () => {
  const ALL = [
    ADMIN_PROMOTION_BLOCKED_MESSAGE,
    ADMIN_PROMOTION_POLICY_NOTICE,
    ADMIN_PROMOTION_BLOCKED_REASON,
  ];

  it("三条各自都要说到「提升」与「邮箱注册」——用户看的就是这两个词", () => {
    for (const text of ALL) {
      expect(text).toMatch(/promot/i);
      expect(text).toMatch(/email/i);
    }
  });

  it("页面级说明必须说出「存量 admin 不受影响」——少说这句，管理员会以为自己的账号有危险", () => {
    expect(ADMIN_PROMOTION_POLICY_NOTICE).toMatch(/unaffected|already/i);
  });

  it("五条禁用词零命中：降级/移除/删除/永久/从未 —— 开关是可翻转的部署设置，不是对这个账户的永久判决", () => {
    // 逐条断言到具体串（而不是 /demot|remov|…/ 一条正则），失败时能直接看出是哪条文案踩了哪个词
    for (const text of ALL) {
      expect(text).not.toMatch(/demot/i);
      expect(text).not.toMatch(/remov/i);
      expect(text).not.toMatch(/delet/i);
      expect(text).not.toMatch(/permanent/i);
      expect(text).not.toMatch(/never/i);
    }
  });

  it("界面文案一律英文（仓库既有 UI 体例；出现中日韩字符即漏翻）", () => {
    for (const text of ALL) {
      expect(text).not.toMatch(/[一-鿿]/);
    }
  });

  it("三条两两不同串（服务端报文 / 页面说明 / 行级原因各有各的受众，照抄一句会丢掉一侧要说的）", () => {
    expect(new Set(ALL).size).toBe(3);
  });
});
