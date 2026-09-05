import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beijingTimestamp, createLogger } from '../src/logger.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'arcade-log-'));
}

test('beijingTimestamp 输出 UTC+8 并正确跨日', () => {
  // 2026-09-05T16:30:00Z = 北京时间 2026-09-06 00:30:00
  assert.equal(beijingTimestamp(Date.UTC(2026, 8, 5, 16, 30, 0)), '2026-09-06 00:30:00 +08');
  assert.equal(beijingTimestamp(Date.UTC(2026, 8, 5, 0, 0, 0)), '2026-09-05 08:00:00 +08');
});

test('日志同时写屏幕和文件', () => {
  const file = join(tempDir(), 'app.log');
  const screen: string[] = [];
  const log = createLogger({ filePath: file, write: (t) => screen.push(t), now: () => Date.UTC(2026, 8, 6, 4, 0, 0) });

  log('服务已启动');

  assert.equal(screen.length, 1);
  assert.match(screen[0]!, /服务已启动/);
  const onDisk = readFileSync(file, 'utf8');
  assert.match(onDisk, /服务已启动/);
  // 两边内容应当一致，否则排查问题时会看到不同的东西。
  assert.equal(onDisk, screen[0]);
});

test('日志行带北京时间前缀', () => {
  const file = join(tempDir(), 'app.log');
  const log = createLogger({ filePath: file, write: () => {}, now: () => Date.UTC(2026, 8, 6, 4, 0, 0) });
  log('测试');
  assert.match(readFileSync(file, 'utf8'), /^\[2026-09-06 12:00:00 \+08\] 测试\n$/);
});

test('多条日志追加而不覆盖', () => {
  const file = join(tempDir(), 'app.log');
  const log = createLogger({ filePath: file, write: () => {} });
  log('第一条');
  log('第二条');
  log('第三条');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /第一条/);
  assert.match(lines[2]!, /第三条/);
});

test('不配文件路径时只写屏幕，不创建任何文件', () => {
  const dir = tempDir();
  const screen: string[] = [];
  const log = createLogger({ filePath: '', write: (t) => screen.push(t) });
  log('只在屏幕');
  assert.equal(screen.length, 1);
  // 目录里不该多出任何东西
  assert.equal(existsSync(join(dir, 'app.log')), false);
});

test('日志目录不存在时自动创建', () => {
  const file = join(tempDir(), 'nested/deeper/app.log');
  const log = createLogger({ filePath: file, write: () => {} });
  log('测试');
  assert.equal(existsSync(file), true);
});

test('超过大小上限时轮转，旧内容进 .1 文件', () => {
  const file = join(tempDir(), 'app.log');
  // 先塞一个已经超限的文件
  writeFileSync(file, 'x'.repeat(200));
  const log = createLogger({ filePath: file, maxBytes: 100, write: () => {} });

  log('轮转后的第一条');

  // 旧内容被挪到 .1
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(200));
  // 新文件只有新日志，不含旧内容
  const current = readFileSync(file, 'utf8');
  assert.match(current, /轮转后的第一条/);
  assert.doesNotMatch(current, /xxx/);
});

test('未超限时不轮转', () => {
  const file = join(tempDir(), 'app.log');
  writeFileSync(file, 'small');
  const log = createLogger({ filePath: file, maxBytes: 10000, write: () => {} });
  log('追加');
  assert.equal(existsSync(`${file}.1`), false);
  assert.match(readFileSync(file, 'utf8'), /small/);
});

test('轮转只保留一个历史文件（.1 被覆盖，不会无限堆积）', () => {
  const file = join(tempDir(), 'app.log');
  const log = createLogger({ filePath: file, maxBytes: 50, write: () => {} });

  // 连续写很多条，触发多次轮转
  for (let i = 0; i < 20; i += 1) log(`第 ${i} 条日志内容用来把文件撑大`);

  assert.equal(existsSync(`${file}.1`), true);
  // 关键：不能出现 .2/.3，否则小磁盘 VPS 迟早被写满
  assert.equal(existsSync(`${file}.2`), false);
  assert.equal(existsSync(`${file}.3`), false);
  // 当前文件也不该无限膨胀
  assert.ok(statSync(file).size < 500, `当前文件 ${statSync(file).size} 字节，轮转似乎没生效`);
});

test('maxBytes 为 0 表示不轮转', () => {
  const file = join(tempDir(), 'app.log');
  writeFileSync(file, 'x'.repeat(500));
  const log = createLogger({ filePath: file, maxBytes: 0, write: () => {} });
  log('追加');
  assert.equal(existsSync(`${file}.1`), false);
});

test('文件写不进去时降级为只写屏幕，且只提示一次', () => {
  // 用一个不可能建成的路径：把已存在的文件当成目录来用
  const dir = tempDir();
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const file = join(blocker, 'app.log');

  const screen: string[] = [];
  const log = createLogger({ filePath: file, write: (t) => screen.push(t) });

  log('第一条');
  log('第二条');
  log('第三条');

  // 三条业务日志都还在屏幕上——日志文件坏掉绝不能让服务失去可观测性
  assert.ok(screen.some((line) => line.includes('第一条')));
  assert.ok(screen.some((line) => line.includes('第二条')));
  assert.ok(screen.some((line) => line.includes('第三条')));
  // 警告只出现一次，不能每条日志都刷
  assert.equal(screen.filter((line) => line.includes('日志文件写入失败')).length, 1);
});
