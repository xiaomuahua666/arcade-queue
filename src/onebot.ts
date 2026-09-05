/**
 * OneBot v11 协议适配：接收 HTTP POST 上报的事件，用「快速操作」回消息。
 *
 * 协议来源：https://github.com/botuniverse/onebot-11
 *   - communication/http-post.md（上报格式、X-Signature 校验、快速操作响应）
 *   - event/message.md（群消息事件字段、快速操作字段）
 *
 * 架构要点：**Worker 不主动连 NapCat**。
 * OneBot 允许在 HTTP POST 的响应体里直接返回 {"reply": "..."}，客户端收到后自己
 * 把消息发出去。所以 NapCat 可以待在你 VPS 上只出网、不开任何入站端口，
 * Worker 也不需要知道它的地址。
 *
 * 只有需要主动推送（不是回复某条消息）时才需要反向调用，那条路径是可选的，
 * 见 callAction()，配了 ONEBOT_API_BASE 才启用。
 */

const encoder = new TextEncoder();

/** OneBot 群消息事件里我们用得到的字段。 */
export interface OneBotGroupMessage {
  post_type: 'message';
  message_type: 'group';
  group_id: number;
  user_id: number;
  message_id: number;
  raw_message?: string;
  message?: unknown;
  sender?: { user_id?: number; nickname?: string; card?: string; role?: string };
}

/** 快速操作响应：直接回给 OneBot 客户端，由它发消息。 */
export interface QuickReply {
  reply: string;
  /** 是否在回复前 @ 发送者。OneBot 默认是 true，我们显式关掉避免刷屏。 */
  at_sender: boolean;
  /** 纯文本发送，不解析 CQ 码——机厅通知里可能出现 [ ] 等字符，不转义会被误当指令。 */
  auto_escape: boolean;
}

/**
 * 校验 OneBot 的 X-Signature（HMAC-SHA1）。
 *
 * 格式是 `sha1=<hex>`，签名对象是**原始请求体**。
 * secret 为空表示未启用校验：此时直接放行，但部署时应当配上，
 * 否则任何人都能往你的 Worker 灌假事件。
 */
export async function verifyOneBotSignature(
  secret: string,
  signatureHeader: string,
  rawBody: string,
): Promise<boolean> {
  if (!secret) return true; // 未配置 secret = 不校验（OneBot 规范如此）
  const header = String(signatureHeader ?? '').trim();
  if (!header.startsWith('sha1=')) return false;
  const presented = header.slice(5).toLowerCase();
  if (presented.length !== 40 || /[^0-9a-f]/.test(presented)) return false;

  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  let expected = '';
  for (const byte of new Uint8Array(signature)) expected += byte.toString(16).padStart(2, '0');

  // 定长比较，避免用计时差异逐字节猜出签名。
  let mismatch = 0;
  for (let i = 0; i < 40; i += 1) mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return mismatch === 0;
}

/**
 * 从 OneBot 的 message 字段提取纯文本。
 *
 * message 有两种格式（取决于客户端配置的 message_format）：
 *   - string：CQ 码字符串，如 "[CQ:at,qq=123] 万达几"
 *   - array：消息段数组，如 [{type:"at",...},{type:"text",data:{text:"万达几"}}]
 * 两种都要支持，因为用户不一定按我们期望配置 NapCat。
 */
export function extractPlainText(event: { raw_message?: string; message?: unknown }): string {
  const message = event.message;

  // 数组格式：只取 text 段，其余（at/image/face）丢掉。
  if (Array.isArray(message)) {
    return message
      .map((segment) => {
        if (!segment || typeof segment !== 'object') return '';
        const item = segment as { type?: unknown; data?: unknown };
        if (item.type !== 'text') return '';
        const data = (item.data ?? {}) as { text?: unknown };
        return String(data.text ?? '');
      })
      .join('')
      .trim();
  }

  const raw = typeof message === 'string' && message ? message : String(event.raw_message ?? '');
  return stripCqCodes(raw);
}

/**
 * 剥掉 CQ 码，只留文本。
 * `[CQ:at,qq=123] 万达几` → `万达几`
 * CQ 码里的转义序列也要还原，否则 &#91; 会残留在文本里。
 */
export function stripCqCodes(raw: string): string {
  return String(raw ?? '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
    .trim();
}

/** 判断是否是我们要处理的群消息事件。 */
export function isGroupMessage(payload: unknown): payload is OneBotGroupMessage {
  if (!payload || typeof payload !== 'object') return false;
  const event = payload as Record<string, unknown>;
  if (event.post_type !== 'message') return false;
  if (event.message_type !== 'group') return false;
  // 群号和用户号必须是有效正整数，否则后续没法当 key 用。
  return Number.isFinite(Number(event.group_id)) && Number(event.group_id) > 0;
}

/** 构造快速操作响应。 */
export function quickReply(text: string): QuickReply {
  return { reply: String(text), at_sender: false, auto_escape: true };
}

export interface OneBotApiConfig {
  /** 形如 http://127.0.0.1:3000，配了才能主动发消息。 */
  apiBase?: string;
  /** NapCat 的 access_token（对应它的 HTTP 服务鉴权）。 */
  accessToken?: string;
}

/**
 * 主动调用 OneBot HTTP API。**可选路径**：只在需要不依附于某条消息地发送时才用。
 * 日常回复走快速操作，不经过这里，因此 NapCat 无需暴露入站端口。
 */
export async function callAction(
  action: string,
  params: Record<string, unknown>,
  config: OneBotApiConfig,
): Promise<unknown> {
  const base = String(config.apiBase ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 ONEBOT_API_BASE，无法主动调用 OneBot API');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;
  const response = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`OneBot API ${action} 失败：HTTP ${response.status}`);
  const payload = (await response.json()) as { status?: unknown; retcode?: unknown; data?: unknown };
  // OneBot 的 retcode 0 才算成功；HTTP 200 不代表业务成功。
  if (Number(payload.retcode) !== 0) {
    throw new Error(`OneBot API ${action} 返回 retcode=${String(payload.retcode)}`);
  }
  return payload.data;
}

/** 主动往群里发消息（可选路径，需配 ONEBOT_API_BASE）。 */
export async function sendGroupMessage(
  groupId: number | string,
  text: string,
  config: OneBotApiConfig,
): Promise<unknown> {
  return callAction('send_group_msg', { group_id: Number(groupId), message: String(text), auto_escape: true }, config);
}
