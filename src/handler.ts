/**
 * 指令分发：收到群消息文本 → 决定回什么。
 *
 * 这里是唯一把 store / nearcade / weather 缝起来的地方，但它自己不碰 HTTP、
 * 不碰签名、不发消息——只返回「该回什么文本」或 null（表示这条消息不管）。
 * 这样整条业务链路可以在本机完整单测。
 */

import {
  DEFAULT_PREDICT_TEMPLATE,
  DEFAULT_QUERY_TEMPLATE,
  DEFAULT_REPORT_TEMPLATE,
  isQuerySuffix,
  parseQueueText,
  renderTemplate,
  type Arcade,
} from './queue.ts';
import { describeReportOutcome, fetchAttendance, reportAttendance } from './nearcade.ts';
import { NotFoundError, ValidationError, type QueueStore } from './store.ts';
import { arcadeWeather } from './weather.ts';

export interface HandlerConfig {
  nearcadeToken?: string;
  qweatherKey?: string;
  qweatherHost?: string;
}

export interface HandleContext {
  store: QueueStore;
  groupId: string;
  userId: string;
  text: string;
  config?: HandlerConfig;
}

/** 群里没配任何机厅时的引导语。 */
/**
 * 举例时用哪个叫法：挑最好打的那个别名，没有别名才退回机厅全名。
 * 机厅全名常常很长（含括号、分店名），拼进提示语里很难读。
 *
 * 排序规则：纯 ASCII（如 wd、hy）优先于含中文的，其次才比长度。
 * 因为字符数相同时，拼音缩写比中文更好打也更短——`hy` 比 `焕游` 更适合当例子。
 */
function shortestLabel(arcade: Arcade): string {
  const candidates = arcade.aliases.map((alias) => alias.trim()).filter(Boolean);
  if (!candidates.length) return arcade.name;
  const rank = (value: string): [number, number] => [/^[\x20-\x7e]+$/.test(value) ? 0 : 1, value.length];
  return candidates.reduce((best, current) => {
    const [bestAscii, bestLen] = rank(best);
    const [currentAscii, currentLen] = rank(current);
    if (currentAscii !== bestAscii) return currentAscii < bestAscii ? current : best;
    return currentLen < bestLen ? current : best;
  });
}

function emptyGroupHint(): string {
  return '本群尚未配置机厅。管理员可在控制台添加机厅名称与别名后使用排卡。';
}

function helpText(arcades: Arcade[]): string {
  // 同样用最短别名举例，否则帮助里每行都拖着一个长机厅名，六行看下来很累。
  const example = arcades.length ? shortestLabel(arcades[0]!) : '机厅别名';
  return [
    '排卡使用指引：',
    `· 查人数：${example}几 / ${example}j / 直接发 ${example}`,
    `· 设人数：${example}5`,
    `· 加减人：${example}+1 / ${example}-1`,
    `· 预测：predict ${example}`,
    `· 天气：weather ${example}`,
    '发送「排卡列表」查看本群已配置的机厅。',
  ].join('\n');
}

function listText(arcades: Arcade[]): string {
  if (!arcades.length) return emptyGroupHint();
  const lines = ['本群排卡机厅：'];
  for (const arcade of arcades) {
    const aliases = arcade.aliases.length ? `（${arcade.aliases.join('、')}）` : '';
    lines.push(`· ${arcade.name}${aliases}：${arcade.count} 人 · ${arcade.machine_count} 台`);
  }
  return lines.join('\n');
}

/**
 * 处理一条群消息。
 *
 * 返回 null 表示「这条消息不是排卡指令」——必须保持沉默，不能回任何提示。
 * bot 版 6328d1d 的教训：匹配过宽会把群里正常聊天全吃掉。
 */
export async function handleGroupMessage(context: HandleContext): Promise<string | null> {
  const { store, groupId, userId, text } = context;
  const config = context.config ?? {};

  const parsed = parseQueueText(text);
  if (!parsed) return null;

  // 群总开关关掉后，连帮助和列表都不响应（等于本群没这个功能）。
  if (!(await store.isEnabled(groupId))) return null;

  if (parsed.action === 'help') return helpText(await store.listArcades(groupId));
  if (parsed.action === 'list') return listText(await store.listArcades(groupId));

  // 别名解析不了就当普通聊天放过去。这是「该不该我管」的最后一道门。
  const arcade = await store.tryResolve(groupId, parsed.key);
  if (!arcade) return null;

  try {
    if (parsed.action === 'weather') {
      try {
        return await arcadeWeather(arcade, {
          qweatherKey: config.qweatherKey,
          qweatherHost: config.qweatherHost,
        });
      } catch (error) {
        // 「没填经纬度」是用户能自己解决的，照旧告诉他；
        // 其他失败（两家供应商都挂）只记日志，群里给通用提示。
        if (error instanceof Error && error.message.includes('经纬度')) throw error;
        await store.logEvent({
          groupId,
          arcade: arcade.name,
          level: 'warn',
          kind: 'weather',
          message: `查天气失败：${error instanceof Error ? error.message : String(error)}`,
        });
        return '天气服务暂不可用，请稍后再试。';
      }
    }

    if (parsed.action === 'predict') {
      const prediction = await store.predict(groupId, arcade.id);
      return renderTemplate(arcade.predict_template || DEFAULT_PREDICT_TEMPLATE, prediction.arcade, {
        trend: prediction.trend,
        sampleCount: prediction.sampleCount,
      });
    }

    if (isQuerySuffix(parsed.suffix)) {
      // 查询：优先展示 Nearcade 的实时数据，失败则退回本地。
      // 注意用 ?? 而不是 ||：Nearcade 返回 0（真的没人）不能被当成缺数据。
      //
      // 所有异常情况只记进运行日志、不进群消息——群里只该有那三行人数信息。
      // 维护者在控制台的「运行日志」里看。
      let external: number | null = null;
      try {
        external = await fetchAttendance(arcade.nearcade_shop_id, arcade.nearcade_game_id);
      } catch (error) {
        await store.logEvent({
          groupId,
          arcade: arcade.name,
          level: 'warn',
          kind: 'nearcade.read',
          message: `读取 Nearcade 人数失败，已用本群上报数据：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (external === null && arcade.nearcade_shop_id && arcade.nearcade_game_id) {
        await store.logEvent({
          groupId,
          arcade: arcade.name,
          level: 'info',
          kind: 'nearcade.read',
          message: `Nearcade 没有该机种（gameId=${arcade.nearcade_game_id}）的人数数据，已用本群上报数据`,
        });
      }
      // stale 对「从未上报」和「上报过但陈旧」都为 true，两种情况分开记：
      // 从没人报过时说「已超过 2 小时」是错的说法。
      if (external === null && arcade.age_seconds === null) {
        await store.logEvent({
          groupId,
          arcade: arcade.name,
          level: 'info',
          kind: 'stale',
          message: `本群还没有人上报过该机厅人数（可在群里发「${shortestLabel(arcade)}5」上报）`,
        });
      } else if (external === null && arcade.stale) {
        const hours = arcade.age_seconds === null ? 0 : Math.floor(arcade.age_seconds / 3600);
        await store.logEvent({
          groupId,
          arcade: arcade.name,
          level: 'warn',
          kind: 'stale',
          message: `本群上报数据已陈旧（约 ${hours} 小时前），显示的人数可能不准`,
        });
      }
      return renderTemplate(arcade.query_template || DEFAULT_QUERY_TEMPLATE, arcade, {
        currentCount: external ?? arcade.count,
      });
    }

    // 上报：suffix 形如 "5"、"+2"、"-1"。
    const suffix = parsed.suffix ?? '';
    const delta = suffix.startsWith('+') || suffix.startsWith('-');
    const value = Number.parseInt(suffix, 10);
    if (!Number.isFinite(value)) return null;

    const before = arcade.count;
    const updated = await store.report(groupId, arcade.id, value, delta, userId);
    const outcome = await reportAttendance(
      updated.nearcade_shop_id,
      updated.nearcade_game_id,
      updated.count,
      String(config.nearcadeToken ?? ''),
    );
    // 同步结果只记日志，不进群消息。「未配置 Token」「同步未确认」这类信息
    // 群友看不懂也管不了，但维护者需要知道。
    await store.logEvent({
      groupId,
      arcade: updated.name,
      level: outcome.status === 'unconfirmed' ? 'warn' : 'info',
      kind: 'nearcade.write',
      message: `上报 ${updated.count} 人：${describeReportOutcome(outcome)}`,
    });
    const diff = updated.count - before;
    return renderTemplate(updated.report_template || DEFAULT_REPORT_TEMPLATE, updated, {
      diff: diff ? `(${diff > 0 ? '+' : ''}${diff})` : '',
    });
  } catch (error) {
    // 校验类错误把原因告诉用户（是他输入的问题，他能改）。
    if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof RangeError) {
      return String(error.message);
    }
    if (error instanceof Error && error.message.includes('经纬度')) return error.message;
    // 其他错误：群里只给一句通用提示，细节进运行日志供排查。
    await store.logEvent({
      groupId,
      arcade: arcade.name,
      level: 'error',
      kind: 'command',
      message: `处理「${text}」时出错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    });
    return '排卡服务暂不可用，请稍后再试。';
  }
}
