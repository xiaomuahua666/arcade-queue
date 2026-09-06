/**
 * 启动入口：加载配置 → 开库跑迁移 → 起 HTTP 服务。
 *
 * 用 `node src/main.ts` 直接跑（Node 22.6+ 原生执行 TypeScript，无需编译步骤）。
 */

import { auditConfig, loadConfig, loadEnvFile } from './config.ts';
import { openDatabase } from './db.ts';
import { createLogger } from './logger.ts';
import { createHttpServer } from './server.ts';

loadEnvFile('.env');
const config = loadConfig();

// 同时写屏幕和文件：screen 里能实时看，断开后也能查历史。
const log = createLogger({ filePath: config.logFile, maxBytes: config.logMaxMb * 1024 * 1024 });

for (const warning of auditConfig(config)) log(`⚠️  ${warning}`);

const db = openDatabase(config.dbPath);
log(`数据库已就绪：${config.dbPath}`);
if (config.logFile) log(`日志文件：${config.logFile}（超过 ${config.logMaxMb}MB 自动轮转）`);

const server = createHttpServer({ config, db, log });

server.listen(config.port, config.host, () => {
  log(`服务已启动：http://${config.host}:${config.port}`);
  log(`  OneBot 上报地址（填进 NapCat）：http://127.0.0.1:${config.port}/onebot`);
  log(`  控制台：http://${config.host === '0.0.0.0' ? '<你的公网IP>' : config.host}:${config.port}/`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log(`端口 ${config.port} 已被占用。改 PORT 环境变量，或先停掉占用它的进程。`);
  } else {
    log(`服务启动失败：${error.message}`);
  }
  process.exit(1);
});

/** 优雅退出：先停止接受新连接，再关数据库，确保 WAL 落盘。 */
function shutdown(signal: string): void {
  log(`收到 ${signal}，正在退出…`);
  server.close(() => {
    db.close();
    log('已安全退出。');
    process.exit(0);
  });
  // 兜底：5 秒还没关完就强退，避免 systemd restart 卡住。
  setTimeout(() => {
    log('退出超时，强制结束。');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Ctrl+C 的处理分两种情况。
 *
 * 在 screen 会话里跑时**故意不响应 Ctrl+C**：进 screen 是为了看日志，
 * 而看完想离开的正确按法是 Ctrl+A 再 D。很多人（包括本项目的使用者）
 * 会习惯性按 Ctrl+C，那样服务就被关掉了，机器人静默下线，
 * 直到有人发现群里没反应才知道——这是实际发生过的事故。
 *
 * 判据是 screen 自己设置的 STY 环境变量，只在会话内存在。
 * 真要停止服务请用 `bash deploy/start-screen.sh stop`（它发 SIGTERM）。
 *
 * 不在 screen 里（手动前台运行）则保持常规行为：Ctrl+C 就是退出。
 */
const insideScreen = Boolean(process.env.STY);

process.on('SIGINT', () => {
  if (insideScreen) {
    log('⚠️  这里是 screen 会话，Ctrl+C 已被忽略（否则会让机器人下线）。');
    log('    想离开又保持运行：先按 Ctrl+A，松手，再按 D。');
    log('    确实要停止服务：另开一个终端执行 bash deploy/start-screen.sh stop');
    return;
  }
  shutdown('SIGINT');
});

process.on('uncaughtException', (error) => {
  log(`未捕获异常：${error.stack ?? error.message}`);
  // 不退出：单个请求的意外不该让整个机器人下线。
});
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
