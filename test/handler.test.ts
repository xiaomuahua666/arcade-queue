import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGroupMessage } from '../src/handler.ts';
import { QueueStore } from '../src/store.ts';
import { createTestDb } from './helpers/db.ts';
import { stubFetch, type FetchStub } from './helpers/fetch.ts';

const GROUP = 'group-openid';
const USER = 'user-openid';

function clock(start = Date.UTC(2026, 8, 6, 4, 0, 0)) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

interface Fixture {
  store: QueueStore;
  time: ReturnType<typeof clock>;
  stub: FetchStub;
  say(text: string, config?: Parameters<typeof handleGroupMessage>[0]['config']): Promise<string | null>;
}

function fixture(): Fixture {
  const time = clock();
  const store = new QueueStore(createTestDb(), time.now);
  const stub = stubFetch();
  return {
    store,
    time,
    stub,
    say(text, config) {
      return handleGroupMessage({ store, groupId: GROUP, userId: USER, text, config });
    },
  };
}

test('不认识的消息返回 null，绝不刷屏', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    assert.equal(await f.say('今天天气不错'), null);
    assert.equal(await f.say(''), null);
    assert.equal(await f.say('不存在的厅几'), null);
    // 「随便说点什么5」这种语法上像上报、但别名解析不了的，也必须沉默
    assert.equal(await f.say('随便说点什么5'), null);
  } finally {
    f.stub.restore();
  }
});

test('群开关关掉后连帮助都不响应', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.setEnabled(GROUP, false);
    assert.equal(await f.say('排卡帮助'), null);
    assert.equal(await f.say('万达几'), null);
    assert.equal(await f.say('排卡列表'), null);
  } finally {
    f.stub.restore();
  }
});

test('排卡帮助用本群真实机厅的别名举例', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const text = await f.say('排卡帮助');
    // 举例用别名而非全名，见 shortestLabel()。
    assert.match(text!, /wd几/);
    assert.match(text!, /predict wd/);
  } finally {
    f.stub.restore();
  }
});

test('没配机厅时排卡列表给出引导', async () => {
  const f = fixture();
  try {
    assert.match((await f.say('排卡列表'))!, /尚未配置机厅/);
  } finally {
    f.stub.restore();
  }
});

test('排卡列表展示人数与机台数', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 3 });
    await f.store.report(GROUP, a.id, 5, false, USER);
    const text = await f.say('排卡列表');
    assert.match(text!, /万达（wd）：5 人 · 3 台/);
  } finally {
    f.stub.restore();
  }
});

test('查询走本地数据（未配 Nearcade 时不发外部请求）', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 2 });
    await f.store.report(GROUP, a.id, 6, false, USER);
    const text = await f.say('万达几');
    assert.match(text!, /6 人/);
    assert.match(text!, /17 分钟/); // 2 台=容量4，排队2 → 1 轮
    assert.equal(f.stub.calls.length, 0);
  } finally {
    f.stub.restore();
  }
});

test('裸别名与 j 后缀都能查', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 4, false, USER);
    for (const input of ['wd', 'wd几', 'wdj', 'WD']) {
      assert.match((await f.say(input))!, /4 人/, `输入：${input}`);
    }
  } finally {
    f.stub.restore();
  }
});

test('配了 Nearcade 时查询展示外部实时人数', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    await f.store.report(GROUP, a.id, 3, false, USER);
    f.stub.onJson('/attendance', { games: [{ gameId: 2, total: 11 }] });
    const text = await f.say('万达几');
    assert.match(text!, /11 人/);
    assert.doesNotMatch(text!, /暂不可用/);
  } finally {
    f.stub.restore();
  }
});

test('Nearcade 返回 0 人时如实显示 0，不退回本地数据', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    await f.store.report(GROUP, a.id, 7, false, USER);
    f.stub.onJson('/attendance', { games: [{ gameId: 2, total: 0 }] });
    const text = await f.say('万达几');
    assert.match(text!, /0 人/);
    assert.doesNotMatch(text!, /7 人/);
  } finally {
    f.stub.restore();
  }
});

test('Nearcade 故障记进运行日志，群消息里不出现', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.stub.onJson('/attendance', {}, 502);
    const text = await f.say('万达几');

    // 群里只有人数，外部故障绝不出现
    assert.match(text!, /5 人/);
    assert.doesNotMatch(text!, /Nearcade/);
    assert.doesNotMatch(text!, /不可用/);

    // 但维护者必须能在控制台看到
    const events = await f.store.listEvents(GROUP);
    const hit = events.find((e) => e.kind === 'nearcade.read' && e.level === 'warn');
    assert.ok(hit, `运行日志应记下读取失败：${JSON.stringify(events)}`);
    assert.match(hit!.message, /失败/);
    assert.equal(hit!.arcade, '万达');
  } finally {
    f.stub.restore();
  }
});

test('Nearcade 无该机种数据与「故障」在日志里可区分', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 999,
    });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.stub.onJson('/attendance', { games: [{ gameId: 2, total: 3 }] });
    const text = await f.say('万达几');

    assert.doesNotMatch(text!, /Nearcade/, '群消息里不该出现外部服务信息');

    const events = await f.store.listEvents(GROUP);
    const hit = events.find((e) => e.kind === 'nearcade.read');
    assert.ok(hit);
    // 「没有该机种数据」是 info，不是 warn——这不是故障
    assert.equal(hit!.level, 'info');
    assert.match(hit!.message, /没有该机种/);
  } finally {
    f.stub.restore();
  }
});

test('本地数据陈旧记进日志，群消息不受影响', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.time.advance(3 * 3600 * 1000);
    const text = await f.say('万达几');

    assert.doesNotMatch(text!, /陈旧|不准|小时/, '群里只该有人数三行');

    const events = await f.store.listEvents(GROUP);
    const hit = events.find((e) => e.kind === 'stale');
    assert.ok(hit, '陈旧应当记进日志');
    assert.equal(hit!.level, 'warn');
    assert.match(hit!.message, /陈旧/);
    assert.match(hit!.message, /3 小时/);
  } finally {
    f.stub.restore();
  }
});

test('上报绝对人数并回报差值', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 2 });
    await f.store.report(GROUP, a.id, 3, false, USER);
    const text = await f.say('万达8');
    assert.match(text!, /8 人/);
    assert.match(text!, /\(\+5\)/);
    assert.equal((await f.store.resolve(GROUP, 'wd')).count, 8);
  } finally {
    f.stub.restore();
  }
});

test('增量上报（+2 / -1）正确累加并显示差值', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    assert.match((await f.say('万达+2'))!, /7 人/);
    const text = await f.say('万达-3');
    assert.match(text!, /4 人/);
    assert.match(text!, /\(-3\)/);
  } finally {
    f.stub.restore();
  }
});

test('上报人数不变时不显示差值', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    const text = await f.say('万达5');
    assert.doesNotMatch(text!, /\([+-]/);
  } finally {
    f.stub.restore();
  }
});

test('未配 Nearcade token 时不发外部请求，未同步只记日志', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    const text = await f.say('万达5');
    assert.equal(f.stub.calls.length, 0, '没 token 就不该发请求');
    assert.doesNotMatch(text!, /Token|同步/, '群里不该出现同步状态');

    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'nearcade.write');
    assert.ok(hit);
    assert.match(hit!.message, /未配置 Nearcade Token/);
  } finally {
    f.stub.restore();
  }
});

test('配了 token 时上报会写回 Nearcade', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    f.stub.onJson('/attendance', { ok: true });
    const text = await f.say('万达5', { nearcadeToken: 'nk_x' });
    assert.doesNotMatch(text!, /Nearcade/, '群里不该出现同步状态');
    const call = f.stub.calls.find((item) => item.method === 'POST')!;
    assert.deepEqual(JSON.parse(call.body!).games, [{ id: 2, currentAttendances: 5 }]);

    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'nearcade.write');
    assert.ok(hit);
    assert.equal(hit!.level, 'info');
    assert.match(hit!.message, /已同步 Nearcade/);
  } finally {
    f.stub.restore();
  }
});

test('Nearcade 写入失败时提示未确认且不重试', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    f.stub.onError('/attendance');
    const text = await f.say('万达5', { nearcadeToken: 'nk_x' });
    assert.doesNotMatch(text!, /未确认|重试/, '群里不该出现同步细节');
    assert.equal(f.stub.countFor('/attendance'), 1, '写接口只能发一次');
    // 本地数据仍然要保存成功
    assert.equal((await f.store.resolve(GROUP, 'wd')).count, 5);

    // 同步未确认属于要人关注的情况，级别是 warn
    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'nearcade.write');
    assert.ok(hit);
    assert.equal(hit!.level, 'warn');
    assert.match(hit!.message, /未确认/);
    assert.match(hit!.message, /不自动重试/);
  } finally {
    f.stub.restore();
  }
});

test('predict 报告等待与趋势', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 2 });
    await f.store.report(GROUP, a.id, 2, false, USER);
    f.time.advance(60000);
    await f.store.report(GROUP, a.id, 9, false, USER);
    const text = await f.say('predict wd');
    assert.match(text!, /9 人/);
    assert.match(text!, /上升/);
    assert.match(text!, /34 分钟/);
  } finally {
    f.stub.restore();
  }
});

test('weather 未配坐标时给出可操作的提示', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const text = await f.say('weather wd');
    assert.match(text!, /未设置经纬度/);
    assert.equal(f.stub.calls.length, 0);
  } finally {
    f.stub.restore();
  }
});

test('weather 配了坐标时返回天气', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], latitude: 30.5, longitude: 114.3 });
    f.stub.onJson('open-meteo.com', {
      current: { time: '2026-09-06T12:00', temperature_2m: 28, precipitation: 0, weather_code: 0, wind_speed_10m: 5 },
    });
    const text = await f.say('weather wd');
    assert.match(text!, /万达 天气/);
    assert.match(text!, /晴/);
  } finally {
    f.stub.restore();
  }
});

test('天气两家都挂时给通用兜底提示，不抛异常', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], latitude: 30.5, longitude: 114.3 });
    f.stub.onError('open-meteo.com');
    const text = await f.say('weather wd');
    assert.match(text!, /暂不可用/);
  } finally {
    f.stub.restore();
  }
});

test('上报超出上限时把校验原因告诉用户', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const text = await f.say('万达999999');
    assert.match(text!, /数值必须是/);
  } finally {
    f.stub.restore();
  }
});

test('自定义模板会被采用', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      query_template: '【{displayName}】{currentCount}人 等{waitTime}分',
    });
    await f.store.report(GROUP, a.id, 6, false, USER);
    assert.equal(await f.say('万达几'), '【万达】6人 等34分');
  } finally {
    f.stub.restore();
  }
});

test('不同群的同名别名互不干扰', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 3, false, USER);
    const other = await handleGroupMessage({
      store: f.store,
      groupId: 'another-group',
      userId: USER,
      text: 'wd几',
    });
    assert.equal(other, null);
  } finally {
    f.stub.restore();
  }
});

test('从未上报过时提示「还没有人上报」，而不是「超过 2 小时」', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const text = await f.say('万达几');
    // 群里只有人数三行。注意「(尚未上报)」属于那三行的一部分，是允许的；
    // 不允许的是「本群还没有人上报过人数，发送…」这类给维护者看的提示。
    assert.doesNotMatch(text!, /还没有人上报|小时/);

    // 「从未上报」与「陈旧」在日志里必须是不同说法：
    // 从没人报过却说「数据已陈旧」是错的。
    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'stale');
    assert.ok(hit);
    assert.match(hit!.message, /还没有人上报过/);
    assert.doesNotMatch(hit!.message, /陈旧/);
    // 日志里给出可操作的下一步，用最短别名（见 shortestLabel）
    assert.match(hit!.message, /「wd5」/);
  } finally {
    f.stub.restore();
  }
});

test('上报过但陈旧时才提示「超过 2 小时」', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.time.advance(3 * 3600 * 1000);
    const text = await f.say('万达几');
    assert.doesNotMatch(text!, /陈旧|上报/, '群里不该出现这些提示');

    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'stale');
    assert.ok(hit);
    assert.match(hit!.message, /陈旧/);
    assert.doesNotMatch(hit!.message, /还没有人上报过/);
  } finally {
    f.stub.restore();
  }
});

test('刚上报过时既不提示陈旧也不提示未上报', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    const text = await f.say('万达几');
    assert.doesNotMatch(text!, /超过 2 小时/);
    assert.doesNotMatch(text!, /还没有人上报/);
  } finally {
    f.stub.restore();
  }
});

test('提示语用最短别名举例，不用冗长的机厅全名', async () => {
  const f = fixture();
  try {
    // 真实场景：机厅全名很长，别名很短。
    await f.store.createArcade(GROUP, {
      name: '焕游星际（上海临港万达店）',
      aliases: ['焕游', 'hy'],
      machine_count: 1,
    });
    const text = await f.say('hy几');
    assert.doesNotMatch(text!, /hy|焕游/, '群消息里不该出现举例');

    // 举例出现在运行日志里，且用最短别名
    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'stale');
    assert.ok(hit);
    assert.match(hit!.message, /「hy5」/, `应当用最短别名 hy：${hit!.message}`);
    assert.doesNotMatch(hit!.message, /焕游星际（上海临港万达店）5/, '不该把长全名拼进提示');
  } finally {
    f.stub.restore();
  }
});

test('排卡帮助也用最短别名举例', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '焕游星际（上海临港万达店）', aliases: ['焕游', 'hy'] });
    const text = await f.say('排卡帮助');
    assert.match(text!, /hy几/);
    assert.doesNotMatch(text!, /焕游星际（上海临港万达店）几/);
  } finally {
    f.stub.restore();
  }
});

test('没有别名时退回机厅全名，不至于无从举例', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, { name: '万达', aliases: [] });
    await f.say('万达几');
    const hit = (await f.store.listEvents(GROUP)).find((e) => e.kind === 'stale');
    assert.ok(hit);
    assert.match(hit!.message, /「万达5」/);
  } finally {
    f.stub.restore();
  }
});

test('群消息永远只有那三行，任何情况都不多', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, {
      name: '焕游星际（上海临港万达店）',
      aliases: ['hy'],
      machine_count: 1,
      notice: '四楼扶梯右转',            // 有店铺通知
      nearcade_shop_id: 17217,          // 配了 Nearcade
      nearcade_game_id: 1,
    });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.time.advance(5 * 3600 * 1000);    // 数据陈旧
    f.stub.onError('/attendance');      // 外部服务还挂了

    // 以上四种「会想加提示」的条件同时成立，群消息仍必须只有三行。
    const text = await f.say('hy几');
    const lines = text!.split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 3, `应当只有三行，实际：${JSON.stringify(text)}`);
    assert.match(lines[0]!, /^→ \d+ 人 \(/);
    assert.match(lines[1]!, /^更新时间：/);
    assert.match(lines[2]!, /^大约需要 \d+ 分钟才能上机$/);
    // 用户明确要求不要 emoji
    assert.doesNotMatch(text!, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, `含 emoji：${text}`);

    // 店铺通知也不进群消息（用户明确要求「顶天就这些」）
    assert.doesNotMatch(text!, /扶梯/);

    // 但这些情况都得在日志里留痕，否则无从排查
    const kinds = (await f.store.listEvents(GROUP)).map((e) => e.kind);
    assert.ok(kinds.includes('nearcade.read'), `应记下外部失败：${kinds}`);
    assert.ok(kinds.includes('stale'), `应记下数据陈旧：${kinds}`);
  } finally {
    f.stub.restore();
  }
});

test('上报的群消息同样只有三行', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    f.stub.onError('/attendance');   // 同步失败
    const text = await f.say('wd8', { nearcadeToken: 'nk_x' });
    const lines = text!.split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 3, `应当只有三行，实际：${JSON.stringify(text)}`);
    assert.match(lines[0]!, /^→ 8 人 \(\+8\)$/);
  } finally {
    f.stub.restore();
  }
});
