import { createLogger } from './logger.js';

const log = createLogger({ module: 'pricing' });

/**
 * 依環境變數計算加購費用與總費用
 *
 * @param {number} totalUsage  當月計費訊息總用量
 * @returns {{
 *   additionalCount: number,
 *   fee: number,
 *   feeRounded: number,
 *   additionalFeeBeforeTax: number,
 *   additionalTax: number,
 *   additionalFeeTaxIncluded: number,
 *   planFee: number,
 *   planTax: number,
 *   planFeeTaxIncluded: number,
 *   totalFeeRounded: number,
 *   totalTax: number,
 *   totalFeeTaxIncluded: number
 * }}
 */
export function calculateFee(totalUsage) {
  const freeQuota = parseInt(process.env.FREE_QUOTA || '0', 10);
  const model = process.env.PRICING_MODEL || 'single';
  const planFee = parseInt(process.env.PLAN_FEE || '0', 10);
  const taxRate = parseFloat(process.env.TAX_RATE || '0.05');
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    throw new Error('TAX_RATE 必須是大於或等於 0 的數字');
  }
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

  // LINE OA 先將未稅加購費的元以下金額捨去，再對整數未稅金額計算稅額。
  const additionalFeeBeforeTax = Math.floor(fee);
  const additionalTax = Math.round(additionalFeeBeforeTax * taxRate);
  const additionalFeeTaxIncluded = additionalFeeBeforeTax + additionalTax;
  const planTax = Math.round(planFee * taxRate);
  const planFeeTaxIncluded = planFee + planTax;
  const totalFeeBeforeTax = additionalFeeBeforeTax + planFee;
  const totalTax = additionalTax + planTax;
  const totalFeeTaxIncluded = additionalFeeTaxIncluded + planFeeTaxIncluded;

  // 保留既有欄位名稱，避免舊的 job_runs 查詢失效；兩者皆代表未稅整數金額。
  const feeRounded = additionalFeeBeforeTax;
  const totalFeeRounded = totalFeeBeforeTax;
  return {
    additionalCount,
    fee,
    feeRounded,
    additionalFeeBeforeTax,
    additionalTax,
    additionalFeeTaxIncluded,
    planFee,
    planTax,
    planFeeTaxIncluded,
    totalFeeRounded,
    totalTax,
    totalFeeTaxIncluded,
  };
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
