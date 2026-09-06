/**
 * 排卡的纯逻辑：别名归一化、指令语法解析、等待时间估算、消息模板渲染。
 *
 * 这一层刻意不碰 D1、不发网络请求，方便直接单测。
 * 行为对齐 bot 版 libraries/maimaidx_group_queue.py 与 command/mai_queue.py，
 * 差异都在注释里点出来。
 */

/** 机厅记录（group_arcade 与 arcade 连接后的形态）。 */
export interface Arcade {
  id: string;
  group_id: string;
  name: string;
  aliases: string[];
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
  age_seconds: number | null;
  stale: boolean;
}

export type QueueAction = 'report' | 'predict' | 'weather' | 'help' | 'list';

export interface ParsedCommand {
  action: QueueAction;
  key: string;
  suffix: string | null;
}

/**
 * 别名归一化。
 *
 * Python 用 unicodedata.normalize('NFKC', v).strip().casefold()。
 * JS 没有 casefold，用 toLowerCase 代替：对中文/数字/拉丁字母（本项目的实际别名空间）
 * 两者结果一致；差异只出现在德语 ß、希腊语尾 sigma 之类，机厅别名里不会出现。
 * 归一化后的值同时用于写入 queue_alias 和查询，所以两侧一致即可。
 */
export function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

export const DEFAULT_QUERY_TEMPLATE =
  '→ {currentCount} 人 {freshness}\n\n🕰 更新时间：{updateTime}\n\n⌛️ 大约需要 {waitTime} 分钟才能上机\n\n{noticeBlock}\n\n{externalStatus}';

export const DEFAULT_REPORT_TEMPLATE =
  '→ {currentCount} 人 {diff}\n\n🕰 更新时间：{updateTime}\n\n⌛️ 大约需要 {waitTime} 分钟才能上机\n\n{nearcadeSyncStatus}';

export const DEFAULT_PREDICT_TEMPLATE =
  '→ 🔮 预测报告！\n\n🎮 {displayName}\n\n🎉 目前人数: {currentCount} 人\n\n⌛️ 预测等待: {waitTime} 分钟\n\n趋势: {trendDesc}\n\n样本数: {sampleCount}\n\n{forecastDisclaimer}\n\n更新时间: {updateTime}\n{nearcadeLink}';

/** 人人可用的前缀指令。管理类（subweather 等）在本版不存在：天气改按需查。 */
const PREFIX_PATTERN = /^(predict|weather)\s+(.+)$/i;

/** `<别名>几` / `<别名>j` / `<别名>5` / `<别名>+2` / `<别名>-1`。 */
const REPORT_PATTERN = /^(.+?)(几|j|[+-]?\d+)$/i;

const HELP_WORDS = new Set(['排卡帮助', '排卡教程']);
const LIST_WORDS = new Set(['排卡列表']);

/**
 * 只做语法解析，不解析别名归属——调用方还要按群校验别名能否解析。
 * 解析不出来返回 null，让消息落回普通聊天（对应 bot 版 6328d1d 的教训：
 * 匹配太宽会把群里正常说话吃掉）。
 */
export function parseQueueText(raw: unknown): ParsedCommand | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (HELP_WORDS.has(text)) return { action: 'help', key: '', suffix: null };
  if (LIST_WORDS.has(text)) return { action: 'list', key: '', suffix: null };

  const prefixed = PREFIX_PATTERN.exec(text);
  if (prefixed) {
    return { action: prefixed[1]!.toLowerCase() as QueueAction, key: prefixed[2]!.trim(), suffix: null };
  }

  const report = REPORT_PATTERN.exec(text);
  if (report) return { action: 'report', key: report[1]!.trim(), suffix: report[2]! };

  // 裸别名视为查询（bot 版 6f0f139：让「wd」这种短别名不带后缀也能用）。
  return { action: 'report', key: text, suffix: '几' };
}

/** 后缀是否表示「查人数」而非「改人数」。 */
export function isQuerySuffix(suffix: string | null): boolean {
  return suffix === '几' || suffix?.toLowerCase() === 'j';
}

/**
 * 等待时间估算。刻意保守，不是训练模型。
 * 容量 = 机台数 × 每台人数；排队 = max(0, 人数 - 容量)；等待 = ceil(排队/容量) × 轮长。
 */
export function estimateWaitMinutes(
  count: number,
  machineCount: number,
  { playersPerMachine = 2, roundMinutes = 17 } = {},
): number {
  const machines = Math.max(1, Math.trunc(machineCount) || 1);
  const capacity = machines * Math.max(1, Math.trunc(playersPerMachine) || 1);
  const queued = Math.max(0, Math.trunc(count) - capacity);
  if (!queued) return 0;
  return Math.ceil(queued / capacity) * Math.trunc(roundMinutes);
}

/** 校验整数并给出中文错误，对齐 bot 版 integer()。 */
export function integer(value: unknown, low = 0, high = 100000): number {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`数值必须是 ${low} 至 ${high} 的整数`);
  }
  if (value < low || value > high) throw new RangeError(`数值必须是 ${low} 至 ${high} 的整数`);
  return value;
}

/** 北京时间格式化。生产环境时区不可假设，一律显式 UTC+8。 */
export function formatBeijingTime(epochMs: number): string {
  const shifted = new Date(epochMs + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

export interface RenderOptions {
  currentCount?: number | null;
  diff?: string;
  /** Nearcade 同步/读取状态，同时喂给 nearcadeSyncStatus 与 externalStatus。 */
  status?: string;
  waitTime?: number | null;
  trend?: string;
  sampleCount?: number;
  now?: number;
}

/**
 * 模板渲染：把 {占位符} 替换成实际值，未知占位符原样保留。
 * bot 版留了一批预测相关的空壳占位符（forecastSchedule 等，渲染为 0/空串），
 * 本版删掉了那些永远为空的，只保留真有数据的，避免模板里出现莫名空行。
 */
export function renderTemplate(template: string, arcade: Arcade, options: RenderOptions = {}): string {
  const now = options.now ?? Date.now();
  const count = options.currentCount ?? arcade.count;
  const updated = arcade.updated_at;
  const notice = arcade.notice || '';
  const status = options.status || '';
  const waitTime = options.waitTime ?? estimateWaitMinutes(count, arcade.machine_count);
  const values: Record<string, string | number> = {
    name: arcade.name,
    displayName: arcade.name,
    gameTitle: '舞萌DX',
    currentCount: count,
    machineCount: arcade.machine_count,
    updateTime: updated ? formatBeijingTime(updated) : '暂无',
    minutesAgo: updated ? Math.floor(Math.max(0, now - updated) / 60000) : '',
    // 整句都放在占位符里。早期版本把「分钟前」写死在模板上、只把数字做成占位符，
    // 结果从未上报过时渲染出「( 分钟前)」这种残句（端到端跑真服务时才发现）。
    freshness: updated ? `(${Math.floor(Math.max(0, now - updated) / 60000)} 分钟前)` : '(尚未上报)',
    notice,
    noticeBlock: notice ? `🪧 店铺通知：\n\n${notice}` : '',
    address: arcade.address || '',
    directionGuide: arcade.direction_guide || '',
    waitTime,
    nextPlayTime: waitTime,
    diff: options.diff || '',
    nearcadeLink: arcade.nearcade_shop_id ? `Nearcade 店铺链接：https://nearcade.cn/shops/${arcade.nearcade_shop_id}` : '',
    nearcadeSyncStatus: status,
    externalStatus: status,
    trendDesc: options.trend || '数据不足',
    sampleCount: options.sampleCount ?? 0,
    predictionMethod: '按每台两人、每轮 17 分钟估算',
    forecastDisclaimer: '预测仅供参考，实际人数以现场为准；陈旧上报可能不准确。',
  };
  const rendered = String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
  // 空占位符会留下连续空行，压掉多余的。
  return rendered.replace(/\n{3,}/g, '\n\n').trim();
}
