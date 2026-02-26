import { createLogger } from './logger.js';

const log = createLogger({ module: 'pricing' });

/**
 * 依環境變數計算加購費用與總費用
 *
 * @param {number} totalUsage  當月總用量（來自 LINE consumption API，為近似值）
 * @returns {{
 *   additionalCount: number,
 *   fee: number,
 *   feeRounded: number,
 *   planFee: number,
 *   totalFeeRounded: number
 * }}
 */
export function calculateFee(totalUsage) {
  const freeQuota = parseInt(process.env.FREE_QUOTA || '0', 10);
  const model = process.env.PRICING_MODEL || 'single';
  const planFee = parseInt(process.env.PLAN_FEE || '0', 10);
  const additionalCount = Math.max(0, totalUsage - freeQuota);

  let fee = 0;

  if (model === 'single') {
    const unitPrice = parseFloat(process.env.SINGLE_UNIT_PRICE || '0.2');
    fee = additionalCount * unitPrice;
    log.debug({ model, additionalCount, unitPrice, fee, planFee }, '計費計算（single）');
  } else if (model === 'tiers') {
    const tiersJson = process.env.TIERS_JSON;
    if (!tiersJson) {
      throw new Error('PRICING_MODEL=tiers 時必須設定 TIERS_JSON');
    }
    const tiers = JSON.parse(tiersJson);
    fee = calcTiersFee(additionalCount, tiers);
    log.debug({ model, additionalCount, tiers, fee, planFee }, '計費計算（tiers）');
  } else {
    throw new Error(`不支援的 PRICING_MODEL: ${model}`);
  }

  const feeRounded = Math.round(fee);
  const totalFeeRounded = feeRounded + planFee;
  return { additionalCount, fee, feeRounded, planFee, totalFeeRounded };
}

/**
 * 依級距累進計算費用
 *
 * tiers 格式：[{ upTo: 10000, price: 0.2 }, { upTo: null, price: 0.15 }]
 * upTo=null 表示無上限最後一級
 *
 * @param {number} count  加購則數
 * @param {Array<{upTo: number|null, price: number}>} tiers
 * @returns {number}
 */
export function calcTiersFee(count, tiers) {
  let remaining = count;
  let fee = 0;
  let prevUpTo = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;

    const tierCapacity = tier.upTo === null ? Infinity : tier.upTo - prevUpTo;
    const consumed = Math.min(remaining, tierCapacity);
    fee += consumed * tier.price;
    remaining -= consumed;
    prevUpTo = tier.upTo ?? prevUpTo;
  }

  return fee;
}
