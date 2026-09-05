import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUERY_TEMPLATE,
  estimateWaitMinutes,
  formatBeijingTime,
  integer,
  isQuerySuffix,
  normalize,
  parseQueueText,
  renderTemplate,
  type Arcade,
} from '../src/queue.ts';

function arcade(overrides: Partial<Arcade> = {}): Arcade {
  return {
    id: 'a1',
    group_id: 'g1',
    name: '万达',
    aliases: ['wd'],
    machine_count: 2,
    notice: '',
    latitude: null,
    longitude: null,
    address: '',
    direction_guide: '',
    nearcade_shop_id: null,
    nearcade_game_id: null,
    query_template: '',
    report_template: '',
    predict_template: '',
    count: 0,
    updated_at: 0,
    age_seconds: null,
    stale: true,
    ...overrides,
  };
}

test('normalize 做 NFKC 归一 + 去空白 + 转小写', () => {
  assert.equal(normalize('  ＷＤ  '), 'wd'); // 全角转半角
  assert.equal(normalize('万达'), '万达');
  assert.equal(normalize('XJJ'), 'xjj');
  assert.equal(normalize(null), '');
  assert.equal(normalize('①'), '1'); // NFKC 把带圈数字展开
});

test('parseQueueText 识别查询后缀「几」和「j」', () => {
  assert.deepEqual(parseQueueText('万达几'), { action: 'report', key: '万达', suffix: '几' });
  assert.deepEqual(parseQueueText('万达j'), { action: 'report', key: '万达', suffix: 'j' });
  assert.deepEqual(parseQueueText('万达J'), { action: 'report', key: '万达', suffix: 'J' });
});

test('parseQueueText 识别设数与增量', () => {
  assert.deepEqual(parseQueueText('万达5'), { action: 'report', key: '万达', suffix: '5' });
  assert.deepEqual(parseQueueText('万达+2'), { action: 'report', key: '万达', suffix: '+2' });
  assert.deepEqual(parseQueueText('万达-1'), { action: 'report', key: '万达', suffix: '-1' });
});

test('parseQueueText 把裸别名当查询（bot 版 6f0f139 行为）', () => {
  assert.deepEqual(parseQueueText('wd'), { action: 'report', key: 'wd', suffix: '几' });
});

test('parseQueueText 识别 predict / weather 前缀且大小写无关', () => {
  assert.deepEqual(parseQueueText('predict 万达'), { action: 'predict', key: '万达', suffix: null });
  assert.deepEqual(parseQueueText('WEATHER 万达'), { action: 'weather', key: '万达', suffix: null });
});

test('parseQueueText 识别帮助与列表', () => {
  assert.equal(parseQueueText('排卡帮助')?.action, 'help');
  assert.equal(parseQueueText('排卡教程')?.action, 'help');
  assert.equal(parseQueueText('排卡列表')?.action, 'list');
});

test('parseQueueText 空串返回 null', () => {
  assert.equal(parseQueueText(''), null);
  assert.equal(parseQueueText('   '), null);
  assert.equal(parseQueueText(null), null);
});

test('isQuerySuffix 只认「几」和 j', () => {
  assert.equal(isQuerySuffix('几'), true);
  assert.equal(isQuerySuffix('j'), true);
  assert.equal(isQuerySuffix('J'), true);
  assert.equal(isQuerySuffix('5'), false);
  assert.equal(isQuerySuffix('+2'), false);
  assert.equal(isQuerySuffix(null), false);
});

test('estimateWaitMinutes：人数未超容量时为 0', () => {
  // 2 台 = 容量 4 人
  assert.equal(estimateWaitMinutes(0, 2), 0);
  assert.equal(estimateWaitMinutes(4, 2), 0);
});

test('estimateWaitMinutes：超出容量按轮次累加 17 分钟', () => {
  assert.equal(estimateWaitMinutes(5, 2), 17); // 排队 1 人 → 1 轮
  assert.equal(estimateWaitMinutes(8, 2), 17); // 排队 4 人 → 1 轮
  assert.equal(estimateWaitMinutes(9, 2), 34); // 排队 5 人 → 2 轮
});

test('estimateWaitMinutes：机台数为 0 或负数时按 1 台兜底', () => {
  assert.equal(estimateWaitMinutes(3, 0), 17); // 容量 2，排队 1
  assert.equal(estimateWaitMinutes(3, -5), 17);
});

test('integer 拒绝非整数、布尔值与越界值', () => {
  assert.equal(integer(5), 5);
  assert.equal(integer(0), 0);
  assert.throws(() => integer(1.5), RangeError);
  assert.throws(() => integer(true as unknown as number), RangeError);
  assert.throws(() => integer(Number.NaN), RangeError);
  assert.throws(() => integer(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => integer(-1), RangeError);
  assert.throws(() => integer(100001), RangeError);
  assert.throws(() => integer('5' as unknown as number), RangeError);
});

test('integer 允许显式放宽下界（增量上报要收负数）', () => {
  assert.equal(integer(-3, -100000), -3);
});

test('formatBeijingTime 输出 UTC+8 且能正确跨日', () => {
  // 2026-09-05T16:30:00Z = 北京时间 2026-09-06 00:30:00
  assert.equal(formatBeijingTime(Date.UTC(2026, 8, 5, 16, 30, 0)), '2026-09-06 00:30:00');
  assert.equal(formatBeijingTime(Date.UTC(2026, 8, 5, 0, 0, 0)), '2026-09-05 08:00:00');
});

test('renderTemplate 替换已知占位符，保留未知占位符', () => {
  const text = renderTemplate('{displayName} {currentCount} {unknownKey}', arcade({ count: 7 }));
  assert.equal(text, '万达 7 {unknownKey}');
});

test('renderTemplate 的 currentCount 可被外部数据覆盖', () => {
  const text = renderTemplate('{currentCount}', arcade({ count: 3 }), { currentCount: 11 });
  assert.equal(text, '11');
});

test('renderTemplate 的 currentCount 覆盖值为 0 时不被当成缺失', () => {
  // ?? 与 || 的区别：用 || 会让「0 人」退回本地计数，是真实存在的语义 bug。
  const text = renderTemplate('{currentCount}', arcade({ count: 3 }), { currentCount: 0 });
  assert.equal(text, '0');
});

test('renderTemplate 的 waitTime 随人数自动计算，也可显式指定', () => {
  assert.equal(renderTemplate('{waitTime}', arcade({ count: 9, machine_count: 2 })), '34');
  assert.equal(renderTemplate('{waitTime}', arcade({ count: 9, machine_count: 2 }), { waitTime: 5 }), '5');
});

test('renderTemplate 的 waitTime 显式为 0 时不退回自动计算', () => {
  assert.equal(renderTemplate('{waitTime}', arcade({ count: 9, machine_count: 2 }), { waitTime: 0 }), '0');
});

test('renderTemplate 无通知时不产生空的通知块', () => {
  assert.equal(renderTemplate('{noticeBlock}', arcade({ notice: '' })), '');
  assert.equal(renderTemplate('{noticeBlock}', arcade({ notice: '今日闭店' })), '🪧 店铺通知：\n\n今日闭店');
});

test('renderTemplate 未配置 Nearcade 时不产出店铺链接', () => {
  assert.equal(renderTemplate('{nearcadeLink}', arcade()), '');
  assert.equal(
    renderTemplate('{nearcadeLink}', arcade({ nearcade_shop_id: 42 })),
    'Nearcade 店铺链接：https://nearcade.cn/shops/42',
  );
});

test('renderTemplate 压掉连续空行并去首尾空白', () => {
  assert.equal(renderTemplate('a\n\n\n\n{notice}\n\n\nb', arcade()), 'a\n\nb');
});

test('renderTemplate 未上报过时更新时间显示「暂无」且 minutesAgo 为空', () => {
  assert.equal(renderTemplate('{updateTime}|{minutesAgo}', arcade({ updated_at: 0 })), '暂无|');
});

test('renderTemplate 的 minutesAgo 按当前时间算分钟差', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const text = renderTemplate('{minutesAgo}', arcade({ updated_at: now - 5 * 60000 }), { now });
  assert.equal(text, '5');
});

test('默认查询模板能完整渲染，不残留占位符', () => {
  const now = Date.UTC(2026, 8, 6, 4, 0, 0);
  const text = renderTemplate(
    DEFAULT_QUERY_TEMPLATE,
    arcade({ count: 6, machine_count: 2, updated_at: now - 60000, notice: '空调坏了', nearcade_shop_id: 7 }),
    { now, status: 'Nearcade 暂不可用，已显示本地数据。' },
  );
  assert.doesNotMatch(text, /\{[A-Za-z0-9_]+\}/, `残留占位符：${text}`);
  assert.match(text, /6 人/);
  assert.match(text, /17 分钟/);
  assert.match(text, /空调坏了/);
  assert.match(text, /Nearcade 暂不可用/);
});

test('freshness 占位符把整句都包进去，避免残缺文本', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  // 从未上报过：不能渲染出「( 分钟前)」这种半句话。
  assert.equal(renderTemplate('{freshness}', arcade({ updated_at: 0 }), { now }), '(尚未上报)');
  assert.equal(renderTemplate('{freshness}', arcade({ updated_at: now - 5 * 60000 }), { now }), '(5 分钟前)');
  assert.equal(renderTemplate('{freshness}', arcade({ updated_at: now }), { now }), '(0 分钟前)');
});

test('默认查询模板在从未上报时不产生残缺语句', () => {
  const text = renderTemplate(DEFAULT_QUERY_TEMPLATE, arcade({ updated_at: 0 }), { now: Date.now() });
  assert.doesNotMatch(text, /\(\s+分钟前\)/, `残缺文本：${text}`);
  assert.doesNotMatch(text, /\{[A-Za-z0-9_]+\}/, `残留占位符：${text}`);
  assert.match(text, /尚未上报/);
});
