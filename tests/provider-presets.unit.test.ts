// preset 档案整表 schema 校验（09-28-upstream-custom-type-passthrough 批次 5，design §2.4）。
//
// preset 是代码 const、不走 render 生成 —— render-modelcaps 的 fail-fast 精神由本文件承担：
// 坏一条档案（面键非法 / URL 缺路径 / 枚举漂移 / 复制粘贴的重复档案）这里就红，而不是等
// 管理台预填出一条解析层拒收的记录。
//
// 判别力说明（quality spec「断言须锁效果」）：
//   · schema 校验只挡「形态」，本文件还挡**内容级**退化 —— 两两不等断言刻意剔除身份字段
//    （id/label/source/reviewedAt/notes），只比内容（baseUrl/faces/超时）：若只比全量 JSON，
//     id 不同恒不等，是永远不会失败的恒真断言（本仓库点名的假绿形态）。
//   · resolver 交叉验证是**全链路 teeth**：预填产物必须能被解析真源（parseResolvedEndpoints）
//     消费 —— 否则「选中模板 → 保存」会在运行时炸出 EndpointResolutionError。
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, providerPresetArchiveSchema } from "../src/providers/presets";
import { parseResolvedEndpoints } from "../src/providers/endpoints";
import { presetToFormFill } from "../app/modules/providers/form";
import { providerProtocolsSchema } from "../src/routes/providers/types";

describe("preset 整表 schema 校验（design §2.4 fail-fast 等价物）", () => {
  it("每条档案都过档案 schema（面键白名单 / 枚举值 / URL / reviewedAt 格式）", () => {
    for (const preset of PROVIDER_PRESETS) {
      const parsed = providerPresetArchiveSchema.safeParse(preset);
      expect(parsed.success, `preset '${preset.id}' failed schema validation`).toBe(true);
    }
  });

  it("批次 5 的七条档案一条不少，id 两两唯一", () => {
    // 锁定档案集本身：新增/删除档案必须是有意识的动作（本测试随裁决更新），不是静默漂移。
    expect([...PROVIDER_PRESETS.map((p) => p.id)].sort()).toEqual(
      ["b.ai", "deepseek", "kimi", "minimax", "moonshot", "openrouter", "z.ai"].sort(),
    );
    expect(new Set(PROVIDER_PRESETS.map((p) => p.id)).size).toBe(PROVIDER_PRESETS.length);
  });

  it("每条档案至少声明一个面 + source/reviewedAt 在场（漂移风险 §5 #3 的落点）", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(Object.keys(preset.faces).length, `preset '${preset.id}' has no faces`).toBeGreaterThan(0);
      expect(preset.source, `preset '${preset.id}' missing source`).toMatch(/\.md/);
      // reviewedAt 格式 schema 已锁（YYYY-MM-DD）；这里断言它**不晚于今天** ——
      // 人工核定日期写在未来的档案只能是笔误。parseable 只是前提（真比较在下一行），
      // 09-28 批次 5 复核补：原断言只验「可解析」，注释承诺的「不晚于今天」从未被兑现。
      const parsedAt = Date.parse(preset.reviewedAt);
      expect(Number.isNaN(parsedAt), `preset '${preset.id}' reviewedAt is not a date`).toBe(false);
      expect(parsedAt, `preset '${preset.id}' reviewedAt is in the future`).toBeLessThanOrEqual(Date.now());
    }
  });

  it("档案两两不等（剔除身份字段后比内容）——复制粘贴改名档在这里红", () => {
    const at = (i: number) => {
      const p = PROVIDER_PRESETS[i];
      if (p === undefined) {
        throw new Error(`preset at index ${i} missing`);
      }
      return p;
    };
    for (let i = 0; i < PROVIDER_PRESETS.length; i++) {
      for (let j = i + 1; j < PROVIDER_PRESETS.length; j++) {
        const a = at(i);
        const b = at(j);
        const content = (p: typeof a) =>
          JSON.stringify({ baseUrl: p.baseUrl, faces: p.faces, timeout: p.suggestedTimeoutMs });
        expect(content(a), `presets '${a.id}' and '${b.id}' are content-identical`).not.toBe(
          content(b),
        );
      }
    }
  });

  it("baseUrl 形态：一律带完整路径（09-17 事故的形态约定），文档化的根 base 显式豁免", () => {
    // baseurl-shape-finding.md §2.2：openai 面字面拼接不补 /v1 —— bare origin 的 baseUrl
    // 就是那次 stg 事故（/api 全挂）的根因形态。豁免名单只收**官方文档明文**的根 base
    //（deepseek responses：base_url 与 chat 同根、端点 /responses 由解析层拼接）；
    // 新档案想进豁免名单必须先补官方证据。
    const ROOT_BASE_ALLOWLIST = new Set(["deepseek.responses"]);
    for (const preset of PROVIDER_PRESETS) {
      const entries: Array<[string, string]> = [["", preset.baseUrl]];
      for (const [face, declared] of Object.entries(preset.faces)) {
        if (declared?.baseUrl !== undefined) {
          entries.push([face, declared.baseUrl]);
        }
      }
      for (const [face, url] of entries) {
        const pathname = new URL(url).pathname;
        const isExempt = ROOT_BASE_ALLOWLIST.has(face === "" ? preset.id : `${preset.id}.${face}`);
        if (!isExempt) {
          expect(
            pathname.length > 1,
            `preset '${preset.id}'${face ? ` face '${face}'` : ""} baseUrl '${url}' is a bare origin`,
          ).toBe(true);
        }
      }
    }
  });

  it("全链路 teeth：预填产物能被解析真源消费（custom 记录不炸 EndpointResolutionError）", () => {
    for (const preset of PROVIDER_PRESETS) {
      const patch = presetToFormFill(preset);
      // patch.protocolsText 先过与创建路由同一份面契约（authStyle 剥除后的形态）
      const protocolsText = patch.protocolsText ?? "";
      expect(protocolsText.length > 0, `preset '${preset.id}' prefill has no protocols`).toBe(true);
      const protocols = providerProtocolsSchema.safeParse(JSON.parse(protocolsText));
      expect(protocols.success, `preset '${preset.id}' prefill failed face contract`).toBe(true);
      if (!protocols.success) {
        continue;
      }
      // 解析真源消费建档产物：type=custom + 预填 protocols ⇒ 端点解析成功且逐面保真
      let resolved: ReturnType<typeof parseResolvedEndpoints>;
      try {
        resolved = parseResolvedEndpoints({
          type: "custom",
          baseUrl: patch.baseUrl ?? "",
          protocols: JSON.stringify(protocols.data),
        });
      } catch (error) {
        throw new Error(
          `preset '${preset.id}' prefill is not consumable by parseResolvedEndpoints: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      expect(resolved.length, `preset '${preset.id}' resolved no endpoints`).toBeGreaterThan(0);
      expect([...resolved.map((e) => e.face)].sort()).toEqual(
        [...Object.keys(protocols.data)].sort(),
      );
      for (const endpoint of resolved) {
        // verbatim 面 = 字节直通（streamPassthrough 是独立属性，不是 policy 的影子）
        expect(endpoint.streamPassthrough).toBe(endpoint.policy === "verbatim");
      }
    }
  });
});
