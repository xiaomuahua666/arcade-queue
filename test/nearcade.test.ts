import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeReportOutcome,
  fetchAttendance,
  fetchShop,
  normalizeShop,
  reportAttendance,
  searchShops,
} from '../src/nearcade.ts';
import { stubFetch } from './helpers/fetch.ts';

test('normalizeShop 提取名称、地址、坐标与机种', () => {
  const shop = normalizeShop({
    id: 42,
    name: '万达电玩城',
    address: { general: ['湖北省', '武汉市'], detailed: '万达广场 4F' },
    location: { coordinates: [114.3, 30.5] },
    games: [
      { gameId: 1, titleId: 9, name: 'maimai DX', version: 'BUDDiES', quantity: 4 },
      { gameId: null, name: '无效机种' },
      'not an object',
    ],
    secretField: '不该出现',
  });
  assert.equal(shop.id, 42);
  assert.equal(shop.name, '万达电玩城');
  assert.equal(shop.address, '湖北省 武汉市 万达广场 4F');
  // GeoJSON 是 [经度, 纬度]，不能搞反
  assert.equal(shop.longitude, 114.3);
  assert.equal(shop.latitude, 30.5);
  assert.equal(shop.games.length, 1);
  assert.deepEqual(shop.games[0], { game_id: 1, title_id: 9, name: 'maimai DX', version: 'BUDDiES', quantity: 4 });
  assert.equal('secretField' in shop, false);
});

test('normalizeShop 容忍缺失字段', () => {
  const shop = normalizeShop({ id: 1 });
  assert.equal(shop.name, '');
  assert.equal(shop.address, '');
  assert.equal(shop.latitude, null);
  assert.equal(shop.longitude, null);
  assert.deepEqual(shop.games, []);
});

test('normalizeShop 拒绝非对象输入', () => {
  assert.throws(() => normalizeShop(null), /无效/);
  assert.throws(() => normalizeShop('shop'), /无效/);
});

test('searchShops 正常返回归一化结果', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/shops?', { shops: [{ id: 1, name: '甲厅' }, { id: 2, name: '乙厅' }] });
    const shops = await searchShops('万达');
    assert.deepEqual(shops.map((shop) => shop.name), ['甲厅', '乙厅']);
    assert.match(stub.calls[0]!.url, /q=%E4%B8%87%E8%BE%BE/);
  } finally {
    stub.restore();
  }
});

test('searchShops 瞬时故障后重试并最终成功', async () => {
  const stub = stubFetch();
  try {
    let attempt = 0;
    stub.on('/shops?', () => {
      attempt += 1;
      if (attempt < 3) throw new Error('connect timeout');
      return new Response(JSON.stringify({ shops: [{ id: 5, name: '丙厅' }] }), { status: 200 });
    });
    const shops = await searchShops('x');
    assert.equal(shops.length, 1);
    assert.equal(stub.countFor('/shops?'), 3);
  } finally {
    stub.restore();
  }
});

test('searchShops 三次全败返回空数组而不是抛错', async () => {
  const stub = stubFetch();
  try {
    stub.onError('/shops?');
    assert.deepEqual(await searchShops('x'), []);
    assert.equal(stub.countFor('/shops?'), 3);
  } finally {
    stub.restore();
  }
});

test('fetchShop 兼容 {shop:{...}} 与裸对象两种响应', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/shops/7', { shop: { id: 7, name: '包裹型' } });
    assert.equal((await fetchShop(7)).name, '包裹型');
    stub.onJson('/shops/8', { id: 8, name: '裸对象型' });
    assert.equal((await fetchShop(8)).name, '裸对象型');
  } finally {
    stub.restore();
  }
});

test('fetchAttendance 返回匹配机种的人数', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/attendance', { games: [{ gameId: 1, total: 3 }, { gameId: 2, total: 9 }] });
    assert.equal(await fetchAttendance(10, 2), 9);
  } finally {
    stub.restore();
  }
});

test('fetchAttendance 能区分「0 人」与「无数据」', async () => {
  const stub = stubFetch();
  try {
    // 真的 0 人，必须返回 0 而不是 null——否则模板会退回本地旧数据。
    stub.onJson('/attendance', { games: [{ gameId: 1, total: 0 }] });
    assert.equal(await fetchAttendance(10, 1), 0);
  } finally {
    stub.restore();
  }
});

test('fetchAttendance 机种不在列表里时返回 null', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/attendance', { games: [{ gameId: 1, total: 3 }] });
    assert.equal(await fetchAttendance(10, 999), null);
  } finally {
    stub.restore();
  }
});

test('fetchAttendance 未配置 shop/game id 时不发请求', async () => {
  const stub = stubFetch();
  try {
    assert.equal(await fetchAttendance(null, 1), null);
    assert.equal(await fetchAttendance(1, null), null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('fetchAttendance 遇到 HTTP 错误会抛出（由调用方决定提示）', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/attendance', { error: 'boom' }, 503);
    await assert.rejects(() => fetchAttendance(10, 1), /HTTP 503/);
  } finally {
    stub.restore();
  }
});

test('reportAttendance 发出带 Bearer 的 POST，请求体符合协议', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/attendance', { ok: true });
    const outcome = await reportAttendance(10, 2, 7, 'nk_token');
    assert.deepEqual(outcome, { status: 'ok' });
    const call = stub.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer nk_token');
    assert.deepEqual(JSON.parse(call.body!).games, [{ id: 2, currentAttendances: 7 }]);
  } finally {
    stub.restore();
  }
});

test('reportAttendance 失败时绝不重试（防重复污染公共数据）', async () => {
  const stub = stubFetch();
  try {
    stub.onError('/attendance');
    assert.deepEqual(await reportAttendance(10, 2, 7, 'tok'), { status: 'unconfirmed' });
    assert.equal(stub.countFor('/attendance'), 1, '写接口只能发一次');
  } finally {
    stub.restore();
  }
});

test('reportAttendance 遇 HTTP 错误也只发一次', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/attendance', {}, 500);
    assert.deepEqual(await reportAttendance(10, 2, 7, 'tok'), { status: 'unconfirmed' });
    assert.equal(stub.countFor('/attendance'), 1);
  } finally {
    stub.restore();
  }
});

test('reportAttendance 缺 token 或缺 shop/game 时直接跳过，不发请求', async () => {
  const stub = stubFetch();
  try {
    assert.deepEqual(await reportAttendance(10, 2, 7, ''), { status: 'skipped', reason: 'no-token' });
    assert.deepEqual(await reportAttendance(null, 2, 7, 'tok'), { status: 'skipped', reason: 'no-shop' });
    assert.deepEqual(await reportAttendance(10, null, 7, 'tok'), { status: 'skipped', reason: 'no-shop' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('describeReportOutcome 对四种结果给出不同措辞', () => {
  assert.match(describeReportOutcome({ status: 'ok' }), /已同步/);
  assert.match(describeReportOutcome({ status: 'skipped', reason: 'no-token' }), /未配置 Nearcade Token/);
  assert.match(describeReportOutcome({ status: 'skipped', reason: 'no-shop' }), /店铺\/机种 ID/);
  const unconfirmed = describeReportOutcome({ status: 'unconfirmed' });
  assert.match(unconfirmed, /未确认/);
  assert.match(unconfirmed, /不自动重试/);
  // 不能说成「失败」：请求可能已到达。
  assert.doesNotMatch(unconfirmed, /失败/);
});
