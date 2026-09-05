/**
 * 排卡数据访问层（对应 bot 版的 QueueStore）。
 *
 * 几个写法上的约定：
 *   1. 「读—改—写」一律靠单条 SQL 自身完成原子更新（见 report()：用
 *      `count = count + ?` 让数据库算增量），不先读再写。两个人同时上报时，
 *      先读后写会各自读到同一个旧值，其中一次静默丢失。
 *   2. 需要多语句原子性的地方用 batch()，它在单个事务里顺序执行、失败整体回滚。
 *   3. 时间戳统一毫秒整数。
 */

import type { Database, PreparedStatement } from './db.ts';
import { integer, normalize, type Arcade } from './queue.ts';

/** 上报数据多久算陈旧（2 小时，与 bot 版一致）。 */
const STALE_AFTER_MS = 7200 * 1000;

/** 每个机厅保留的历史条数上限。 */
const HISTORY_LIMIT = 2000;

/** 幂等表保留时长：QQ 被动回复窗口只有 5 分钟，留 1 小时足够。 */
const SEEN_MESSAGE_TTL_MS = 3600 * 1000;

/** 机厅名称/别名/通知等字段的长度上限，与 bot 版对齐。 */
const LIMITS = {
  name: 80,
  alias: 40,
  aliasCount: 20,
  notice: 1000,
  address: 1000,
  template: 4000,
  machineCount: 100,
  nearcadeId: 2147483647,
};

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

interface ArcadeRow {
  arcade_id: string;
  group_id: string;
  name: string;
  aliases: string;
  machine_count: number;
  notice: string;
  latitude: number | null;
  longitude: number | null;
  address: string;
  direction_guide: string;
  nearcade_shop_id: number | null;
  nearcade_game_id: number | null;
  query_template: string;
  report_template: string;
  predict_template: string;
  count: number;
  updated_at: number;
}

export interface HistoryEntry {
  count: number;
  diff: number;
  created_at: number;
}

export interface ArcadeInput {
  name: string;
  aliases?: string[];
  machine_count?: number;
  notice?: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: string;
  direction_guide?: string;
  nearcade_shop_id?: number | null;
  nearcade_game_id?: number | null;
  query_template?: string;
  report_template?: string;
  predict_template?: string;
  /** 复用已有全局机厅的人数（跨群共享）。 */
  shared_arcade_id?: string | null;
}

const SELECT_ARCADE = `
  SELECT g.*, a.count AS count, a.updated_at AS updated_at
  FROM group_arcade g
  JOIN arcade a ON a.id = g.arcade_id
`;

function toArcade(row: ArcadeRow, now: number): Arcade {
  const updatedAt = Number(row.updated_at) || 0;
  const ageSeconds = updatedAt ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : null;
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases || '[]');
    if (Array.isArray(parsed)) aliases = parsed.map((item) => String(item));
  } catch {
    aliases = [];
  }
  return {
    id: row.arcade_id,
    group_id: row.group_id,
    name: row.name,
    aliases,
    machine_count: Number(row.machine_count) || 1,
    notice: row.notice || '',
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    address: row.address || '',
    direction_guide: row.direction_guide || '',
    nearcade_shop_id: row.nearcade_shop_id === null ? null : Number(row.nearcade_shop_id),
    nearcade_game_id: row.nearcade_game_id === null ? null : Number(row.nearcade_game_id),
    query_template: row.query_template || '',
    report_template: row.report_template || '',
    predict_template: row.predict_template || '',
    count: Number(row.count) || 0,
    updated_at: updatedAt,
    age_seconds: ageSeconds,
    stale: ageSeconds === null || ageSeconds * 1000 > STALE_AFTER_MS,
  };
}

function validateCoordinates(latitude: number | null, longitude: number | null): void {
  // 只填一个坐标是常见的手滑，直接拒绝比存半份数据好。
  if ((latitude === null) !== (longitude === null)) throw new ValidationError('请同时填写经纬度');
  for (const [value, limit] of [
    [latitude, 90],
    [longitude, 180],
  ] as const) {
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
      throw new ValidationError('经纬度无效');
    }
  }
}

/** 归一化并校验机厅字段，返回可直接写库的形态。 */
function normalizeInput(input: ArcadeInput) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > LIMITS.name) throw new ValidationError('机厅名称无效');

  const rawAliases = input.aliases ?? [];
  if (!Array.isArray(rawAliases) || rawAliases.length > LIMITS.aliasCount) throw new ValidationError('别名无效');
  const aliases = [...new Set(rawAliases.map((item) => String(item).trim()))];
  if (aliases.some((alias) => !alias || alias.length > LIMITS.alias)) {
    throw new ValidationError(`别名长度须为 1–${LIMITS.alias} 字符`);
  }

  const notice = String(input.notice ?? '');
  if (notice.length > LIMITS.notice) throw new ValidationError(`通知最多 ${LIMITS.notice} 字符`);

  const address = String(input.address ?? '');
  const directionGuide = String(input.direction_guide ?? '');
  if (address.length > LIMITS.address || directionGuide.length > LIMITS.address) {
    throw new ValidationError(`地址或引导最多 ${LIMITS.address} 字符`);
  }

  const templates = {
    query_template: String(input.query_template ?? ''),
    report_template: String(input.report_template ?? ''),
    predict_template: String(input.predict_template ?? ''),
  };
  for (const value of Object.values(templates)) {
    if (value.length > LIMITS.template) throw new ValidationError(`消息模板最多 ${LIMITS.template} 字符`);
  }

  const latitude = input.latitude === undefined || input.latitude === null ? null : Number(input.latitude);
  const longitude = input.longitude === undefined || input.longitude === null ? null : Number(input.longitude);
  validateCoordinates(latitude, longitude);

  const machineCount = integer(input.machine_count ?? 1, 1, LIMITS.machineCount);
  const shopId =
    input.nearcade_shop_id === undefined || input.nearcade_shop_id === null
      ? null
      : integer(input.nearcade_shop_id, 1, LIMITS.nearcadeId);
  const gameId =
    input.nearcade_game_id === undefined || input.nearcade_game_id === null
      ? null
      : integer(input.nearcade_game_id, 1, LIMITS.nearcadeId);

  return {
    name,
    aliases,
    machineCount,
    notice,
    latitude,
    longitude,
    address,
    directionGuide,
    shopId,
    gameId,
    ...templates,
  };
}

export class QueueStore {
  private readonly db: Database;
  private readonly now: () => number;

  // 不用构造函数参数属性：Node 的 strip-only TS 执行模式不支持它，
  // 那样就没法用 node --test 直接跑 .ts 单测了。
  constructor(db: Database, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  /** 按别名或 arcade_id 解析本群机厅；解析不到抛 NotFoundError。 */
  async resolve(groupId: string, key: string): Promise<Arcade> {
    const row = await this.db
      .prepare(
        `${SELECT_ARCADE}
         WHERE g.group_id = ?1
           AND (g.arcade_id = ?2
                OR g.arcade_id = (SELECT arcade_id FROM queue_alias WHERE group_id = ?1 AND alias = ?3))`,
      )
      .bind(String(groupId), String(key), normalize(key))
      .first<ArcadeRow>();
    if (!row) throw new NotFoundError('本群未配置该机厅');
    return toArcade(row, this.now());
  }

  /** 解析不到时返回 null，供「这条消息该不该我管」的判断使用。 */
  async tryResolve(groupId: string, key: string): Promise<Arcade | null> {
    try {
      return await this.resolve(groupId, key);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async listArcades(groupId: string): Promise<Arcade[]> {
    const { results } = await this.db
      .prepare(`${SELECT_ARCADE} WHERE g.group_id = ? ORDER BY g.name`)
      .bind(String(groupId))
      .all<ArcadeRow>();
    const now = this.now();
    return (results ?? []).map((row) => toArcade(row, now));
  }

  /** 群总开关。无记录视为启用。 */
  async isEnabled(groupId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT enabled FROM queue_group_setting WHERE group_id = ?')
      .bind(String(groupId))
      .first<{ enabled: number }>();
    return row ? Boolean(row.enabled) : true;
  }

  async setEnabled(groupId: string, enabled: boolean): Promise<boolean> {
    if (typeof enabled !== 'boolean') throw new ValidationError('enabled 必须为布尔值');
    await this.db
      .prepare(
        `INSERT INTO queue_group_setting(group_id, enabled) VALUES(?, ?)
         ON CONFLICT(group_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(String(groupId), enabled ? 1 : 0)
      .run();
    return enabled;
  }

  async createArcade(groupId: string, input: ArcadeInput): Promise<Arcade> {
    const fields = normalizeInput(input);
    const group = String(groupId);
    const shared = input.shared_arcade_id ? String(input.shared_arcade_id) : '';

    if (shared) {
      const exists = await this.db.prepare('SELECT 1 FROM arcade WHERE id = ?').bind(shared).first();
      if (!exists) throw new ValidationError('共享机厅 ID 不存在');
    }
    const arcadeId = shared || crypto.randomUUID().replace(/-/g, '');

    // 别名唯一性靠 queue_alias 的主键保证；先查一遍是为了给出可读的中文错误，
    // 而不是把 D1 的 UNIQUE constraint failed 抛给用户。
    const aliasKeys = [...new Set([fields.name, ...fields.aliases].map((item) => normalize(item)))];
    const placeholders = aliasKeys.map(() => '?').join(',');
    const clash = await this.db
      .prepare(`SELECT alias FROM queue_alias WHERE group_id = ? AND alias IN (${placeholders})`)
      .bind(group, ...aliasKeys)
      .first<{ alias: string }>();
    if (clash) throw new ValidationError('本群已有同名机厅或别名');

    const statements: PreparedStatement[] = [];
    if (!shared) {
      statements.push(this.db.prepare('INSERT INTO arcade(id, count, updated_at) VALUES(?, 0, 0)').bind(arcadeId));
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO group_arcade(
             group_id, arcade_id, name, aliases, machine_count, notice, latitude, longitude,
             address, direction_guide, nearcade_shop_id, nearcade_game_id,
             query_template, report_template, predict_template)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          group,
          arcadeId,
          fields.name,
          JSON.stringify(fields.aliases),
          fields.machineCount,
          fields.notice,
          fields.latitude,
          fields.longitude,
          fields.address,
          fields.directionGuide,
          fields.shopId,
          fields.gameId,
          fields.query_template,
          fields.report_template,
          fields.predict_template,
        ),
    );
    for (const alias of aliasKeys) {
      statements.push(this.db.prepare('INSERT INTO queue_alias(group_id, alias, arcade_id) VALUES(?,?,?)').bind(group, alias, arcadeId));
    }
    await this.db.batch(statements);
    return this.resolve(group, arcadeId);
  }

  async updateArcade(groupId: string, arcadeId: string, patch: Partial<ArcadeInput>): Promise<Arcade> {
    const allowed = new Set([
      'name',
      'aliases',
      'machine_count',
      'notice',
      'latitude',
      'longitude',
      'address',
      'direction_guide',
      'nearcade_shop_id',
      'nearcade_game_id',
      'query_template',
      'report_template',
      'predict_template',
    ]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) throw new ValidationError(`不支持的机厅字段：${key}`);
    }
    const current = await this.resolve(groupId, arcadeId);
    const group = String(groupId);
    // 用当前值补齐未提供的字段后统一校验，避免部分更新绕过校验。
    const merged: ArcadeInput = {
      name: patch.name ?? current.name,
      aliases: patch.aliases ?? current.aliases,
      machine_count: patch.machine_count ?? current.machine_count,
      notice: patch.notice ?? current.notice,
      latitude: patch.latitude === undefined ? current.latitude : patch.latitude,
      longitude: patch.longitude === undefined ? current.longitude : patch.longitude,
      address: patch.address ?? current.address,
      direction_guide: patch.direction_guide ?? current.direction_guide,
      nearcade_shop_id: patch.nearcade_shop_id === undefined ? current.nearcade_shop_id : patch.nearcade_shop_id,
      nearcade_game_id: patch.nearcade_game_id === undefined ? current.nearcade_game_id : patch.nearcade_game_id,
      query_template: patch.query_template ?? current.query_template,
      report_template: patch.report_template ?? current.report_template,
      predict_template: patch.predict_template ?? current.predict_template,
    };
    const fields = normalizeInput(merged);
    const aliasKeys = [...new Set([fields.name, ...fields.aliases].map((item) => normalize(item)))];
    const placeholders = aliasKeys.map(() => '?').join(',');
    const clash = await this.db
      .prepare(`SELECT alias FROM queue_alias WHERE group_id = ? AND arcade_id <> ? AND alias IN (${placeholders})`)
      .bind(group, current.id, ...aliasKeys)
      .first<{ alias: string }>();
    if (clash) throw new ValidationError('本群已有同名机厅或别名');

    const statements: PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE group_arcade SET
             name = ?, aliases = ?, machine_count = ?, notice = ?, latitude = ?, longitude = ?,
             address = ?, direction_guide = ?, nearcade_shop_id = ?, nearcade_game_id = ?,
             query_template = ?, report_template = ?, predict_template = ?
           WHERE group_id = ? AND arcade_id = ?`,
        )
        .bind(
          fields.name,
          JSON.stringify(fields.aliases),
          fields.machineCount,
          fields.notice,
          fields.latitude,
          fields.longitude,
          fields.address,
          fields.directionGuide,
          fields.shopId,
          fields.gameId,
          fields.query_template,
          fields.report_template,
          fields.predict_template,
          group,
          current.id,
        ),
      this.db.prepare('DELETE FROM queue_alias WHERE group_id = ? AND arcade_id = ?').bind(group, current.id),
    ];
    for (const alias of aliasKeys) {
      statements.push(this.db.prepare('INSERT INTO queue_alias(group_id, alias, arcade_id) VALUES(?,?,?)').bind(group, alias, current.id));
    }
    await this.db.batch(statements);
    return this.resolve(group, current.id);
  }

  async deleteArcade(groupId: string, arcadeId: string): Promise<void> {
    const current = await this.resolve(groupId, arcadeId);
    const group = String(groupId);
    await this.db.batch([
      this.db.prepare('DELETE FROM queue_alias WHERE group_id = ? AND arcade_id = ?').bind(group, current.id),
      this.db.prepare('DELETE FROM group_arcade WHERE group_id = ? AND arcade_id = ?').bind(group, current.id),
    ]);
    // 全局机厅只在没有任何群引用时才清掉，跨群共享的不能连带删除。
    await this.db
      .prepare('DELETE FROM arcade WHERE id = ? AND NOT EXISTS (SELECT 1 FROM group_arcade WHERE arcade_id = ?)')
      .bind(current.id, current.id)
      .run();
  }

  /**
   * 上报人数。delta=true 表示增量。
   *
   * 增量必须由数据库自己算（count = count + ?），不能先读再写：D1 没有可跨 await 的
   * 事务，两个人同时 +1 会各读到同一个旧值，其中一次静默丢失。
   */
  async report(groupId: string, arcadeId: string, value: number, delta = false, actor = ''): Promise<Arcade> {
    const amount = integer(value, delta ? -LIMITS.machineCount * 1000 : 0);
    const current = await this.resolve(groupId, arcadeId);
    const now = this.now();
    const group = String(groupId);

    const update = delta
      ? // 夹在 0 与上限之间，避免 -100 把人数打成负数。
        this.db
          .prepare('UPDATE arcade SET count = MAX(0, MIN(100000, count + ?)), updated_at = ? WHERE id = ?')
          .bind(amount, now, current.id)
      : this.db.prepare('UPDATE arcade SET count = ?, updated_at = ? WHERE id = ?').bind(amount, now, current.id);

    await this.db.batch([
      update,
      // 流水里的 count/diff 同样交给 SQL 取真实值，避免与并发上报算出的数不一致。
      this.db
        .prepare(
          `INSERT INTO queue_history(arcade_id, group_id, count, diff, actor, created_at)
           SELECT id, ?, count, count - ?, ?, ? FROM arcade WHERE id = ?`,
        )
        .bind(group, current.count, String(actor).slice(0, 128), now, current.id),
      this.db
        .prepare(
          `DELETE FROM queue_history
           WHERE arcade_id = ?
             AND id NOT IN (SELECT id FROM queue_history WHERE arcade_id = ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`,
        )
        .bind(current.id, current.id),
    ]);
    return this.resolve(group, current.id);
  }

  /** 历史流水。刻意不返回 group_id 与 actor：共享机厅不暴露其他群和上报者。 */
  async history(groupId: string, arcadeId: string, limit = 100): Promise<HistoryEntry[]> {
    const arcade = await this.resolve(groupId, arcadeId);
    const { results } = await this.db
      .prepare('SELECT count, diff, created_at FROM queue_history WHERE arcade_id = ? ORDER BY id DESC LIMIT ?')
      .bind(arcade.id, integer(limit, 1, 1000))
      .all<HistoryEntry>();
    return results ?? [];
  }

  /** 保守预测：只报当前等待与近 2 小时趋势，不做曲线拟合。 */
  async predict(
    groupId: string,
    arcadeId: string,
  ): Promise<{ arcade: Arcade; trend: string; sampleCount: number }> {
    const arcade = await this.resolve(groupId, arcadeId);
    const history = await this.history(groupId, arcade.id, 100);
    const now = this.now();
    const recent = history.filter((row) => now - row.created_at < STALE_AFTER_MS);
    let trend = '数据不足';
    if (recent.length > 1) {
      // history 按时间倒序，recent[0] 最新、末元素最旧。
      const difference = recent[0]!.count - recent[recent.length - 1]!.count;
      trend = difference > 0 ? '上升' : difference < 0 ? '下降' : '持平';
    }
    return { arcade, trend, sampleCount: recent.length };
  }

  /**
   * 幂等：首次见到该 msg_id 返回 true，重复推送返回 false。
   * QQ 平台明确说相同 msg_id 可能多次推送，不去重会重复回复（bot 版的双发老问题）。
   */
  async markMessageSeen(msgId: string): Promise<boolean> {
    const id = String(msgId ?? '').trim();
    if (!id) return true;
    const now = this.now();
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO seen_message(msg_id, created_at) VALUES(?, ?)')
      .bind(id, now)
      .run();
    const inserted = (result.meta?.changes ?? 0) > 0;
    if (inserted) {
      // 顺手清理过期记录，省掉一个 cron。
      await this.db.prepare('DELETE FROM seen_message WHERE created_at < ?').bind(now - SEEN_MESSAGE_TTL_MS).run();
    }
    return inserted;
  }
}
