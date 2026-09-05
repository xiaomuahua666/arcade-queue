/**
 * 启动入口：加载配置 → 开库跑迁移 → 起 HTTP 服务。
 *
 * 用 `node src/main.ts` 直接跑（Node 22.6+ 原生执行 TypeScript，无需编译步骤）。
 */

import { auditConfig, loadConfig, loadEnvFile } from './config.ts';
import { openDatabase } from './db.ts';
import { createHttpServer } from './server.ts';

function timestamp(): string {
  // 日志一律北京时间（UTC+8），不用服务器本地时区——VPS 通常是 UTC，
  // 打出来的时间要能直接和群里的消息对上。
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().replace('T', ' ').slice(0, 19) + ' +08';
}

function log(message: string): void {
  process.stdout.write(`[${timestamp()}] ${message}\n`);
}

loadEnvFile('.env');
const config = loadConfig();

for (const warning of auditConfig(config)) log(`⚠️  ${warning}`);

const db = openDatabase(config.dbPath);
log(`数据库已就绪：${config.dbPath}`);

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
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  log(`未捕获异常：${error.stack ?? error.message}`);
  // 不退出：单个请求的意外不该让整个机器人下线。
});
process.on('unhandledRejection', (reason) => {
  log(`未处理的 Promise 拒绝：${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
