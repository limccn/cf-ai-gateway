// /api/models 读写分权 + 角色投影（批次 P，09-14-admin-ui-adjustments-2，D17–D20）。
//
// 这个文件守的是**四件互不重叠**的事，每件都配了它的"对照"：
//   ① 写动词的角色门 —— 靠 router.ts 的 `app.use("*", adminOnly())`，而那一行**顺序敏感**：
//      把它挪到文件末尾会让 GET 仍受保护、POST/PATCH/DELETE 变成**全员可写且静默**。
//      故这里必须有「member 三个写动词全 403」+「admin 全 200」的成对断言 —— 只看 GET 的
//      200/403 是查不出这个错的。
//   ② 行过滤（D18）：member 少**恰好一行**，且 admin 那半是**对照**（防「永远过滤」——
//      那会让 admin 也看不见自己刚隐藏的行，而功能看着"正常"）。
//   ③ 价格置 0（D20）：免费行的 5 个价在 member 的响应里是 0、在 admin 的响应里是真价；
//      同时非免费行的价对 member **原样**（防「member 的价格一律置 0」这种过度实现）。
//   ④ 开关 ≠ 改价（D17 的用户红线）：`PATCH {freeMode:true}` 之后**直查库**，5 个价列一字未变。
//
// 写请求体一律**合法**：403 必须是「鉴权拒绝」，而不是「校验失败」的副产品 —— 否则把
// adminOnly 换成 zValidator 也会让 403 "看起来还在"（断言效果，别只断言状态码的存在）。
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { createDb } from "../src/db";
import { models } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setModelFlags,
  setupPrice,
  setupUser,
} from "./helpers";

const BASE = "http://localhost/api/models";

/** 正常行：member 可见、价格原样。 */
const VISIBLE = "models-api-visible";
const VISIBLE_PRICES = [1, 2, 3, 4, 5] as const;
/** 隐藏行（D18）：member 的响应里**整行不存在**。 */
const HIDDEN = "models-api-hidden";
/** 免费行（D17）：库里留着真价，member 拿到 0。 */
const FREE = "models-api-free";
const FREE_REAL_PRICES = [7, 8, 9, 10, 11] as const;
/**
 * 专供「开关」用例翻转的行。
 *
 * 为什么不拿 VISIBLE 来翻：那条用例中途会 `expect(member 看到 0)` —— 断言失败时后面的
 * 复位语句就执行不到，VISIBLE 的 freeMode 残留为 true，于是**后面**的「非免费行原样」
 * 也因为同一个原因变红（一个缺陷报两次红，还多出一条假现场）。独立的行把这份耦合切断。
 */
const TOGGLE = "models-api-toggle";
const TOGGLE_PRICES = [3, 6, 0.3, 12, 18] as const;

interface ModelItem {
  id: number;
  model: string;
  inputPriceShort: number;
  inputPriceLong: number;
  inputPriceCached: number;
  outputPriceShort: number;
  outputPriceLong: number;
  maxOutputTokens: number | null;
  freeMode: boolean;
  hiddenFromMembers: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListBody {
  success: boolean;
  items: ModelItem[];
  total: number;
}

let adminCookie: string;
let memberCookie: string;
let visibleId: number;
let toggleId: number;

async function listAs(cookie: string | null): Promise<{ status: number; body: ListBody | null }> {
  const res = await selfFetch(BASE, cookie ? { headers: { Cookie: cookie } } : undefined);
  const body = res.status === 200 ? ((await res.json()) as ListBody) : null;
  return { status: res.status, body };
}

/** 取某一行的价格五元组。 */
function pricesOf(item: ModelItem): number[] {
  return [
    item.inputPriceShort,
    item.inputPriceLong,
    item.inputPriceCached,
    item.outputPriceShort,
    item.outputPriceLong,
  ];
}

/** 从列表里取某一行；找不到直接抛（比 `undefined.toBe` 有信息量）。 */
function itemOf(body: ListBody, model: string): ModelItem {
  const item = body.items.find((i) => i.model === model);
  if (!item) {
    throw new Error(`响应里没有 ${model}：${body.items.map((i) => i.model).join(", ")}`);
  }
  return item;
}

/** 直查库里的价格五元组（绕过 API —— 证明「库里没被改」，而不是「响应里没变」）。 */
async function dbPrices(model: string): Promise<number[]> {
  const db = createDb(env);
  const row = await db.query.models.findFirst({ where: eq(models.model, model) });
  if (!row) {
    throw new Error(`库里没有 ${model}`);
  }
  return [
    row.inputPriceShort,
    row.inputPriceLong,
    row.inputPriceCached,
    row.outputPriceShort,
    row.outputPriceLong,
  ];
}

const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(async () => {
  await applyMigrations();

  await setupPrice(VISIBLE, ...VISIBLE_PRICES);
  await setupPrice(HIDDEN, 1, 1, 1, 1, 1);
  await setupPrice(FREE, ...FREE_REAL_PRICES);
  await setupPrice(TOGGLE, ...TOGGLE_PRICES);
  await setModelFlags(HIDDEN, { hiddenFromMembers: true });
  await setModelFlags(FREE, { freeMode: true });

  const db = createDb(env);
  const visible = await db.query.models.findFirst({ where: eq(models.model, VISIBLE) });
  const toggle = await db.query.models.findFirst({ where: eq(models.model, TOGGLE) });
  if (!visible || !toggle) {
    throw new Error("夹具未就绪：VISIBLE / TOGGLE 行不存在");
  }
  visibleId = visible.id;
  toggleId = toggle.id;

  const adminId = await setupUser("models-api-admin@test.dev", 0, "admin");
  const memberId = await setupUser("models-api-member@test.dev", 0);
  adminCookie = sessionCookie(await createSession(adminId));
  memberCookie = sessionCookie(await createSession(memberId));
});

describe("读写分权（router.ts 的顺序敏感形状）", () => {
  it("匿名：四个动词全 401（requireSession 在 index.ts 对 /api/* 全局挂）", async () => {
    const get = await selfFetch(BASE);
    expect(get.status).toBe(401);

    const post = await selfFetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: "models-api-anon",
        inputPriceShort: 1,
        inputPriceLong: 1,
        inputPriceCached: 1,
        outputPriceShort: 1,
        outputPriceLong: 1,
      }),
    });
    expect(post.status).toBe(401);

    const patch = await selfFetch(`${BASE}/${visibleId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ inputPriceShort: 1 }),
    });
    expect(patch.status).toBe(401);

    const del = await selfFetch(`${BASE}/${visibleId}`, { method: "DELETE" });
    expect(del.status).toBe(401);
  });

  it("member：GET 200（批次 P 的放行点）", async () => {
    const res = await listAs(memberCookie);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
  });

  it("member：POST / PATCH / DELETE 全 403（adminOnly 盖住写路径）", async () => {
    // 请求体合法：403 若变成 400 说明中间件被挪到校验之后（同样得红）
    const post = await selfFetch(BASE, {
      method: "POST",
      headers: { Cookie: memberCookie, ...JSON_HEADERS },
      body: JSON.stringify({
        model: "models-api-member-created",
        inputPriceShort: 1,
        inputPriceLong: 1,
        inputPriceCached: 1,
        outputPriceShort: 1,
        outputPriceLong: 1,
      }),
    });
    expect(post.status).toBe(403);

    const patch = await selfFetch(`${BASE}/${visibleId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, ...JSON_HEADERS },
      body: JSON.stringify({ inputPriceShort: 1 }),
    });
    expect(patch.status).toBe(403);

    const del = await selfFetch(`${BASE}/${visibleId}`, {
      method: "DELETE",
      headers: { Cookie: memberCookie },
    });
    expect(del.status).toBe(403);

    // 效果断言：那一行确实还在（403 不是"删了但报了个错"）
    expect(await dbPrices(VISIBLE)).toEqual([...VISIBLE_PRICES]);
  });

  it("admin：GET / POST / PATCH / DELETE 全 200（对照 —— 403 不是因为路径写错了）", async () => {
    const get = await listAs(adminCookie);
    expect(get.status).toBe(200);

    const created = await selfFetch(BASE, {
      method: "POST",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({
        model: "models-api-throwaway",
        inputPriceShort: 1,
        inputPriceLong: 1,
        inputPriceCached: 1,
        outputPriceShort: 1,
        outputPriceLong: 1,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { model: ModelItem };
    expect(createdBody.model.model).toBe("models-api-throwaway");
    // 创建路径刻意不暴露两个标记（见 src/routes/models/types.ts）：新行一律取列默认
    expect(createdBody.model.freeMode).toBe(false);
    expect(createdBody.model.hiddenFromMembers).toBe(false);

    const patch = await selfFetch(`${BASE}/${createdBody.model.id}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({ outputPriceShort: 2 }),
    });
    expect(patch.status).toBe(200);

    const del = await selfFetch(`${BASE}/${createdBody.model.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(del.status).toBe(200);
  });
});

describe("两个行标记（PATCH 的开关语义）", () => {
  it("PATCH {freeMode:true} → 200，且直查库 5 个价列一字未变（D17 红线：开关 ≠ 改价）", async () => {
    const before = await dbPrices(TOGGLE);
    expect(before).toEqual([...TOGGLE_PRICES]);

    const res = await selfFetch(`${BASE}/${toggleId}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({ freeMode: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: ModelItem };
    expect(body.model.freeMode).toBe(true);

    // 库里的价没动（用户红线：只加标记列，5 个价列一字不动）
    expect(await dbPrices(TOGGLE)).toEqual(before);
    // 而 member 立刻看到 0 —— 证明"有效价"这条路真的通过标记生效了
    const member = await listAs(memberCookie);
    expect(pricesOf(itemOf(member.body as ListBody, TOGGLE))).toEqual([0, 0, 0, 0, 0]);

    await setModelFlags(TOGGLE, { freeMode: false });
  });

  it("PATCH {hiddenFromMembers:true} 也能过 refine（漏了它就是 400）", async () => {
    const post = await selfFetch(BASE, {
      method: "POST",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({
        model: "models-api-flag-toggle",
        inputPriceShort: 1,
        inputPriceLong: 1,
        inputPriceCached: 1,
        outputPriceShort: 1,
        outputPriceLong: 1,
      }),
    });
    expect(post.status).toBe(200);
    const { model } = (await post.json()) as { model: ModelItem };

    const patch = await selfFetch(`${BASE}/${model.id}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({ hiddenFromMembers: true }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { model: ModelItem };
    expect(patched.model.hiddenFromMembers).toBe(true);
    // 只传一个标记不该顺手改另一个
    expect(patched.model.freeMode).toBe(false);

    // 收尾：删掉这行，免得给后面的列表断言添噪音
    const del = await selfFetch(`${BASE}/${model.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(del.status).toBe(200);
  });

  it("PATCH 空对象 → 400（对照组：refine 放宽了字段集，「至少改一项」仍在）", async () => {
    const res = await selfFetch(`${BASE}/${visibleId}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, ...JSON_HEADERS },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("角色投影（D18 行过滤 / D20 价格置 0）", () => {
  it("member 少恰好一行（被隐藏那行），admin 全见 —— 两半都要，否则「永远过滤」也会绿", async () => {
    const admin = await listAs(adminCookie);
    const member = await listAs(memberCookie);
    const adminBody = admin.body as ListBody;
    const memberBody = member.body as ListBody;

    expect(adminBody.items.some((i) => i.model === HIDDEN)).toBe(true);
    expect(memberBody.items.some((i) => i.model === HIDDEN)).toBe(false);
    expect(adminBody.items.length - memberBody.items.length).toBe(1);

    // total 必须与 items 同源：它要漏了过滤，member 就能从 `total` 读出「还有一行藏着」
    expect(adminBody.total).toBe(adminBody.items.length);
    expect(memberBody.total).toBe(memberBody.items.length);
  });

  it("免费行：member 拿到 5 个 0，admin 拿到库里的真价（成对，防「一律置 0」）", async () => {
    const admin = await listAs(adminCookie);
    const member = await listAs(memberCookie);

    expect(pricesOf(itemOf(admin.body as ListBody, FREE))).toEqual([...FREE_REAL_PRICES]);
    expect(pricesOf(itemOf(member.body as ListBody, FREE))).toEqual([0, 0, 0, 0, 0]);
    // 置 0 只发生在响应的投影里，库里的真价没动
    expect(await dbPrices(FREE)).toEqual([...FREE_REAL_PRICES]);
  });

  it("非免费行对 member 原样（防「member 看到的价格一律置 0」这种过度实现）", async () => {
    const member = await listAs(memberCookie);
    const row = itemOf(member.body as ListBody, VISIBLE);
    expect(pricesOf(row)).toEqual([...VISIBLE_PRICES]);
    expect(row.freeMode).toBe(false);
    expect(row.hiddenFromMembers).toBe(false);
  });

  it("admin 的响应里带两个标记本身（前端据此渲染 Free / Hidden 徽章与按下态）", async () => {
    const admin = await listAs(adminCookie);
    const body = admin.body as ListBody;
    expect(itemOf(body, FREE).freeMode).toBe(true);
    expect(itemOf(body, HIDDEN).hiddenFromMembers).toBe(true);
  });
});
