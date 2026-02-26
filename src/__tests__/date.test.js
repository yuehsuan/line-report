import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  getNowTaipei,
  getMonthKey,
  getPrevMonthKey,
  getDateKey,
  toUtcIso,
  fromUtcIso,
} from '../lib/date.js';

// ─────────────────────────────────────────────
// getNowTaipei
// ─────────────────────────────────────────────
describe('getNowTaipei', () => {
  test('回傳的 DateTime 時區應為 Asia/Taipei', () => {
    const dt = getNowTaipei();
    assert.equal(dt.zoneName, 'Asia/Taipei');
  });

  test('回傳的 DateTime 是有效時間', () => {
    const dt = getNowTaipei();
    assert.ok(dt.isValid, `DateTime 應有效，但收到: ${dt.invalidReason}`);
  });
});

// ─────────────────────────────────────────────
// getMonthKey
// ─────────────────────────────────────────────
describe('getMonthKey', () => {
  test('一般月份：2026-02 正確補零', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 2, day: 15 }, { zone: 'Asia/Taipei' });
    assert.equal(getMonthKey(dt), '2026-02');
  });

  test('10 月以後不補零', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 10, day: 1 }, { zone: 'Asia/Taipei' });
    assert.equal(getMonthKey(dt), '2026-10');
  });

  test('1 月份格式：2026-01', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 1, day: 31 }, { zone: 'Asia/Taipei' });
    assert.equal(getMonthKey(dt), '2026-01');
  });
});

// ─────────────────────────────────────────────
// getPrevMonthKey（最重要的邊界測試）
// ─────────────────────────────────────────────
describe('getPrevMonthKey', () => {
  test('1 月的上月：跨年應回傳前一年的 12 月（不得為 0 月）', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 1, day: 15 }, { zone: 'Asia/Taipei' });
    const prev = getPrevMonthKey(dt);
    assert.equal(prev, '2025-12');
    assert.notEqual(prev, '2026-00', '1 月上月不得為 2026-00');
  });

  test('12 月的上月：應為同年 11 月', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 12, day: 1 }, { zone: 'Asia/Taipei' });
    assert.equal(getPrevMonthKey(dt), '2026-11');
  });

  test('一般月份：3 月的上月為 2 月', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 3, day: 1 }, { zone: 'Asia/Taipei' });
    assert.equal(getPrevMonthKey(dt), '2026-02');
  });

  test('2 月的上月：應為 1 月（不得為 00 月）', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 2, day: 28 }, { zone: 'Asia/Taipei' });
    const prev = getPrevMonthKey(dt);
    assert.equal(prev, '2026-01');
  });
});

// ─────────────────────────────────────────────
// getDateKey
// ─────────────────────────────────────────────
describe('getDateKey', () => {
  test('格式為 YYYY-MM-DD，月日補零', () => {
    const dt = DateTime.fromObject({ year: 2026, month: 2, day: 5 }, { zone: 'Asia/Taipei' });
    assert.equal(getDateKey(dt), '2026-02-05');
  });

  test('12 月 31 日格式正確', () => {
    const dt = DateTime.fromObject({ year: 2025, month: 12, day: 31 }, { zone: 'Asia/Taipei' });
    assert.equal(getDateKey(dt), '2025-12-31');
  });
});

// ─────────────────────────────────────────────
// toUtcIso / fromUtcIso
// ─────────────────────────────────────────────
describe('toUtcIso', () => {
  test('輸出應以 Z 結尾（UTC ISO 8601）', () => {
    const dt = DateTime.fromObject(
      { year: 2026, month: 2, day: 25, hour: 23, minute: 55, second: 0 },
      { zone: 'Asia/Taipei' }
    );
    const iso = toUtcIso(dt);
    assert.ok(iso.endsWith('Z'), `應以 Z 結尾，實際：${iso}`);
  });

  test('台北 23:55 轉 UTC 應為 15:55（UTC+8）', () => {
    const dt = DateTime.fromObject(
      { year: 2026, month: 2, day: 25, hour: 23, minute: 55, second: 0 },
      { zone: 'Asia/Taipei' }
    );
    const iso = toUtcIso(dt);
    assert.ok(iso.includes('T15:55'), `UTC 時間應含 T15:55，實際：${iso}`);
  });
});

describe('fromUtcIso', () => {
  test('還原後時區為 UTC', () => {
    const iso = '2026-02-25T15:55:00.000Z';
    const dt = fromUtcIso(iso);
    assert.equal(dt.zoneName, 'UTC');
    assert.equal(dt.hour, 15);
    assert.equal(dt.minute, 55);
  });
});
