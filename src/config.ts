/**
 * 配置加载：全部来自环境变量，没有配置文件。
 *
 * 这样做的原因：secret 不该躺在仓库目录里等着被误提交，而 systemd 的
 * EnvironmentFile 天生就是给这个用的（可以 chmod 600，只有 root 能读）。
 */

import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  /** 监听地址。0.0.0.0 = 对公网开放；127.0.0.1 = 只本机（需 SSH 转发访问控制台）。 */
  host: string;
  port: number;
  /** SQLite 文件路径。 */
  dbPath: string;
  /** 控制台访问密钥。为空则管理 API 全部拒绝。 */
  consoleToken: string;
  /** OneBot 上报签名密钥，须与 NapCat 的 secret 一致。为空则不校验（仅限本机监听时可接受）。 */
  onebotSecret: string;
  /** 可选：主动发消息用。日常被动回复不需要。 */
  onebotApiBase: string;
  onebotAccessToken: string;
  /** 可选：配了才向 Nearcade 写上报。 */
  nearcadeToken: string;
  /** 可选：不配则只用 Open-Meteo（免 key）。 */
  qweatherKey: string;
  qweatherHost: string;
  /** 日志文件路径。空则只输出到屏幕（screen 方式下建议配上）。 */
  logFile: string;
  /** 日志单文件大小上限（MB），超过则轮转，只保留一个历史文件。 */
  logMaxMb: number;
  /**
   * 是否信任 X-Forwarded-For 头来判定客户端 IP。
   *
   * 默认 false。直连公网时该头完全由客户端控制，信任它等于把限流交给攻击者：
   * 每次请求换一个值就能无限次爆破 CONSOLE_TOKEN（实测 30 次尝试 0 次被拦）。
   * 只有当本服务确实跑在会重写该头的反向代理（nginx 等）之后，才应设为 true。
   */
  trustProxy: boolean;
}

function readEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

/**
 * 从 .env 风格文件补充环境变量（不覆盖已存在的真实环境变量）。
 * 方便本地开发；生产建议用 systemd 的 EnvironmentFile。
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    // 去掉包裹的引号，但保留值内部的引号。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(): Config {
  const port = Number.parseInt(readEnv('PORT', '8787'), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 无效：${readEnv('PORT')}`);
  }
  const logMaxMb = Number(readEnv('LOG_MAX_MB', '10'));
  if (!Number.isFinite(logMaxMb) || logMaxMb <= 0) {
    throw new Error(`LOG_MAX_MB 无效：${readEnv('LOG_MAX_MB')}`);
  }
  return {
    host: readEnv('HOST', '0.0.0.0'),
    port,
    dbPath: readEnv('DB_PATH', './data/arcade-queue.db'),
    consoleToken: readEnv('CONSOLE_TOKEN'),
    onebotSecret: readEnv('ONEBOT_SECRET'),
    onebotApiBase: readEnv('ONEBOT_API_BASE'),
    onebotAccessToken: readEnv('ONEBOT_ACCESS_TOKEN'),
    nearcadeToken: readEnv('NEARCADE_TOKEN'),
    qweatherKey: readEnv('QWEATHER_KEY'),
    qweatherHost: readEnv('QWEATHER_HOST', 'devapi.qweather.com'),
    logFile: readEnv('LOG_FILE', './data/arcade-queue.log'),
    logMaxMb: logMaxMb,
    // 只有显式写 true/1/yes 才开启，拼错一律按「不信任」处理——
    // 安全开关的默认值必须是安全的那一侧。
    trustProxy: ['true', '1', 'yes'].includes(readEnv('TRUST_PROXY', 'false').toLowerCase()),
  };
}

/**
 * 启动前的配置体检。返回要打印的警告，不抛错——除了「完全不可用」的情况。
 *
 * 单独抽成函数是为了能测：这些警告对应的都是真实会出事的配置组合。
 */
export function auditConfig(config: Config): string[] {
  const warnings: string[] = [];
  const publiclyExposed = config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1';

  if (!config.consoleToken) {
    warnings.push('未设置 CONSOLE_TOKEN：管理 API 与控制台将全部拒绝访问（不是放开）。');
  } else if (config.consoleToken.length < 16) {
    warnings.push('CONSOLE_TOKEN 少于 16 字符，公网暴露时容易被爆破，建议换成长随机值。');
  }

  if (!config.onebotSecret) {
    warnings.push(
      publiclyExposed
        ? '未设置 ONEBOT_SECRET 且监听公网：任何人都能伪造上报事件操纵人数。请立刻配上。'
        : '未设置 ONEBOT_SECRET：仅本机监听时可接受，但仍建议配上。',
    );
  }

  if (publiclyExposed) {
    // 明文 HTTP 下控制台密钥会裸奔过网。这是用户明确选择的方案，只提醒一次。
    warnings.push(
      `监听 ${config.host}:${config.port} 且无 TLS：控制台密钥以明文经过网络。` +
        '建议只在自己网络下使用，或后续加 nginx + HTTPS。',
    );
    if (config.trustProxy) {
      // 这个组合最危险：直连公网却信任客户端可控的头，等于把限流交给攻击者
      // （每个请求换一个 X-Forwarded-For 就能无限试密钥）。
      warnings.push(
        'TRUST_PROXY=true 但服务直接监听公网：X-Forwarded-For 由客户端控制，' +
          '密钥爆破限流会被绕过。只有确实在反向代理之后才应开启。',
      );
    }
  }

  return warnings;
}
