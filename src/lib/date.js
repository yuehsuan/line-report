import { DateTime } from 'luxon';

const TAIPEI_TZ = 'Asia/Taipei';

/**
 * 取得目前台北時間的 DateTime 物件
 */
export function getNowTaipei() {
  return DateTime.now().setZone(TAIPEI_TZ);
}

/**
 * 由 DateTime 取得月份鍵值（YYYY-MM），補零
 * @param {DateTime} dt
 * @returns {string} e.g. "2026-02"
 */
export function getMonthKey(dt) {
  return dt.toFormat('yyyy-MM');
}

/**
 * 取得上一個月的月份鍵值（YYYY-MM），正確處理跨年邊界
 * @param {DateTime} dt
 * @returns {string} e.g. "2025-12"（當 dt 為 2026-01 時）
 */
export function getPrevMonthKey(dt) {
  return getMonthKey(dt.minus({ months: 1 }));
}

/**
 * 取得日期鍵值（YYYY-MM-DD），以台北時間
 * @param {DateTime} dt
 * @returns {string} e.g. "2026-02-25"
 */
export function getDateKey(dt) {
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * 將 DateTime 轉為 UTC ISO 8601 字串（存 DB 用）
 * @param {DateTime} dt
 * @returns {string} e.g. "2026-02-25T15:55:00.000Z"
 */
export function toUtcIso(dt) {
  return dt.toUTC().toISO();
}

/**
 * 將 UTC ISO 字串還原為 DateTime
 * @param {string} isoStr
 * @returns {DateTime}
 */
export function fromUtcIso(isoStr) {
  return DateTime.fromISO(isoStr, { zone: 'utc' });
}
