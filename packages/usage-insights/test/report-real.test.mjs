import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'report-real.mjs');

test('CLI 按 UTF-8 实际字节数报告 CSV 文件大小', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-report-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(
    path.join(cache, 'session-1.json'),
    JSON.stringify({
      version: 1,
      record: {
        identity: { id: 'session-1', formatVersion: 4, createdAt: 1_700_000_000_000, cwd: '/工作区/项目', isSeeded: false },
        rows: {
          title: { ver: 1, seq: 1, val: '中文会话' },
          tokenUsage: {
            ver: 1,
            seq: 1,
            val: { totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          },
        },
      },
    }),
  );

  const out = path.join(home, 'usage.csv');
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--format', 'csv', '--table', 'sessions', '--out', out],
    { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.statSync(out).size;
  assert.ok(result.stderr.includes(`（${bytes} 字节，表 sessions）`), result.stderr);
});
