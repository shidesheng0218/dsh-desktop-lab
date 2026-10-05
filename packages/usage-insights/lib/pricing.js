/**
 * 价目表与成本估算。
 *
 * 为什么单独一个文件、还要在 UI 上反复标注「估算」：
 * 官方 287 个包里**没有任何货币计费概念**——`dsh-token-meter` 里唯一的
 * pricing 是图片 token 定价（`route-pricing.js`），而且它自己在 README 里写着
 * "Occupancy is a reference figure, not a billing record"，并告诫
 * "Present the composition rows as an approximate composition, never as a total"。
 *
 * 所以这里的钱数只能来自使用者自己填的价目表；没有配价目表时，
 * 本模块返回 null，UI 必须显式说明「未配置」，而不是拿一个内置数字冒充账单。
 */

/** 价格单位：每 100 万 token。 */
export const PRICE_UNIT_TOKENS = 1_000_000;

/** 官方 tokenUsage 投影里的四个互不重叠的桶。 */
export const TOKEN_BUCKETS = Object.freeze([
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]);

/**
 * 把使用者填的价目表条目规范化。
 * 接受 `{ input, output, cacheRead, cacheWrite }`，单位是「每 100 万 token」。
 * 缺失的桶按 0 计，非法值整体判为不可用（宁可不算，也不要算错）。
 * @param {unknown} entry
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}|null}
 */
export function normalizePrice(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const pick = (key) => {
    const value = entry[key];
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return value;
  };
  const input = pick('input');
  const output = pick('output');
  const cacheRead = pick('cacheRead');
  const cacheWrite = pick('cacheWrite');
  if ([input, output, cacheRead, cacheWrite].some((v) => v === undefined)) return null;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * 从价目表里取一条。
 *
 * 只有 `default` 会被用到：投影缓存里的 `tokenUsage` 只有四个 token 桶，
 * **不带路由/模型信息**，因此按模型分别计价在这一层是不可能的。
 * 这一点在 README 的「已知限制」里向使用者说明。
 * @param {Record<string, unknown>|undefined} pricing
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}|null}
 */
export function resolvePrice(pricing) {
  if (pricing === null || typeof pricing !== 'object') return null;
  return normalizePrice(pricing.default ?? pricing);
}

/**
 * 用四个 token 桶与一条价目表估算金额。
 * @param {{uncachedInputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}} tokens
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}|null} price
 * @returns {number|null} 金额；没有价目表时返回 null
 */
export function estimateCost(tokens, price) {
  if (price === null) return null;
  const amount =
    (tokens.uncachedInputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheWriteTokens * price.cacheWrite) /
    PRICE_UNIT_TOKENS;
  return Number.isFinite(amount) ? amount : null;
}
