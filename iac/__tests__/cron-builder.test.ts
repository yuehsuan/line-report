import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportCron, buildSnapshotCron } from '../lib/cron-builder';

// ─────────────────────────────────────────────────────────────────
// buildReportCron — weekday 模式
// ─────────────────────────────────────────────────────────────────
describe('buildReportCron - weekday 模式', () => {
  it('每月第 2 個星期三（WEEK=2, WEEKDAY=3）→ cron 應為 4#2', () => {
    const { cron } = buildReportCron({
      reportMode: 'weekday', reportWeek: '2', reportWeekday: '3', reportHour: '9',
    });
    assert.equal(cron, 'cron(0 9 ? * 4#2 *)');
  });

  it('weekday 全對應：1=Mon(2), 2=Tue(3), 3=Wed(4), 4=Thu(5), 5=Fri(6)', () => {
    const expected: Record<string, number> = { '1': 2, '2': 3, '3': 4, '4': 5, '5': 6 };
    for (const [userDay, awsDay] of Object.entries(expected)) {
      const { cron } = buildReportCron({
        reportMode: 'weekday', reportWeek: '1', reportWeekday: userDay, reportHour: '9',
      });
      assert.ok(
        cron.includes(`${awsDay}#1`),
        `WEEKDAY=${userDay} 應產生 AWS weekday ${awsDay}，實際 cron：${cron}`
      );
    }
  });

  it('第 1 週星期五 08:00 → cron 正確', () => {
    const { cron, description } = buildReportCron({
      reportMode: 'weekday', reportWeek: '1', reportWeekday: '5', reportHour: '8',
    });
    assert.equal(cron, 'cron(0 8 ? * 6#1 *)');
    assert.ok(description.includes('星期五'), `description 應含星期五，實際：${description}`);
  });

  it('description 應含正確中文星期（第3週星期一）', () => {
    const { description } = buildReportCron({
      reportMode: 'weekday', reportWeek: '3', reportWeekday: '1', reportHour: '9',
    });
    assert.ok(description.includes('第 3'), `應含「第 3」，實際：${description}`);
    assert.ok(description.includes('星期一'), `應含「星期一」，實際：${description}`);
  });

  it('REPORT_WEEK=5 合法（但告知可能跳過月份）', () => {
    assert.doesNotThrow(() =>
      buildReportCron({
        reportMode: 'weekday', reportWeek: '5', reportWeekday: '3', reportHour: '9',
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// buildReportCron — 錯誤輸入驗證
// ─────────────────────────────────────────────────────────────────
describe('buildReportCron - 錯誤輸入應拋出錯誤', () => {
  it('REPORT_WEEKDAY=0 → 應拋錯', () => {
    assert.throws(
      () => buildReportCron({
        reportMode: 'weekday', reportWeekday: '0', reportWeek: '1', reportHour: '9',
      }),
      /reportWeekday 必須為 1-5/
    );
  });

  it('REPORT_WEEKDAY=6 → 應拋錯（週六不是工作日）', () => {
    assert.throws(
      () => buildReportCron({
        reportMode: 'weekday', reportWeekday: '6', reportWeek: '1', reportHour: '9',
      }),
      /reportWeekday 必須為 1-5/
    );
  });

  it('REPORT_WEEKDAY=abc → 應拋錯', () => {
    assert.throws(
      () => buildReportCron({
        reportMode: 'weekday', reportWeekday: 'abc', reportWeek: '1', reportHour: '9',
      }),
      /reportWeekday 必須為 1-5/
    );
  });

  it('REPORT_WEEK=0 → 應拋錯', () => {
    assert.throws(
      () => buildReportCron({
        reportMode: 'weekday', reportWeekday: '3', reportWeek: '0', reportHour: '9',
      }),
      /reportWeek 必須為 1-5/
    );
  });

  it('REPORT_WEEK=6 → 應拋錯', () => {
    assert.throws(
      () => buildReportCron({
        reportMode: 'weekday', reportWeekday: '3', reportWeek: '6', reportHour: '9',
      }),
      /reportWeek 必須為 1-5/
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// buildReportCron — date 模式
// ─────────────────────────────────────────────────────────────────
describe('buildReportCron - date 模式', () => {
  it('每月 11 日 09:00 → cron 正確', () => {
    const { cron } = buildReportCron({
      reportMode: 'date', reportDay: '11', reportHour: '9',
    });
    assert.equal(cron, 'cron(0 9 11 * ? *)');
  });

  it('reportMode 預設（空字串以外）→ 走 date 模式', () => {
    const { cron } = buildReportCron({
      reportMode: 'unknown', reportDay: '20', reportHour: '10',
    });
    assert.equal(cron, 'cron(0 10 20 * ? *)');
  });

  it('description 應含日期資訊', () => {
    const { description } = buildReportCron({
      reportMode: 'date', reportDay: '15', reportHour: '9',
    });
    assert.ok(description.includes('15 日'), `應含「15 日」，實際：${description}`);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildSnapshotCron
// ─────────────────────────────────────────────────────────────────
describe('buildSnapshotCron', () => {
  it('23:55 → cron(55 23 * * ? *)', () => {
    assert.equal(buildSnapshotCron('23', '55'), 'cron(55 23 * * ? *)');
  });

  it('0:00 → cron(0 0 * * ? *)', () => {
    assert.equal(buildSnapshotCron('0', '0'), 'cron(0 0 * * ? *)');
  });
});
