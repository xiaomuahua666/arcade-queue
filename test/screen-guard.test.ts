import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 这些断言守护「在 screen 里按 Ctrl+C 不会关掉服务」这件事。
 *
 * 背景：实际使用中发生过——用户 screen -r 进去看日志，习惯性按 Ctrl+C，
 * 服务静默下线，直到发现群里没反应才知道。所以做了两层防护，
 * 缺任何一层都会重现事故，这里各自锁住。
 */

const mainSource = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');
const scriptSource = readFileSync(join(import.meta.dirname, '../deploy/start-screen.sh'), 'utf8');

test('第一层：服务在 screen 里忽略 SIGINT', () => {
  // 判据是 screen 自设的 STY 环境变量
  assert.match(mainSource, /process\.env\.STY/, '应当用 STY 判断是否在 screen 里');
  assert.match(mainSource, /insideScreen/);
  // SIGINT 处理里必须有「在 screen 里就 return」的分支
  const sigintBlock = mainSource.slice(mainSource.indexOf("process.on('SIGINT'"));
  assert.match(sigintBlock, /if \(insideScreen\)/);
  assert.match(sigintBlock, /return;/);
});

test('忽略 Ctrl+C 时要告诉用户正确的离开方式', () => {
  const sigintBlock = mainSource.slice(mainSource.indexOf("process.on('SIGINT'"));
  // 光挡住不说明白等于让人困惑
  assert.match(sigintBlock, /Ctrl\+A/, '要提示 Ctrl+A 再 D');
  assert.match(sigintBlock, /start-screen\.sh stop/, '要提示真正停止服务的办法');
});

test('SIGTERM 仍然正常关闭（stop 依赖它）', () => {
  assert.match(mainSource, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\)/);
});

test('不在 screen 里时 Ctrl+C 仍然照常退出', () => {
  const sigintBlock = mainSource.slice(mainSource.indexOf("process.on('SIGINT'"));
  assert.match(sigintBlock, /shutdown\('SIGINT'\)/, '前台运行时 Ctrl+C 应当能退出');
});

test('第二层：守护 shell 也忽略 SIGINT', () => {
  // node 以后台任务启动，键盘信号会打到守护 shell 上，
  // 它若退出则 node 变孤儿、服务同样没了。
  assert.match(scriptSource, /trap '' INT/, '守护脚本必须 trap INT');
});

test('stop 不用 pgrep 按命令行匹配（会误杀无关进程）', () => {
  // 实测教训：pgrep -f "node .*src/main.ts" 会匹配到「命令行里含该字符串」
  // 的进程，把执行 stop 的 shell 自己杀掉。
  const stopBlock = scriptSource.slice(scriptSource.indexOf('  stop)'), scriptSource.indexOf('  start)'));
  assert.doesNotMatch(stopBlock, /pgrep/, 'stop 分支不该用 pgrep');
  assert.match(stopBlock, /stop_service_process/);
});

test('stop 通过 PID 文件发信号，并校验进程身份', () => {
  assert.match(scriptSource, /data\/service\.pid/);
  // 发信号前确认那个 PID 确实是 node，防 PID 复用误杀
  assert.match(scriptSource, /\/proc\/\$pid\/comm/);
  assert.match(scriptSource, /kill -0/);
});

test('stop 不再靠模拟键盘发 Ctrl+C（那已被忽略，不会生效）', () => {
  const stopBlock = scriptSource.slice(scriptSource.indexOf('  stop)'), scriptSource.indexOf('  start)'));
  // 只看可执行语句，注释里提到 stuff 是在解释「为什么不能用」，不算违规。
  const code = stopBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /-X stuff/, 'stop 不该再送 Ctrl+C');
});

test('守护循环记录 PID 并在退出后清理', () => {
  // 这段在 GUARD_CMD 字符串里，$ 与 " 都是转义过的，所以放宽匹配。
  assert.match(scriptSource, /NODE_PID.*> data\/service\.pid/);
  assert.match(scriptSource, /rm -f data\/service\.pid/);
});

test('screen 窗口进去就有离开方式的提示', () => {
  assert.match(scriptSource, /离开又保持运行/);
  assert.match(scriptSource, /Ctrl\+C 在这里不会关掉服务/);
});
