import test from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError, QueueStore, ValidationError } from '../src/store.ts';
import { createTestDb } from './helpers/db.ts';

const GROUP = 'group-openid-A';
const OTHER_GROUP = 'group-openid-B';

/** 可控时钟，避免测试依赖真实时间。 */
function clock(start = Date.UTC(2026, 8, 6, 4, 0, 0)) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function newStore(time = clock()) {
  return { store: new QueueStore(createTestDb(), time.now), time };
}

test('createArcade 写入后能按 id、名称、别名三种方式解析', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', aliases: ['wd', '万达广场'], machine_count: 3 });
  assert.equal(created.name, '万达');
  assert.equal(created.machine_count, 3);
  assert.deepEqual(created.aliases, ['wd', '万达广场']);
  assert.equal(created.count, 0);

  assert.equal((await store.resolve(GROUP, created.id)).id, created.id);
  assert.equal((await store.resolve(GROUP, '万达')).id, created.id);
  assert.equal((await store.resolve(GROUP, 'wd')).id, created.id);
  assert.equal((await store.resolve(GROUP, 'WD')).id, created.id); // 大小写无关
  assert.equal((await store.resolve(GROUP, ' ＷＤ ')).id, created.id); // 全角+空白
});

test('resolve 对未配置的机厅抛 NotFoundError', async () => {
  const { store } = newStore();
  await assert.rejects(() => store.resolve(GROUP, '不存在'), NotFoundError);
});

test('tryResolve 解析不到返回 null 而不抛错', async () => {
  const { store } = newStore();
  assert.equal(await store.tryResolve(GROUP, '不存在'), null);
});

test('别名不跨群泄露：A 群的别名在 B 群解析不到', async () => {
  const { store } = newStore();
  await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  assert.equal(await store.tryResolve(OTHER_GROUP, 'wd'), null);
});

test('createArcade 拒绝本群重复的名称或别名', async () => {
  const { store } = newStore();
  await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await assert.rejects(() => store.createArcade(GROUP, { name: '万达' }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: '其他', aliases: ['wd'] }), ValidationError);
  // 别名与已有机厅的「名称」冲突同样要拦。
  await assert.rejects(() => store.createArcade(GROUP, { name: '其他', aliases: ['万达'] }), ValidationError);
});

test('createArcade 校验字段：名称、别名长度、机台数、坐标', async () => {
  const { store } = newStore();
  await assert.rejects(() => store.createArcade(GROUP, { name: '' }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'a'.repeat(81) }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', aliases: ['a'.repeat(41)] }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', machine_count: 0 }), RangeError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', machine_count: 101 }), RangeError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', notice: 'n'.repeat(1001) }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', latitude: 91, longitude: 0 }), ValidationError);
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', latitude: 0, longitude: 181 }), ValidationError);
  // 只填一个坐标要拒绝
  await assert.rejects(() => store.createArcade(GROUP, { name: 'x', latitude: 30 }), ValidationError);
});

test('shared_arcade_id 让两群共享人数，但叫法与机台数各自独立', async () => {
  const { store } = newStore();
  const a = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 2 });
  const b = await store.createArcade(OTHER_GROUP, {
    name: '万达店',
    aliases: ['wdd'],
    machine_count: 4,
    shared_arcade_id: a.id,
  });
  assert.equal(b.id, a.id);

  await store.report(GROUP, a.id, 9, false, 'u1');
  assert.equal((await store.resolve(OTHER_GROUP, 'wdd')).count, 9); // 人数共享
  assert.equal((await store.resolve(OTHER_GROUP, 'wdd')).machine_count, 4); // 机台数不共享
  assert.equal((await store.resolve(OTHER_GROUP, 'wdd')).name, '万达店'); // 叫法不共享
});

test('shared_arcade_id 指向不存在的机厅时拒绝创建', async () => {
  const { store } = newStore();
  await assert.rejects(
    () => store.createArcade(GROUP, { name: 'x', shared_arcade_id: 'nope' }),
    ValidationError,
  );
});

test('report 设定绝对人数并刷新更新时间', async () => {
  const { store, time } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', machine_count: 2 });
  const after = await store.report(GROUP, created.id, 6, false, 'user1');
  assert.equal(after.count, 6);
  assert.equal(after.updated_at, time.now());
  assert.equal(after.stale, false);
});

test('report 增量上报由数据库累加', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 5, false, 'u');
  assert.equal((await store.report(GROUP, created.id, 2, true, 'u')).count, 7);
  assert.equal((await store.report(GROUP, created.id, -3, true, 'u')).count, 4);
});

test('report 增量不会把人数打成负数', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 2, false, 'u');
  assert.equal((await store.report(GROUP, created.id, -99, true, 'u')).count, 0);
});

test('report 绝对上报拒绝负数', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await assert.rejects(() => store.report(GROUP, created.id, -1, false, 'u'), RangeError);
});

test('report 拒绝非整数人数', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await assert.rejects(() => store.report(GROUP, created.id, 3.5, false, 'u'), RangeError);
});

test('history 记录 count 与 diff，且按时间倒序', async () => {
  const { store, time } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 3, false, 'u');
  time.advance(60000);
  await store.report(GROUP, created.id, 8, false, 'u');
  time.advance(60000);
  await store.report(GROUP, created.id, 5, false, 'u');

  const rows = await store.history(GROUP, created.id, 10);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.count, row.diff]),
    [
      [5, -3],
      [8, 5],
      [3, 3],
    ],
  );
});

test('history 不暴露 group_id 与 actor（共享机厅隐私）', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 3, false, 'secret-user-openid');
  const [row] = await store.history(GROUP, created.id, 1);
  assert.deepEqual(Object.keys(row!).sort(), ['count', 'created_at', 'diff']);
});

test('history 的 limit 越界会被拒绝', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await assert.rejects(() => store.history(GROUP, created.id, 0), RangeError);
  await assert.rejects(() => store.history(GROUP, created.id, 1001), RangeError);
});

test('predict 报告趋势与样本数', async () => {
  const { store, time } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', machine_count: 2 });

  assert.equal((await store.predict(GROUP, created.id)).trend, '数据不足');

  await store.report(GROUP, created.id, 2, false, 'u');
  time.advance(60000);
  await store.report(GROUP, created.id, 9, false, 'u');
  const rising = await store.predict(GROUP, created.id);
  assert.equal(rising.trend, '上升');
  assert.equal(rising.sampleCount, 2);

  time.advance(60000);
  await store.report(GROUP, created.id, 1, false, 'u');
  assert.equal((await store.predict(GROUP, created.id)).trend, '下降');
});

test('predict 忽略两小时之前的旧样本', async () => {
  const { store, time } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 2, false, 'u');
  await store.report(GROUP, created.id, 9, false, 'u');
  time.advance(3 * 3600 * 1000);
  const result = await store.predict(GROUP, created.id);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.trend, '数据不足');
});

test('stale 标记随时间推移变 true', async () => {
  const { store, time } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await store.report(GROUP, created.id, 3, false, 'u');
  assert.equal((await store.resolve(GROUP, created.id)).stale, false);
  time.advance(3 * 3600 * 1000);
  const later = await store.resolve(GROUP, created.id);
  assert.equal(later.stale, true);
  assert.equal(later.age_seconds, 3 * 3600);
});

test('从未上报过的机厅 age_seconds 为 null 且 stale', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  assert.equal(created.age_seconds, null);
  assert.equal(created.stale, true);
});

test('updateArcade 改名后旧别名失效、新别名生效', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await store.updateArcade(GROUP, created.id, { name: '新万达', aliases: ['xwd'] });
  assert.equal(await store.tryResolve(GROUP, 'wd'), null);
  assert.equal((await store.resolve(GROUP, 'xwd')).name, '新万达');
  assert.equal((await store.resolve(GROUP, '新万达')).id, created.id);
});

test('updateArcade 只改一个字段时其余字段不丢', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, {
    name: '万达',
    aliases: ['wd'],
    machine_count: 3,
    notice: '通知',
    latitude: 30.5,
    longitude: 114.3,
    nearcade_shop_id: 11,
    nearcade_game_id: 22,
  });
  const updated = await store.updateArcade(GROUP, created.id, { machine_count: 5 });
  assert.equal(updated.machine_count, 5);
  assert.equal(updated.name, '万达');
  assert.deepEqual(updated.aliases, ['wd']);
  assert.equal(updated.notice, '通知');
  assert.equal(updated.latitude, 30.5);
  assert.equal(updated.longitude, 114.3);
  assert.equal(updated.nearcade_shop_id, 11);
  assert.equal(updated.nearcade_game_id, 22);
});

test('updateArcade 可以把坐标显式清空（需成对置 null）', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', latitude: 30, longitude: 114 });
  const updated = await store.updateArcade(GROUP, created.id, { latitude: null, longitude: null });
  assert.equal(updated.latitude, null);
  assert.equal(updated.longitude, null);
});

test('updateArcade 拒绝与其他机厅冲突的别名，但允许保留自己的别名', async () => {
  const { store } = newStore();
  const a = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await store.createArcade(GROUP, { name: '银泰', aliases: ['yt'] });
  await assert.rejects(() => store.updateArcade(GROUP, a.id, { aliases: ['yt'] }), ValidationError);
  // 自己原有的别名不该被当成冲突
  const kept = await store.updateArcade(GROUP, a.id, { aliases: ['wd'], machine_count: 4 });
  assert.deepEqual(kept.aliases, ['wd']);
});

test('updateArcade 拒绝未知字段', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达' });
  await assert.rejects(
    () => store.updateArcade(GROUP, created.id, { evil: 1 } as never),
    ValidationError,
  );
});

test('deleteArcade 删掉机厅与别名，人数记录一并清理', async () => {
  const { store } = newStore();
  const created = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await store.deleteArcade(GROUP, created.id);
  assert.equal(await store.tryResolve(GROUP, 'wd'), null);
  assert.equal(await store.tryResolve(GROUP, created.id), null);
});

test('deleteArcade 不会连带删除仍被其他群共享的全局机厅', async () => {
  const { store } = newStore();
  const a = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await store.createArcade(OTHER_GROUP, { name: '万达店', aliases: ['wdd'], shared_arcade_id: a.id });
  await store.report(GROUP, a.id, 7, false, 'u');

  await store.deleteArcade(GROUP, a.id);
  assert.equal(await store.tryResolve(GROUP, 'wd'), null);
  const survivor = await store.resolve(OTHER_GROUP, 'wdd');
  assert.equal(survivor.count, 7); // 人数没被误删
});

test('listArcades 只列本群机厅并按名称排序', async () => {
  const { store } = newStore();
  await store.createArcade(GROUP, { name: 'B厅' });
  await store.createArcade(GROUP, { name: 'A厅' });
  await store.createArcade(OTHER_GROUP, { name: 'C厅' });
  const names = (await store.listArcades(GROUP)).map((row) => row.name);
  assert.deepEqual(names, ['A厅', 'B厅']);
});

test('isEnabled 默认启用，setEnabled 可关可开', async () => {
  const { store } = newStore();
  assert.equal(await store.isEnabled(GROUP), true);
  await store.setEnabled(GROUP, false);
  assert.equal(await store.isEnabled(GROUP), false);
  await store.setEnabled(GROUP, true);
  assert.equal(await store.isEnabled(GROUP), true);
});

test('setEnabled 拒绝非布尔值', async () => {
  const { store } = newStore();
  await assert.rejects(() => store.setEnabled(GROUP, 'yes' as never), ValidationError);
});

test('群开关互不影响', async () => {
  const { store } = newStore();
  await store.setEnabled(GROUP, false);
  assert.equal(await store.isEnabled(OTHER_GROUP), true);
});

test('markMessageSeen 首次返回 true，重复返回 false', async () => {
  const { store } = newStore();
  assert.equal(await store.markMessageSeen('msg-1'), true);
  assert.equal(await store.markMessageSeen('msg-1'), false);
  assert.equal(await store.markMessageSeen('msg-2'), true);
});

test('markMessageSeen 对空 msg_id 放行（无法去重时不能吞消息）', async () => {
  const { store } = newStore();
  assert.equal(await store.markMessageSeen(''), true);
  assert.equal(await store.markMessageSeen(''), true);
});

test('markMessageSeen 清理超过 TTL 的旧记录', async () => {
  const { store, time } = newStore();
  await store.markMessageSeen('old');
  time.advance(2 * 3600 * 1000);
  await store.markMessageSeen('new');
  // 旧记录被清掉后，同一个 id 会被视为首次出现。
  assert.equal(await store.markMessageSeen('old'), true);
});
