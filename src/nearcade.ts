/**
 * Nearcade（nearcade.cn）客户端：跨平台机厅人数网，与本项目双向互通。
 *
 * 三个能力：
 *   - searchShops：按关键词搜店（配置机厅时用），瞬时故障重试 3 次。
 *   - fetchAttendance：读某机种的实时人数，用于查询时与本地数据对照。
 *   - reportAttendance：把本地人数写回去。**只尝试一次，永不重试**。
 *
 * 「写不重试」是从 bot 版继承的有意设计，不是遗漏：重试可能造成重复上报污染
 * 公共数据。超时或失败时告诉用户「同步未确认，请查卡核对」，让人去核，
 * 而不是让机器猜。
 */

const BASE = 'https://nearcade.cn/api';

export interface NearcadeGame {
  game_id: number | null;
  title_id: number | null;
  name: string;
  version: string;
  quantity: number;
}

export interface NearcadeShop {
  id: number | null;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  games: NearcadeGame[];
}

/** 读接口的超时；写接口单独更短，见 reportAttendance。 */
const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 5000;

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  // Workers 的 fetch 没有内建超时，必须自己用 AbortSignal 掐，否则外部服务
  // 挂起会拖死整个请求（QQ 被动回复只有 5 分钟窗口，但用户等不了那么久）。
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Nearcade HTTP ${response.status}`);
  return response.json();
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 把地址对象拼成一行；Nearcade 的 address 是 {general: [...], detailed: '...'}。 */
function flattenAddress(address: unknown): string {
  if (!address || typeof address !== 'object') return '';
  const record = address as { general?: unknown; detailed?: unknown };
  const general = Array.isArray(record.general) ? record.general.map((part) => String(part).trim()).filter(Boolean) : [];
  const detailed = String(record.detailed ?? '').trim();
  return [...general, detailed].filter(Boolean).join(' ');
}

/** 只保留安全且用得上的字段，不把上游响应整个透给前端。 */
export function normalizeShop(shop: unknown): NearcadeShop {
  if (!shop || typeof shop !== 'object') throw new Error('Nearcade 店铺数据无效');
  const record = shop as Record<string, unknown>;
  const location = (record.location ?? {}) as { coordinates?: unknown };
  const coordinates = Array.isArray(location.coordinates) ? location.coordinates : [];
  // 注意坐标顺序：GeoJSON 是 [经度, 纬度]，不是 [纬度, 经度]。
  const longitude = coordinates.length >= 2 ? toNumberOrNull(coordinates[0]) : null;
  const latitude = coordinates.length >= 2 ? toNumberOrNull(coordinates[1]) : null;
  const rawGames = Array.isArray(record.games) ? record.games : [];
  const games: NearcadeGame[] = [];
  for (const item of rawGames) {
    if (!item || typeof item !== 'object') continue;
    const game = item as Record<string, unknown>;
    if (game.gameId === undefined || game.gameId === null) continue;
    games.push({
      game_id: toNumberOrNull(game.gameId),
      title_id: toNumberOrNull(game.titleId),
      name: String(game.name ?? ''),
      version: String(game.version ?? ''),
      quantity: Math.trunc(Number(game.quantity) || 0),
    });
  }
  return {
    id: toNumberOrNull(record.id),
    name: String(record.name ?? ''),
    address: flattenAddress(record.address),
    latitude,
    longitude,
    games,
  };
}

/** 搜店。瞬时网络故障重试 3 次；全败返回空数组而不是抛错。 */
export async function searchShops(keyword: string, limit = 5): Promise<NearcadeShop[]> {
  const query = new URLSearchParams({ q: String(keyword).slice(0, 100), page: '1', limit: String(limit) });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = (await fetchJson(`${BASE}/shops?${query}`, { method: 'GET' }, READ_TIMEOUT_MS)) as {
        shops?: unknown;
      };
      const shops = Array.isArray(payload.shops) ? payload.shops : [];
      return shops.map((shop) => normalizeShop(shop));
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  return [];
}

export async function fetchShop(shopId: number): Promise<NearcadeShop> {
  const payload = (await fetchJson(`${BASE}/shops/${shopId}`, { method: 'GET' }, READ_TIMEOUT_MS)) as {
    shop?: unknown;
  };
  return normalizeShop(payload.shop ?? payload);
}

/**
 * 读某机种当前人数。
 *
 * 返回 null 有三种含义：没配 shop/game id、机种不在返回列表里、接口报错。
 * **返回 0 与返回 null 语义不同**（0 = 确实没人，null = 没有数据），
 * 调用方必须用 `?? ` 而不是 `|| ` 处理，否则「0 人」会被误当成缺数据。
 * bot 版在这点上没区分开，是已知毛边，本版修掉了。
 */
export async function fetchAttendance(shopId: number | null, gameId: number | null): Promise<number | null> {
  if (!shopId || !gameId) return null;
  const payload = (await fetchJson(`${BASE}/shops/${shopId}/attendance`, { method: 'GET' }, READ_TIMEOUT_MS)) as {
    games?: unknown;
  };
  const games = Array.isArray(payload.games) ? payload.games : [];
  for (const item of games) {
    if (!item || typeof item !== 'object') continue;
    const game = item as Record<string, unknown>;
    if (Number(game.gameId) !== Number(gameId)) continue;
    const total = toNumberOrNull(game.total);
    return total === null ? null : Math.trunc(total);
  }
  return null;
}

export type ReportOutcome =
  | { status: 'ok' }
  | { status: 'skipped'; reason: 'no-token' | 'no-shop' }
  | { status: 'unconfirmed' };

/**
 * 写上报。**只发一次，任何失败都不重试**（防重复污染公共数据）。
 * 返回值区分三种情况，让调用方给出准确的用户提示。
 */
export async function reportAttendance(
  shopId: number | null,
  gameId: number | null,
  count: number,
  token: string,
  comment = '通过机厅排卡 Bot 上报',
): Promise<ReportOutcome> {
  if (!token) return { status: 'skipped', reason: 'no-token' };
  if (!shopId || !gameId) return { status: 'skipped', reason: 'no-shop' };
  try {
    await fetchJson(
      `${BASE}/shops/${shopId}/attendance`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          games: [{ id: Math.trunc(gameId), currentAttendances: Math.trunc(count) }],
          comment,
        }),
      },
      WRITE_TIMEOUT_MS,
    );
    return { status: 'ok' };
  } catch {
    return { status: 'unconfirmed' };
  }
}

/** 把上报结果翻成给群里看的一句话。 */
export function describeReportOutcome(outcome: ReportOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return '已同步 Nearcade。';
    case 'skipped':
      return outcome.reason === 'no-token'
        ? '本地已保存；未配置 Nearcade Token，未同步。'
        : '本地已保存；未配置 Nearcade 店铺/机种 ID，未同步。';
    case 'unconfirmed':
      // 刻意不说「失败」：请求可能已经到达，只是没收到确认。不自动重试。
      return '本地已保存；Nearcade 同步未确认，请查卡核对，不自动重试。';
  }
}
