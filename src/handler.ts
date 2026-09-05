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
function emptyGroupHint(): string {
  return '本群尚未配置机厅。管理员可在控制台添加机厅名称与别名后使用排卡。';
}

function helpText(arcades: Arcade[]): string {
  const example = arcades.length ? arcades[0]!.name : '机厅别名';
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
      return await arcadeWeather(arcade, {
        qweatherKey: config.qweatherKey,
        qweatherHost: config.qweatherHost,
      });
    }

    if (parsed.action === 'predict') {
      const prediction = await store.predict(groupId, arcade.id);
      return renderTemplate(arcade.predict_template || DEFAULT_PREDICT_TEMPLATE, prediction.arcade, {
        trend: prediction.trend,
        sampleCount: prediction.sampleCount,
      });
    }

    if (isQuerySuffix(parsed.suffix)) {
      // 查询：优先展示 Nearcade 的实时数据，失败则退回本地并明确告知。
      // 注意用 ?? 而不是 ||：Nearcade 返回 0（真的没人）不能被当成缺数据。
      let external: number | null = null;
      let status = '';
      try {
        external = await fetchAttendance(arcade.nearcade_shop_id, arcade.nearcade_game_id);
      } catch {
        // bot 版这里赋了值却忘了拼进最终文本，用户对外部故障无感知。本版修掉。
        status = '⚠️ Nearcade 暂不可用，以下为本群上报数据。';
      }
      if (external === null && !status && arcade.nearcade_shop_id && arcade.nearcade_game_id) {
        status = 'ℹ️ Nearcade 暂无该机种数据，以下为本群上报数据。';
      }
      // stale 对「从未上报」和「上报过但陈旧」都为 true，但这两种情况要分开说：
      // 从没人报过还提示「已超过 2 小时」是错的（端到端跑真服务时发现）。
      // age_seconds === null 正是「从未上报」的判据。
      if (external === null && arcade.age_seconds === null) {
        status = (status ? status + '\n' : '') + 'ℹ️ 本群还没有人上报过人数，发送「' + arcade.name + '5」即可上报。';
      } else if (external === null && arcade.stale) {
        status = (status ? status + '\n' : '') + '⚠️ 本群上报数据已超过 2 小时，可能不准确。';
      }
      return renderTemplate(arcade.query_template || DEFAULT_QUERY_TEMPLATE, arcade, {
        currentCount: external ?? arcade.count,
        status,
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
    const diff = updated.count - before;
    return renderTemplate(updated.report_template || DEFAULT_REPORT_TEMPLATE, updated, {
      diff: diff ? `(${diff > 0 ? '+' : ''}${diff})` : '',
      status: describeReportOutcome(outcome),
    });
  } catch (error) {
    // 校验类错误把原因告诉用户；其他错误只给通用提示，不泄露内部细节。
    if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof RangeError) {
      return String(error.message);
    }
    if (error instanceof Error && error.message.includes('经纬度')) return error.message;
    return '排卡服务暂不可用，请稍后再试。';
  }
}
