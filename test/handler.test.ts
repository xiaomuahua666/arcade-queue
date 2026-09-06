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

test('Nearcade 故障时明确告知用户已退回本地数据（bot 版此处静默，是已知毛边）', async () => {
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
    assert.match(text!, /Nearcade 暂不可用/);
    assert.match(text!, /5 人/);
  } finally {
    f.stub.restore();
  }
});

test('Nearcade 无该机种数据时提示「暂无数据」，与故障区分开', async () => {
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
    assert.match(text!, /暂无该机种数据/);
    assert.doesNotMatch(text!, /暂不可用/);
  } finally {
    f.stub.restore();
  }
});

test('本地数据陈旧时提示可能不准', async () => {
  const f = fixture();
  try {
    const a = await f.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await f.store.report(GROUP, a.id, 5, false, USER);
    f.time.advance(3 * 3600 * 1000);
    assert.match((await f.say('万达几'))!, /超过 2 小时/);
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

test('未配 Nearcade token 时上报只存本地并说明未同步', async () => {
  const f = fixture();
  try {
    await f.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      nearcade_shop_id: 10,
      nearcade_game_id: 2,
    });
    const text = await f.say('万达5');
    assert.match(text!, /未配置 Nearcade Token/);
    assert.equal(f.stub.calls.length, 0);
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
    assert.match(text!, /已同步 Nearcade/);
    const call = f.stub.calls.find((item) => item.method === 'POST')!;
    assert.deepEqual(JSON.parse(call.body!).games, [{ id: 2, currentAttendances: 5 }]);
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
    assert.match(text!, /未确认/);
    assert.match(text!, /不自动重试/);
    assert.equal(f.stub.countFor('/attendance'), 1);
    // 本地数据仍然要保存成功
    assert.equal((await f.store.resolve(GROUP, 'wd')).count, 5);
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
    // 从没人报过却说「数据已超过 2 小时」是错的说法。
    assert.doesNotMatch(text!, /超过 2 小时/);
    assert.match(text!, /还没有人上报/);
    // 顺便给出可操作的下一步（用别名举例，见 shortestLabel）。
    assert.match(text!, /wd5/);
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
    assert.match(text!, /超过 2 小时/);
    assert.doesNotMatch(text!, /还没有人上报/);
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
    assert.match(text!, /发送「hy5」/, `应当用最短别名 hy：${text}`);
    assert.doesNotMatch(text!, /焕游星际（上海临港万达店）5/, '不该把长全名拼进提示');
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
    const text = await f.say('万达几');
    assert.match(text!, /发送「万达5」/);
  } finally {
    f.stub.restore();
  }
});
