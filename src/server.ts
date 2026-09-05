/**
 * HTTP 服务：接收 OneBot 上报、提供管理 API、托管控制台页面。
 *
 * 路由：
 *   POST /onebot        OneBot 客户端（NapCat）推送的事件
 *   GET  /health        健康检查
 *   *    /api/*         管理 API，需 Authorization: Bearer <CONSOLE_TOKEN>
 *   GET  /              控制台页面（public/index.html）
 *
 * 用标准库的 node:http，不引 express 之类框架：路由就这几条，
 * 框架带来的依赖树比省下的代码更贵。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from './config.ts';
import type { Database } from './db.ts';
import { handleGroupMessage } from './handler.ts';
import { fetchShop, searchShops } from './nearcade.ts';
import { extractPlainText, isGroupMessage, quickReply, verifyOneBotSignature, type OneBotGroupMessage } from './onebot.ts';
import { NotFoundError, QueueStore, ValidationError, type ArcadeInput } from './store.ts';

/** 请求体上限，防止被大包打爆内存。 */
const MAX_BODY_BYTES = 65536;

/** 控制台页面路径。启动时读一次并缓存，避免每次请求都读盘。 */
const CONSOLE_HTML_PATH = join(import.meta.dirname, '../public/index.html');

/**
 * 管理 API 的密钥失败限流。
 *
 * 服务暴露在公网上，一定会被扫。这里按来源 IP 记账：连续失败 10 次后锁 15 分钟。
 * 存在内存里，重启即清 —— 这不是要挡住有决心的攻击者，而是让在线爆破变得不划算。
 */
const AUTH_FAIL_LIMIT = 10;
const AUTH_LOCK_MS = 15 * 60 * 1000;

class AuthThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  locked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (this.now() >= entry.until) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= AUTH_FAIL_LIMIT;
  }

  recordFailure(ip: string): void {
    const entry = this.failures.get(ip);
    const now = this.now();
    if (!entry || now >= entry.until) {
      this.failures.set(ip, { count: 1, until: now + AUTH_LOCK_MS });
      return;
    }
    entry.count += 1;
    entry.until = now + AUTH_LOCK_MS;
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

/** 定长比较，避免用计时差异逐字节试出密钥。 */
function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(String(a ?? ''));
  const right = encoder.encode(String(b ?? ''));
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return mismatch === 0;
}

interface ReplyPayload {
  status: number;
  body: string;
  contentType: string;
}

function jsonReply(data: unknown, status = 200): ReplyPayload {
  return { status, body: JSON.stringify(data), contentType: 'application/json; charset=utf-8' };
}

function textReply(body: string, status: number): ReplyPayload {
  return { status, body, contentType: 'text/plain; charset=utf-8' };
}

/** 读取请求体，超限直接断开。 */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ServerDeps {
  config: Config;
  db: Database;
  /** 可注入，便于测试控制时间。 */
  now?: () => number;
  /** 日志出口，测试里可静音。 */
  log?: (message: string) => void;
}

/**
 * 处理 OneBot 事件上报。
 *
 * 协议约束（来自 OneBot v11 规范）：
 *   - 签名对象是**原始 body 字符串**，反序列化再序列化会改变字节。
 *   - 返回非 200 会让客户端重试（4xx 除外）。所以「业务上不响应」必须是 200 + {}，
 *     只有「签名不对」这种重试也没用的情况才回 4xx。
 */
async function handleOneBotRequest(raw: string, signature: string, deps: ServerDeps): Promise<ReplyPayload> {
  const { config, db } = deps;

  if (!(await verifyOneBotSignature(config.onebotSecret, signature, raw))) {
    return textReply('签名校验失败', 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return textReply('无效 JSON', 400);
  }

  // 非群消息（心跳、私聊、入群通知等）一律空操作，200 让客户端别重试。
  if (!isGroupMessage(payload)) return jsonReply({});

  const event = payload as OneBotGroupMessage;
  const text = extractPlainText(event);
  if (!text) return jsonReply({});

  const store = new QueueStore(db, deps.now);
  const messageId = String(event.message_id ?? '');

  // 客户端上报超时会重发同一事件；不去重则增量上报会被重复累加。
  if (messageId && !(await store.markMessageSeen(`onebot:${messageId}`))) return jsonReply({});

  const reply = await handleGroupMessage({
    store,
    groupId: String(event.group_id),
    userId: String(event.user_id ?? event.sender?.user_id ?? ''),
    text,
    config: {
      nearcadeToken: config.nearcadeToken,
      qweatherKey: config.qweatherKey,
      qweatherHost: config.qweatherHost,
    },
  });

  // null = 不是排卡指令，保持沉默。
  return jsonReply(reply === null ? {} : quickReply(reply));
}

/** 管理 API。鉴权就是一个 Bearer 密钥，不做用户体系。 */
async function handleApiRequest(
  method: string,
  path: string,
  query: URLSearchParams,
  rawBody: string,
  deps: ServerDeps,
): Promise<ReplyPayload> {
  const store = new QueueStore(deps.db, deps.now);
  const segments = path.split('/').filter(Boolean); // ['api','groups','<gid>','arcades']

  const parseBody = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(rawBody || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError('需要 JSON 对象');
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError('无效 JSON');
    }
  };

  try {
    if (method === 'GET' && segments[1] === 'nearcade' && segments[2] === 'search') {
      const keyword = query.get('q') ?? '';
      if (keyword.trim().length < 2) return jsonReply({ error: '请输入至少 2 个字符' }, 400);
      return jsonReply(await searchShops(keyword));
    }

    if (method === 'GET' && segments[1] === 'nearcade' && segments[2] === 'shops' && segments[3]) {
      const shopId = Number(segments[3]);
      if (!Number.isInteger(shopId) || shopId < 1) return jsonReply({ error: '店铺 ID 无效' }, 400);
      return jsonReply(await fetchShop(shopId));
    }

    // 以下都在 /api/groups/<gid>/... 之下。gid 是真实 QQ 群号。
    if (segments[1] !== 'groups' || !segments[2]) return jsonReply({ error: '未知接口' }, 404);
    const groupId = decodeURIComponent(segments[2]);

    if (segments[3] === 'enabled') {
      if (method === 'GET') return jsonReply({ enabled: await store.isEnabled(groupId) });
      if (method === 'POST') {
        const body = parseBody();
        if (typeof body.enabled !== 'boolean') return jsonReply({ error: 'enabled 必须为布尔值' }, 400);
        return jsonReply({ enabled: await store.setEnabled(groupId, body.enabled) });
      }
    }

    if (segments[3] === 'arcades' && !segments[4]) {
      if (method === 'GET') return jsonReply(await store.listArcades(groupId));
      if (method === 'POST') return jsonReply(await store.createArcade(groupId, parseBody() as unknown as ArcadeInput), 201);
    }

    if (segments[3] === 'arcades' && segments[4]) {
      const arcadeId = decodeURIComponent(segments[4]);
      if (!segments[5]) {
        if (method === 'GET') return jsonReply(await store.resolve(groupId, arcadeId));
        if (method === 'POST') {
          return jsonReply(await store.updateArcade(groupId, arcadeId, parseBody() as Partial<ArcadeInput>));
        }
        if (method === 'DELETE') {
          await store.deleteArcade(groupId, arcadeId);
          return jsonReply({ ok: true });
        }
      }
      if (segments[5] === 'history' && method === 'GET') {
        const limit = Number(query.get('limit') ?? '100');
        return jsonReply(await store.history(groupId, arcadeId, Number.isInteger(limit) ? limit : 100));
      }
      if (segments[5] === 'report' && method === 'POST') {
        const body = parseBody();
        return jsonReply(await store.report(groupId, arcadeId, Number(body.value), body.delta === true, 'console'));
      }
      if (segments[5] === 'predict' && method === 'GET') {
        return jsonReply(await store.predict(groupId, arcadeId));
      }
    }

    return jsonReply({ error: '未知接口' }, 404);
  } catch (error) {
    if (error instanceof NotFoundError) return jsonReply({ error: error.message }, 404);
    if (error instanceof ValidationError || error instanceof RangeError) return jsonReply({ error: error.message }, 400);
    deps.log?.(`API 内部错误：${error instanceof Error ? error.stack : String(error)}`);
    // 不把内部细节回给客户端。
    return jsonReply({ error: '服务器内部错误' }, 500);
  }
}

/**
 * 请求分发。抽成独立函数（不直接写在 createServer 回调里）是为了能在测试里
 * 直接调用，不必每个用例都起真实端口。
 */
export function createRequestHandler(deps: ServerDeps) {
  const throttle = new AuthThrottle(deps.now);
  // 页面内容启动时读一次。改了 HTML 需要重启服务，这对自托管来说是可接受的。
  let consoleHtml: string | null = null;

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();
    // 直连场景取 socket 地址；将来放到 nginx 后面时 X-Forwarded-For 才有意义。
    const ip = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';

    let reply: ReplyPayload;

    try {
      if (path === '/health') {
        reply = jsonReply({ ok: true });
      } else if (path === '/onebot') {
        if (method !== 'POST') {
          reply = textReply('仅支持 POST', 405);
        } else {
          const raw = await readBody(request);
          reply =
            raw === null
              ? textReply('请求过大', 413)
              : await handleOneBotRequest(raw, String(request.headers['x-signature'] ?? ''), deps);
        }
      } else if (path === '/api' || path.startsWith('/api/')) {
        const expected = deps.config.consoleToken;
        const header = String(request.headers.authorization ?? '');
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (throttle.locked(ip)) {
          reply = jsonReply({ error: '尝试次数过多，请稍后再试' }, 429);
        } else if (!expected || !timingSafeEqualString(presented, expected)) {
          // 没配 CONSOLE_TOKEN 时一律拒绝，不是放开。
          throttle.recordFailure(ip);
          reply = jsonReply({ error: '未授权' }, 401);
        } else {
          throttle.recordSuccess(ip);
          const raw = method === 'GET' || method === 'DELETE' ? '' : ((await readBody(request)) ?? '');
          reply = await handleApiRequest(method, path, url.searchParams, raw, deps);
        }
      } else if (path === '/' || path === '/index.html') {
        consoleHtml ??= readFileSync(CONSOLE_HTML_PATH, 'utf8');
        reply = { status: 200, body: consoleHtml, contentType: 'text/html; charset=utf-8' };
      } else {
        reply = textReply('Not Found', 404);
      }
    } catch (error) {
      deps.log?.(`请求处理失败 ${method} ${path}：${error instanceof Error ? error.stack : String(error)}`);
      reply = jsonReply({ error: '服务器内部错误' }, 500);
    }

    response.writeHead(reply.status, {
      'Content-Type': reply.contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(reply.body);
  };
}

export function createHttpServer(deps: ServerDeps): Server {
  const handler = createRequestHandler(deps);
  return createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('内部错误');
    });
  });
}
