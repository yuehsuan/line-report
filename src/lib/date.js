import { DateTime } from 'luxon';

const TAIPEI_TZ = 'Asia/Taipei';
const TOKYO_TZ = 'Asia/Tokyo';

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

/**
 * 取得指定月份的所有日期字串（YYYY-MM-DD），以指定時區計算。
 * @param {string} monthKey
 * @param {string} [zone=TAIPEI_TZ]
 * @returns {string[]}
 */
export function getMonthDates(monthKey, zone = TAIPEI_TZ) {
  const start = DateTime.fromFormat(monthKey, 'yyyy-MM', { zone }).startOf('month');
  if (!start.isValid) {
    throw new Error(`無效的 monthKey: ${monthKey}`);
  }

  const days = [];
  let cursor = start;
  const end = start.endOf('month').startOf('day');
  while (cursor <= end) {
    days.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

/**
 * 將 YYYY-MM-DD 轉為 LINE insight API 所需的 yyyyMMdd（UTC+9 / Tokyo）
 * @param {string} dateKey
 * @returns {string}
 */
export function toLineInsightDate(dateKey) {
  const dt = DateTime.fromFormat(dateKey, 'yyyy-MM-dd', { zone: TOKYO_TZ });
  if (!dt.isValid) {
    throw new Error(`無效的 dateKey: ${dateKey}`);
  }
  return dt.toFormat('yyyyMMdd');
}

/**
 * 取得台北時間某日結束前的時間點，並轉為 UTC ISO，用於回補寫入 snapshot ts。
 * @param {string} dateKey
 * @returns {string}
 */
export function getBackfillTs(dateKey) {
  const dt = DateTime.fromFormat(dateKey, 'yyyy-MM-dd', { zone: TAIPEI_TZ })
    .set({ hour: 23, minute: 58, second: 0, millisecond: 0 });
  if (!dt.isValid) {
    throw new Error(`無效的 dateKey: ${dateKey}`);
  }
  return dt.toUTC().toISO();
}

/**
 * 取得 live snapshot 的寫入時間，避開 historical_backfill 保留的 23:58:00 slot。
 * @param {DateTime} dt
 * @returns {string}
 */
export function getLiveSnapshotTs(dt) {
  const adjusted = dt.setZone(TAIPEI_TZ);
  const safeDt = (
    adjusted.hour === 23
    && adjusted.minute === 58
    && adjusted.second === 0
    && adjusted.millisecond === 0
  )
    ? adjusted.plus({ seconds: 1 })
    : adjusted;
  return toUtcIso(safeDt);
}

/**
 * 取得每日 live snapshot 的 deterministic slot ts。
 * 同一個 dateKey 的所有 rerun 都必須對應同一筆 row。
 * @param {string} dateKey
 * @returns {string}
 */
export function getDailyLiveSnapshotTs(dateKey) {
  const dt = DateTime.fromFormat(dateKey, 'yyyy-MM-dd', { zone: TAIPEI_TZ })
    .set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
  if (!dt.isValid) {
    throw new Error(`無效的 dateKey: ${dateKey}`);
  }
  return dt.toUTC().toISO();
}

export function compareMonthKey(a, b) {
  return a.localeCompare(b);
}
