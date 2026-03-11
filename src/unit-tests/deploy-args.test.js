import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeployArgs } from '../../scripts/lib/deploy-args.js';

describe('parseDeployArgs', () => {
  test('支援裸 stack 名稱', () => {
    const result = parseDeployArgs(['LineReportSchedulerStack']);

    assert.equal(result.hasStackNames, true);
    assert.deepEqual(result.requestedStacks, ['LineReportSchedulerStack']);
    assert.deepEqual(result.normalizedArgs, ['LineReportSchedulerStack']);
  });

  test('相容舊的 --stacks 寫法', () => {
    const result = parseDeployArgs(['--stacks', 'LineReportSchedulerStack']);

    assert.equal(result.hasStackNames, true);
    assert.deepEqual(result.requestedStacks, ['LineReportSchedulerStack']);
    assert.deepEqual(result.normalizedArgs, ['LineReportSchedulerStack']);
  });

  test('無 stack 名稱時走全量部署', () => {
    const result = parseDeployArgs([]);

    assert.equal(result.hasStackNames, false);
    assert.deepEqual(result.requestedStacks, []);
    assert.deepEqual(result.normalizedArgs, []);
  });
});
