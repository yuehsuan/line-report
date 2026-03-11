import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/Users/yuehsuan/Desktop/首潤資料/line-report';
const scriptPath = path.join(repoRoot, 'scripts', 'sync-ssm.sh');

function setupTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-report-sync-ssm-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);
  const awsLogPath = path.join(tempDir, 'aws.log');

  fs.writeFileSync(path.join(tempDir, '.env'), [
    'LINE_CHANNEL_ACCESS_TOKEN=test-token',
    'LINE_TARGETS=U_target_1,U_target_2',
  ].join('\n'));

  fs.writeFileSync(path.join(binDir, 'aws'), `#!/usr/bin/env bash
echo "$@" >> "${awsLogPath}"
`);
  fs.chmodSync(path.join(binDir, 'aws'), 0o755);

  return { tempDir, binDir, awsLogPath };
}

describe('sync-ssm.sh', () => {
  test('有設定 AWS_PROFILE 時應傳入 --profile', () => {
    const { tempDir, binDir, awsLogPath } = setupTempDir();
    const result = spawnSync('bash', [scriptPath, 'targets'], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AWS_PROFILE: 'custom-profile',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const awsLog = fs.readFileSync(awsLogPath, 'utf8');
    assert.match(awsLog, /--profile custom-profile/);
    assert.match(awsLog, /--name \/line-report\/LINE_TARGETS/);
  });

  test('未設定 AWS_PROFILE 時不應硬塞 --profile', () => {
    const { tempDir, binDir, awsLogPath } = setupTempDir();
    const result = spawnSync('bash', [scriptPath, 'targets'], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AWS_PROFILE: '',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const awsLog = fs.readFileSync(awsLogPath, 'utf8');
    assert.doesNotMatch(awsLog, /--profile/);
    assert.match(awsLog, /--name \/line-report\/LINE_TARGETS/);
  });
});
