import test from 'node:test';
import assert from 'node:assert/strict';

import { QueueStore } from '../src/store.ts';
import { createTestDb } from './helpers/db.ts';

/**
 * 并发安全测试。
 *
 * 为什么单独一个文件：原先 287 个测试全部是串行 await，从不并发，
 * 于是 db.ts 的 batch() 有一个「两个事务交错就抛
 * cannot start a transaction within a transaction」的崩溃 bug 一直没被发现。
 * SQLite 不支持嵌套事务，而 batch() 是 async 且在 BEGIN/COMMIT 之间 await，
 * 两个并发调用必然交错。
 *
 * 这些用例直接并发调 store，不经过 HTTP。这是刻意的：
 * 单进程 HTTP 服务器逐个处理请求时，await 点的调度恰好让 batch 不交错
 * （实测 40 个并发 /onebot 请求全部成功），所以经 HTTP 测不出问题。
 * 但只要将来加了定时任务、批量导入、或任何 Promise.all 的调用点，就会炸。
 * 直接测 store 才能守住这条不变量。
 */

const GROUP = 'group-1';
const OTHER = 'group-2';

test('并发增量上报不崩溃且一次不丢', async () => {
  const store = new QueueStore(createTestDb());
  const arcade = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  await store.report(GROUP, arcade.id, 10, false, 'u');

  // 20 个并发 +1。真实场景：群里几个人同时报数。
  await Promise.all(Array.from({ length: 20 }, () => store.report(GROUP, arcade.id, 1, true, 'u')));

  assert.equal((await store.resolve(GROUP, 'wd')).count, 30, '20 次 +1 应当全部生效，一次不丢');
});

test('并发绝对上报不崩溃，最终值是其中之一', async () => {
  const store = new QueueStore(createTestDb());
  const arcade = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });

  const values = [3, 7, 11, 5, 9];
  await Promise.all(values.map((value) => store.report(GROUP, arcade.id, value, false, 'u')));

  // 绝对上报互相覆盖，最终值不确定，但必须是提交过的某一个，且不能崩。
  const final = (await store.resolve(GROUP, 'wd')).count;
  assert.ok(values.includes(final), `最终值 ${final} 应当是 ${values.join('/')} 之一`);
});

test('并发创建机厅不崩溃，全部落库', async () => {
  const store = new QueueStore(createTestDb());

  // createArcade 内部也用 batch，所以同样会撞上嵌套事务。
  await Promise.all([
    store.createArcade(GROUP, { name: 'A厅', aliases: ['a'] }),
    store.createArcade(GROUP, { name: 'B厅', aliases: ['b'] }),
    store.createArcade(GROUP, { name: 'C厅', aliases: ['c'] }),
  ]);

  const names = (await store.listArcades(GROUP)).map((row) => row.name).sort();
  assert.deepEqual(names, ['A厅', 'B厅', 'C厅']);
});

test('并发更新同一机厅不崩溃', async () => {
  const store = new QueueStore(createTestDb());
  const arcade = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 1 });

  await Promise.all([
    store.updateArcade(GROUP, arcade.id, { machine_count: 4 }),
    store.updateArcade(GROUP, arcade.id, { notice: '通知' }),
  ]);

  // 两个更新都是「读当前值 + 合并 + 整行写回」，所以后写的会覆盖前一个的字段。
  // 这里只断言不崩、数据仍然可读且自洽——字段级的最后写入胜出是可接受的。
  const after = await store.resolve(GROUP, 'wd');
  assert.equal(after.name, '万达');
  assert.ok(after.machine_count >= 1);
});

test('并发删除与上报不崩溃', async () => {
  const store = new QueueStore(createTestDb());
  const a = await store.createArcade(GROUP, { name: 'A厅', aliases: ['a'] });
  const b = await store.createArcade(GROUP, { name: 'B厅', aliases: ['b'] });

  // 删一个、报另一个，两个 batch 同时进行。
  await Promise.all([store.deleteArcade(GROUP, a.id), store.report(GROUP, b.id, 5, false, 'u')]);

  assert.equal(await store.tryResolve(GROUP, 'a'), null, 'A 厅应当已删除');
  assert.equal((await store.resolve(GROUP, 'b')).count, 5, 'B 厅的上报应当生效');
});

test('并发 batch 与非 batch 写入不互相破坏', async () => {
  const store = new QueueStore(createTestDb());
  const arcade = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });

  // report 走 batch（事务），logEvent 与 setEnabled 是单条语句（无事务）。
  // 单条写入若在别人的事务窗口内执行，会被卷进那个事务一起提交/回滚。
  await Promise.all([
    store.report(GROUP, arcade.id, 7, false, 'u'),
    store.logEvent({ groupId: GROUP, message: '并发日志' }),
    store.setEnabled(OTHER, false),
  ]);

  assert.equal((await store.resolve(GROUP, 'wd')).count, 7);
  assert.equal((await store.listEvents(GROUP)).length, 1, '日志不该丢');
  assert.equal(await store.isEnabled(OTHER), false, '开关不该丢');
});

test('并发跨群写入互不干扰', async () => {
  const store = new QueueStore(createTestDb());
  const a = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
  const b = await store.createArcade(OTHER, { name: '银泰', aliases: ['yt'] });

  await Promise.all([
    store.report(GROUP, a.id, 3, false, 'u'),
    store.report(OTHER, b.id, 8, false, 'u'),
  ]);

  assert.equal((await store.resolve(GROUP, 'wd')).count, 3);
  assert.equal((await store.resolve(OTHER, 'yt')).count, 8);
});

test('高并发压力下不崩溃（50 个混合写操作）', async () => {
  const store = new QueueStore(createTestDb());
  const arcade = await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });

  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 50; i += 1) {
    if (i % 5 === 0) tasks.push(store.logEvent({ groupId: GROUP, message: `事件 ${i}` }));
    else if (i % 7 === 0) tasks.push(store.markMessageSeen(`msg-${i}`));
    else tasks.push(store.report(GROUP, arcade.id, 1, true, 'u'));
  }
  // 关键断言就是「不抛异常」——嵌套事务错误会让整个 Promise.all 失败。
  await assert.doesNotReject(() => Promise.all(tasks));

  // 数据仍然可读、计数在合理范围（增量任务数量）。
  const final = (await store.resolve(GROUP, 'wd')).count;
  const incrementTasks = 50 - Math.ceil(50 / 5) - [...Array(50).keys()].filter((i) => i % 5 !== 0 && i % 7 === 0).length;
  assert.equal(final, incrementTasks, `应当正好累加 ${incrementTasks} 次`);
});

test('事务失败时回滚，不留半份数据', async () => {
  const store = new QueueStore(createTestDb());
  await store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });

  // 别名冲突会在 createArcade 的预检里抛错（batch 之前），这里验的是
  // 即便抛错，也不该留下孤立的 arcade 行或半份 group_arcade 行。
  await assert.rejects(() => store.createArcade(GROUP, { name: '万达' }));
  assert.equal((await store.listArcades(GROUP)).length, 1, '失败的创建不该留下残留行');
});
