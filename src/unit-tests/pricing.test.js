import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calculateFee, calcTiersFee } from '../lib/pricing.js';

// 測試前備份並設定環境變數，測試後還原
const originalEnv = {};
const envKeys = [
  'FREE_QUOTA',
  'PRICING_MODEL',
  'SINGLE_UNIT_PRICE',
  'TIERS_JSON',
  'PLAN_FEE',
  'TAX_RATE',
];

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
  }
}

function resetEnv() {
  for (const k of envKeys) {
    if (originalEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = originalEnv[k];
    }
  }
}

before(() => {
  for (const k of envKeys) {
    originalEnv[k] = process.env[k];
  }
});

after(resetEnv);

// ─────────────────────────────────────────────
// calcTiersFee 純函式測試
// ─────────────────────────────────────────────
describe('calcTiersFee', () => {
  const tiers = [
    { upTo: 10000, price: 0.2 },
    { upTo: 50000, price: 0.18 },
    { upTo: null, price: 0.15 },
  ];

  test('0 則：fee=0', () => {
    assert.equal(calcTiersFee(0, tiers), 0);
  });

  test('第一級內（5000 則）：fee=1000', () => {
    assert.equal(calcTiersFee(5000, tiers), 1000);
  });

  test('剛好第一級滿（10000 則）：fee=2000', () => {
    assert.equal(calcTiersFee(10000, tiers), 2000);
  });

  test('跨越第一、二級（15000 則）：10000×0.2 + 5000×0.18 = 2900', () => {
    assert.equal(calcTiersFee(15000, tiers), 2900);
  });

  test('跨三級（55000 則）：10000×0.2 + 40000×0.18 + 5000×0.15 = 10_950', () => {
    const expected = 10000 * 0.2 + 40000 * 0.18 + 5000 * 0.15;
    assert.equal(calcTiersFee(55000, tiers), expected);
  });

  test('upTo=null 最後一級不拋出 TypeError', () => {
    assert.doesNotThrow(() => calcTiersFee(999999, tiers));
  });
});

// ─────────────────────────────────────────────
// calculateFee - single 模式
// ─────────────────────────────────────────────
describe('calculateFee - single 模式', () => {
  before(() => {
    setEnv({
      PRICING_MODEL: 'single',
      SINGLE_UNIT_PRICE: '0.2',
      FREE_QUOTA: '1000',
      TAX_RATE: '0.05',
    });
  });
  after(resetEnv);

  test('用量低於 free quota：additionalCount=0, fee=0', () => {
    const result = calculateFee(500);
    assert.equal(result.additionalCount, 0);
    assert.equal(result.fee, 0);
    assert.equal(result.feeRounded, 0);
  });

  test('用量等於 free quota：additionalCount=0, fee=0', () => {
    const result = calculateFee(1000);
    assert.equal(result.additionalCount, 0);
    assert.equal(result.fee, 0);
  });

  test('超出 500 則：additionalCount=500, fee=100', () => {
    const result = calculateFee(1500);
    assert.equal(result.additionalCount, 500);
    assert.equal(result.fee, 100);
    assert.equal(result.feeRounded, 100);
  });

  test('未稅加購費的元以下金額無條件捨去', () => {
    setEnv({ FREE_QUOTA: '1500', SINGLE_UNIT_PRICE: '0.2' });
    const result = calculateFee(1504);
    assert.equal(result.additionalCount, 4);
    assert.equal(result.fee, 0.8);
    assert.equal(result.feeRounded, 0);
    assert.equal(result.additionalFeeBeforeTax, 0);
  });
});

describe('calculateFee - OA 正式付款紀錄', () => {
  before(() => {
    setEnv({
      PRICING_MODEL: 'single',
      SINGLE_UNIT_PRICE: '0.2',
      FREE_QUOTA: '6000',
      PLAN_FEE: '1200',
      TAX_RATE: '0.05',
    });
  });
  after(resetEnv);

  const cases = [
    { totalUsage: 17677, beforeTax: 2335, tax: 117, taxIncluded: 2452 },
    { totalUsage: 14052, beforeTax: 1610, tax: 81, taxIncluded: 1691 },
    { totalUsage: 15441, beforeTax: 1888, tax: 94, taxIncluded: 1982 },
    { totalUsage: 15032, beforeTax: 1806, tax: 90, taxIncluded: 1896 },
    { totalUsage: 14188, beforeTax: 1637, tax: 82, taxIncluded: 1719 },
  ];

  for (const item of cases) {
    test(`${item.totalUsage} 則應對上 OA 加購扣款 ${item.taxIncluded} 元`, () => {
      const result = calculateFee(item.totalUsage);
      assert.equal(result.additionalFeeBeforeTax, item.beforeTax);
      assert.equal(result.additionalTax, item.tax);
      assert.equal(result.additionalFeeTaxIncluded, item.taxIncluded);
      assert.equal(result.planTax, 60);
      assert.equal(result.planFeeTaxIncluded, 1260);
      assert.equal(result.totalFeeTaxIncluded, item.taxIncluded + 1260);
    });
  }
});

// ─────────────────────────────────────────────
// calculateFee - tiers 模式
// ─────────────────────────────────────────────
describe('calculateFee - tiers 模式', () => {
  const tiersJson = JSON.stringify([
    { upTo: 10000, price: 0.2 },
    { upTo: null, price: 0.15 },
  ]);

  before(() => {
    setEnv({ PRICING_MODEL: 'tiers', FREE_QUOTA: '1000', TIERS_JSON: tiersJson });
  });
  after(resetEnv);

  test('超出 free quota 但在第一級內（9000 則加購）：fee=1800', () => {
    const result = calculateFee(10000);  // 10000 - 1000 = 9000
    assert.equal(result.additionalCount, 9000);
    assert.equal(result.fee, 1800);
  });

  test('跨越兩級（11000 則加購）：10000×0.2 + 1000×0.15 = 2150', () => {
    const result = calculateFee(12000);  // 12000 - 1000 = 11000
    assert.equal(result.additionalCount, 11000);
    assert.equal(result.fee, 2150);
  });

  test('TIERS_JSON 未設定時拋出錯誤', () => {
    delete process.env.TIERS_JSON;
    assert.throws(() => calculateFee(5000), /TIERS_JSON/);
    process.env.TIERS_JSON = tiersJson;
  });
});

// ─────────────────────────────────────────────
// calculateFee - PLAN_FEE 方案月費
// ─────────────────────────────────────────────
describe('calculateFee - PLAN_FEE 方案月費', () => {
  before(() => {
    setEnv({
      PRICING_MODEL: 'single',
      SINGLE_UNIT_PRICE: '0.2',
      FREE_QUOTA: '1000',
      TAX_RATE: '0.05',
    });
  });
  after(resetEnv);

  test('PLAN_FEE 未設定時 planFee=0，totalFeeRounded 等於 feeRounded', () => {
    delete process.env.PLAN_FEE;
    const result = calculateFee(1500); // additionalCount=500, fee=100
    assert.equal(result.planFee, 0);
    assert.equal(result.feeRounded, 100);
    assert.equal(result.totalFeeRounded, 100);
  });

  test('PLAN_FEE=1200，totalFeeRounded = feeRounded + 1200', () => {
    setEnv({ PLAN_FEE: '1200' });
    const result = calculateFee(1500); // additionalCount=500, fee=100
    assert.equal(result.planFee, 1200);
    assert.equal(result.feeRounded, 100);
    assert.equal(result.planTax, 60);
    assert.equal(result.planFeeTaxIncluded, 1260);
    assert.equal(result.totalFeeRounded, 1300);
    assert.equal(result.totalTax, 65);
    assert.equal(result.totalFeeTaxIncluded, 1365);
  });

  test('用量低於 free quota 但有 PLAN_FEE：totalFeeRounded 只含方案費', () => {
    setEnv({ PLAN_FEE: '1200' });
    const result = calculateFee(500); // additionalCount=0, fee=0
    assert.equal(result.additionalCount, 0);
    assert.equal(result.feeRounded, 0);
    assert.equal(result.planFee, 1200);
    assert.equal(result.planFeeTaxIncluded, 1260);
    assert.equal(result.totalFeeRounded, 1200);
    assert.equal(result.totalFeeTaxIncluded, 1260);
  });
});

// ─────────────────────────────────────────────
// calculateFee - 不支援的模式
// ─────────────────────────────────────────────
describe('calculateFee - 錯誤處理', () => {
  test('不支援的 PRICING_MODEL 拋出錯誤', () => {
    setEnv({ PRICING_MODEL: 'unknown', FREE_QUOTA: '0' });
    assert.throws(() => calculateFee(100), /不支援的 PRICING_MODEL/);
    resetEnv();
  });

  test('TAX_RATE 非數字時拋出錯誤', () => {
    setEnv({ PRICING_MODEL: 'single', FREE_QUOTA: '0', TAX_RATE: 'invalid' });
    assert.throws(() => calculateFee(100), /TAX_RATE/);
    resetEnv();
  });
});
