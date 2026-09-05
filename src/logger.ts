/**
 * 日志：同时写 stdout 和文件，文件按大小轮转。
 *
 * 为什么要写文件：在 screen 里跑时，stdout 只存在 screen 的滚动缓冲里，
 * 缓冲有上限、screen 进程一挂就全没了。排查「昨天下午为什么没回复」这种问题
 * 必须有落盘的日志。
 *
 * 为什么要轮转：小磁盘 VPS 上，一个无人看管的日志文件迟早把磁盘写满，
 * 那会让 SQLite 也写不进去，等于整个服务瘫掉。
 *
 * 轮转策略刻意做得很简单：超过阈值就把当前文件改名为 .1（覆盖旧的 .1），
 * 只保留一个历史文件。够用，且没有需要清理的状态。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LoggerOptions {
  /** 日志文件路径。空字符串表示只写 stdout。 */
  filePath?: string;
  /** 单文件大小上限（字节）。超过就轮转。 */
  maxBytes?: number;
  /** 可注入，便于测试。 */
  now?: () => number;
  /** 可注入，便于测试时不真的往 stdout 写。 */
  write?: (text: string) => void;
}

export interface Logger {
  (message: string): void;
}

/**
 * 北京时间时间戳。
 *
 * VPS 通常是 UTC 时区，直接用本地时间会导致日志时间和群里消息的时间对不上，
 * 排查问题时得心算八小时。所以固定输出 UTC+8。
 */
export function beijingTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} +08`
  );
}

/** 文件超限时轮转。返回是否真的轮转了（便于测试断言）。 */
function rotateIfNeeded(filePath: string, maxBytes: number): boolean {
  if (maxBytes <= 0) return false;
  try {
    if (statSync(filePath).size < maxBytes) return false;
  } catch {
    // 文件还不存在，不需要轮转。
    return false;
  }
  try {
    // 只保留一个历史文件：.1 直接被覆盖。
    renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    // 轮转失败（权限、磁盘满）不能让日志功能整体崩掉。
    return false;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const filePath = String(options.filePath ?? '').trim();
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (filePath) {
    // 提前建目录，否则第一条日志就会失败。
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      /* 目录已存在或无权限；后者会在写入时体现为「日志文件写入失败」提示 */
    }
  }

  let fileBroken = false;

  return function log(message: string): void {
    const line = `[${beijingTimestamp(now())}] ${message}\n`;
    write(line);
    if (!filePath || fileBroken) return;
    try {
      rotateIfNeeded(filePath, maxBytes);
      appendFileSync(filePath, line);
    } catch (error) {
      // 只提示一次，避免每条日志都刷同样的错误。
      fileBroken = true;
      write(
        `[${beijingTimestamp(now())}] ⚠️  日志文件写入失败，后续只输出到屏幕：` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
}
