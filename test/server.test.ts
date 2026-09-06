import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { Config } from '../src/config.ts';
import { createHttpServer } from '../src/server.ts';
import { QueueStore } from '../src/store.ts';
import { createTestDb } from './helpers/db.ts';

const ONEBOT_SECRET = 'onebot-secret';
const CONSOLE_TOKEN = 'console-secret-token-long';
const GROUP = '123456789'; // 真实 QQ 群号
const USER = '10001';

/**
 * 起一个真实的 HTTP 服务器，用真实 fetch 打它。
 *
 * 不用「直接调 handler 函数」的取巧写法：那样测不到请求体读取、header 解析、
 * 状态码写回这些真会出错的环节。端口用 0 让系统随机分配，避免并行测试冲突。
 */
interface Harness {
  url: string;
  store: QueueStore;
  time: { now: () => number; advance(ms: number): void };
  close(): Promise<void>;
}

function clock(start = Date.UTC(2026, 8, 6, 4, 0, 0)) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

async function startServer(overrides: Partial<Config> = {}): Promise<Harness> {
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    consoleToken: CONSOLE_TOKEN,
    onebotSecret: ONEBOT_SECRET,
    onebotApiBase: '',
    onebotAccessToken: '',
    nearcadeToken: '',
    qweatherKey: '',
    qweatherHost: 'devapi.qweather.com',
    // 测试不落日志文件：内存库 + 无副作用，跑完不留垃圾。
    logFile: '',
    logMaxMb: 10,
    ...overrides,
  };
  const db = createTestDb();
  const time = clock();
  const server = createHttpServer({ config, db, now: time.now });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store: new QueueStore(db, time.now),
    time,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/** 构造签名正确的 OneBot 上报。 */
function report(url: string, event: unknown, secret: string | null = ONEBOT_SECRET): Promise<Response> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Signature'] = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
  return fetch(`${url}/onebot`, { method: 'POST', headers, body });
}

function groupMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    time: 1757000000,
    self_id: 1000,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 5001,
    group_id: Number(GROUP),
    user_id: Number(USER),
    raw_message: text,
    message: text,
    sender: { user_id: Number(USER), nickname: '测试用户', role: 'member' },
    ...overrides,
  };
}

function api(url: string, path: string, options: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = options.token === undefined ? CONSOLE_TOKEN : options.token;
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(url + path, { ...options, headers });
}

test('GET /health 返回 ok', async () => {
  const h = await startServer();
  try {
    const response = await fetch(`${h.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await h.close();
  }
});

test('GET / 返回控制台页面', async () => {
  const h = await startServer();
  try {
    const response = await fetch(`${h.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.match(html, /机厅排卡控制台/);
    // 页面必须真的能读到，不能是占位符——这一条能抓住路径算错的问题。
    assert.match(html, /CONSOLE_TOKEN/);
  } finally {
    await h.close();
  }
});

test('未知路径返回 404', async () => {
  const h = await startServer();
  try {
    assert.equal((await fetch(`${h.url}/nope`)).status, 404);
  } finally {
    await h.close();
  }
});

test('响应带上基础安全头', async () => {
  const h = await startServer();
  try {
    const response = await fetch(`${h.url}/health`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await h.close();
  }
});

test('/onebot 只接受 POST', async () => {
  const h = await startServer();
  try {
    assert.equal((await fetch(`${h.url}/onebot`)).status, 405);
  } finally {
    await h.close();
  }
});

test('/onebot 拒绝签名错误与缺签名的上报', async () => {
  const h = await startServer();
  try {
    assert.equal((await report(h.url, groupMessage('万达几'), 'wrong')).status, 401);
    assert.equal((await report(h.url, groupMessage('万达几'), null)).status, 401);
  } finally {
    await h.close();
  }
});

test('/onebot 签名失败返回 4xx，避免客户端重试', async () => {
  const h = await startServer();
  try {
    const response = await report(h.url, groupMessage('x'), 'bad');
    // OneBot 规范：4xx 不触发重试。签名错的事件重试也没意义。
    assert.ok(response.status >= 400 && response.status < 500);
  } finally {
    await h.close();
  }
});

test('/onebot 查询用快速操作直接回消息', async () => {
  const h = await startServer();
  try {
    const arcade = await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'], machine_count: 2 });
    await h.store.report(GROUP, arcade.id, 6, false, USER);
    const response = await report(h.url, groupMessage('万达几'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { reply?: string; at_sender?: boolean; auto_escape?: boolean };
    assert.match(body.reply!, /6 人/);
    assert.match(body.reply!, /17 分钟/);
    assert.equal(body.at_sender, false);
    assert.equal(body.auto_escape, true);
  } finally {
    await h.close();
  }
});

test('/onebot 回复不依赖任何外部服务（未配 Nearcade 时全程本地）', async () => {
  const h = await startServer();
  try {
    const arcade = await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await h.store.report(GROUP, arcade.id, 3, false, USER);
    // 这条能通过说明「查人数」这条最常用路径不需要出网，
    // 也就守住了「NapCat 不必开入站端口、Worker 不必反连它」这个架构前提。
    // handler 层对出站调用的精确断言见 handler.test.ts。
    const response = await report(h.url, groupMessage('万达几'));
    const body = (await response.json()) as { reply: string };
    assert.match(body.reply, /3 人/);
  } finally {
    await h.close();
  }
});

test('/onebot 剥掉 CQ 码后解析指令', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const response = await report(h.url, groupMessage('[CQ:at,qq=1000] 万达5'));
    assert.equal(response.status, 200);
    assert.equal((await h.store.resolve(GROUP, 'wd')).count, 5);
  } finally {
    await h.close();
  }
});

test('/onebot 支持消息段数组格式', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const event = groupMessage('', {
      message: [
        { type: 'at', data: { qq: '1000' } },
        { type: 'text', data: { text: ' 万达7' } },
      ],
      raw_message: '[CQ:at,qq=1000] 万达7',
    });
    await report(h.url, event);
    assert.equal((await h.store.resolve(GROUP, 'wd')).count, 7);
  } finally {
    await h.close();
  }
});

test('/onebot 增量上报可用', async () => {
  const h = await startServer();
  try {
    const arcade = await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await h.store.report(GROUP, arcade.id, 4, false, USER);
    const response = await report(h.url, groupMessage('万达+3', { message_id: 6001 }));
    const body = (await response.json()) as { reply: string };
    assert.match(body.reply, /7 人/);
    assert.match(body.reply, /\(\+3\)/);
  } finally {
    await h.close();
  }
});

test('/onebot 对非排卡消息返回空对象（保持沉默）', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const response = await report(h.url, groupMessage('今天吃什么'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  } finally {
    await h.close();
  }
});

test('/onebot 对私聊/心跳/通知事件均返回 200 空对象', async () => {
  const h = await startServer();
  try {
    const cases: unknown[] = [
      { ...groupMessage('万达几'), message_type: 'private' },
      { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 1 },
      { post_type: 'notice', notice_type: 'group_increase', group_id: Number(GROUP) },
    ];
    for (const event of cases) {
      const response = await report(h.url, event);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {});
    }
  } finally {
    await h.close();
  }
});

test('/onebot 重复上报同一 message_id 只处理一次', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const first = await report(h.url, groupMessage('万达+1', { message_id: 7001 }));
    assert.ok(((await first.json()) as { reply?: string }).reply, '首次应当回复');
    for (let i = 0; i < 3; i += 1) {
      const retry = await report(h.url, groupMessage('万达+1', { message_id: 7001 }));
      assert.deepEqual(await retry.json(), {}, '重复上报不该再回复');
    }
    // 更要紧的是人数不能被重复累加。
    assert.equal((await h.store.resolve(GROUP, 'wd')).count, 1);
  } finally {
    await h.close();
  }
});

test('/onebot 未配 secret 时放行（便于本地调试）', async () => {
  const h = await startServer({ onebotSecret: '' });
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const response = await report(h.url, groupMessage('万达5'), null);
    assert.equal(response.status, 200);
    assert.equal((await h.store.resolve(GROUP, 'wd')).count, 5);
  } finally {
    await h.close();
  }
});

test('/onebot 无效 JSON 返回 400', async () => {
  const h = await startServer({ onebotSecret: '' });
  try {
    const response = await fetch(`${h.url}/onebot`, { method: 'POST', body: 'not json' });
    assert.equal(response.status, 400);
  } finally {
    await h.close();
  }
});

test('/onebot 过大的请求体返回 413', async () => {
  const h = await startServer({ onebotSecret: '' });
  try {
    const response = await fetch(`${h.url}/onebot`, { method: 'POST', body: 'x'.repeat(70000) });
    assert.equal(response.status, 413);
  } finally {
    await h.close();
  }
});

test('/onebot 群号隔离：A 群别名在 B 群无效', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const response = await report(h.url, groupMessage('万达几', { group_id: 987654321 }));
    assert.deepEqual(await response.json(), {});
  } finally {
    await h.close();
  }
});

test('/onebot 排卡帮助与列表可用', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    const help = await report(h.url, groupMessage('排卡帮助', { message_id: 8001 }));
    // 帮助里用别名举例（见 handler 的 shortestLabel）。
    assert.match(((await help.json()) as { reply: string }).reply, /wd几/);
    const list = await report(h.url, groupMessage('排卡列表', { message_id: 8002 }));
    assert.match(((await list.json()) as { reply: string }).reply, /本群排卡机厅/);
  } finally {
    await h.close();
  }
});

test('管理 API 无密钥/密钥错误返回 401', async () => {
  const h = await startServer();
  try {
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`, { token: null })).status, 401);
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`, { token: 'wrong' })).status, 401);
  } finally {
    await h.close();
  }
});

test('未配置 CONSOLE_TOKEN 时管理 API 一律拒绝（不是放开）', async () => {
  const h = await startServer({ consoleToken: '' });
  try {
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`, { token: null })).status, 401);
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`, { token: 'anything' })).status, 401);
  } finally {
    await h.close();
  }
});

test('管理 API 连续密钥失败后限流为 429', async () => {
  const h = await startServer();
  try {
    // 服务暴露公网必然被扫，这里确认爆破会被挡下。
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`, { token: 'wrong' })).status, 401);
    }
    const blocked = await api(h.url, `/api/groups/${GROUP}/arcades`, { token: 'wrong' });
    assert.equal(blocked.status, 429);
    // 关键：锁定期间连正确密钥也进不来，否则限流可被绕过。
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`)).status, 429);
  } finally {
    await h.close();
  }
});

test('管理 API 限流会在时间窗过后解锁', async () => {
  const h = await startServer();
  try {
    for (let i = 0; i < 11; i += 1) await api(h.url, `/api/groups/${GROUP}/arcades`, { token: 'wrong' });
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`)).status, 429);
    h.time.advance(16 * 60 * 1000);
    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades`)).status, 200);
  } finally {
    await h.close();
  }
});

test('管理 API：机厅增查改删全流程（真实 QQ 群号）', async () => {
  const h = await startServer();
  try {
    const base = `/api/groups/${GROUP}/arcades`;
    const created = await api(h.url, base, {
      method: 'POST',
      body: JSON.stringify({ name: '万达', aliases: ['wd'], machine_count: 2 }),
    });
    assert.equal(created.status, 201);
    const arcade = (await created.json()) as { id: string };

    assert.equal((((await (await api(h.url, base)).json()) as unknown[]) ?? []).length, 1);

    const updated = await api(h.url, `${base}/${arcade.id}`, {
      method: 'POST',
      body: JSON.stringify({ machine_count: 5 }),
    });
    assert.equal(((await updated.json()) as { machine_count: number }).machine_count, 5);

    const reported = await api(h.url, `${base}/${arcade.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ value: 9 }),
    });
    assert.equal(((await reported.json()) as { count: number }).count, 9);

    assert.equal((((await (await api(h.url, `${base}/${arcade.id}/history`)).json()) as unknown[]) ?? []).length, 1);

    assert.deepEqual(await (await api(h.url, `${base}/${arcade.id}`, { method: 'DELETE' })).json(), { ok: true });
    assert.equal((((await (await api(h.url, base)).json()) as unknown[]) ?? []).length, 0);
  } finally {
    await h.close();
  }
});

test('管理 API：控制台改的数据群里立刻可见', async () => {
  const h = await startServer();
  try {
    await api(h.url, `/api/groups/${GROUP}/arcades`, {
      method: 'POST',
      body: JSON.stringify({ name: '银泰', aliases: ['yt'], machine_count: 4 }),
    });
    // 关键是「刚建的别名群里立刻能解析」——能拿到回复即证明这点。
    // 不断言机厅名：默认模板已不输出它。
    const reply = ((await (await report(h.url, groupMessage('yt几'))).json()) as { reply?: string }).reply;
    assert.ok(reply, '控制台刚建的机厅，群里应当马上能查到');
    assert.match(reply!, /0 人/);
    // 再确认「排卡列表」里能看到它（列表仍会显示机厅名与别名）。
    const list = await report(h.url, groupMessage('排卡列表', { message_id: 9101 }));
    assert.match(((await list.json()) as { reply: string }).reply, /银泰（yt）：0 人 · 4 台/);
  } finally {
    await h.close();
  }
});

test('管理 API：群开关关掉后群里不再响应', async () => {
  const h = await startServer();
  try {
    await h.store.createArcade(GROUP, { name: '万达', aliases: ['wd'] });
    await api(h.url, `/api/groups/${GROUP}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
    const response = await report(h.url, groupMessage('万达几'));
    assert.deepEqual(await response.json(), {});
  } finally {
    await h.close();
  }
});

test('管理 API：群开关读写与非布尔值校验', async () => {
  const h = await startServer();
  try {
    const path = `/api/groups/${GROUP}/enabled`;
    assert.deepEqual(await (await api(h.url, path)).json(), { enabled: true });
    const off = await api(h.url, path, { method: 'POST', body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await off.json(), { enabled: false });
    const bad = await api(h.url, path, { method: 'POST', body: JSON.stringify({ enabled: 'yes' }) });
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

test('管理 API：校验错误 400、缺失 404、未知接口 404、坏 JSON 400', async () => {
  const h = await startServer();
  try {
    const bad = await api(h.url, `/api/groups/${GROUP}/arcades`, { method: 'POST', body: JSON.stringify({ name: '' }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /名称/);

    assert.equal((await api(h.url, `/api/groups/${GROUP}/arcades/nope`)).status, 404);
    assert.equal((await api(h.url, '/api/whatever')).status, 404);

    const badJson = await api(h.url, `/api/groups/${GROUP}/arcades`, { method: 'POST', body: 'not json' });
    assert.equal(badJson.status, 400);
  } finally {
    await h.close();
  }
});

test('管理 API：Nearcade 搜索校验与透传', async () => {
  const h = await startServer();
  try {
    assert.equal((await api(h.url, '/api/nearcade/search?q=a')).status, 400);
    assert.equal((await api(h.url, '/api/nearcade/shops/0')).status, 400);
  } finally {
    await h.close();
  }
});

test('管理 API：运行日志可读，按群隔离', async () => {
  const h = await startServer();
  try {
    await h.store.logEvent({ groupId: GROUP, arcade: '万达', level: 'warn', kind: 'nearcade.read', message: '读取失败' });
    await h.store.logEvent({ groupId: '999', message: '别的群' });

    const rows = (await (await api(h.url, `/api/groups/${GROUP}/events`)).json()) as Array<{
      message: string;
      level: string;
      kind: string;
      arcade: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.message, '读取失败');
    assert.equal(rows[0]!.level, 'warn');
    assert.equal(rows[0]!.arcade, '万达');
  } finally {
    await h.close();
  }
});

test('管理 API：运行日志需要鉴权', async () => {
  const h = await startServer();
  try {
    assert.equal((await api(h.url, `/api/groups/${GROUP}/events`, { token: null })).status, 401);
  } finally {
    await h.close();
  }
});

test('管理 API：运行日志支持 limit', async () => {
  const h = await startServer();
  try {
    for (let i = 0; i < 5; i += 1) await h.store.logEvent({ groupId: GROUP, message: `第 ${i} 条` });
    const rows = (await (await api(h.url, `/api/groups/${GROUP}/events?limit=2`)).json()) as unknown[];
    assert.equal(rows.length, 2);
  } finally {
    await h.close();
  }
});

test('群里查一次人数后，运行日志里能看到外部故障（端到端）', async () => {
  const h = await startServer();
  try {
    const arcade = await h.store.createArcade(GROUP, {
      name: '万达',
      aliases: ['wd'],
      // 不配 Nearcade：这样查询流程不会发出任何外部请求，
      // 测试不依赖外网。「读不到外部数据」的日志照样会记。
    });
    await h.store.report(GROUP, arcade.id, 4, false, USER);
    // 让数据变陈旧，制造一个确定会记日志的情况。
    h.time.advance(3 * 3600 * 1000);

    const reply = ((await (await report(h.url, groupMessage('wd几'))).json()) as { reply: string }).reply;
    // 群里只有人数三行
    const lines = reply.split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 3, `群消息应只有三行：${JSON.stringify(reply)}`);
    assert.match(reply, /4 人/);
    assert.doesNotMatch(reply, /陈旧/, '群消息不该出现维护类提示');

    // 控制台能看到原因
    const rows = (await (await api(h.url, `/api/groups/${GROUP}/events`)).json()) as Array<{
      kind: string;
      message: string;
    }>;
    const hit = rows.find((row) => row.kind === 'stale');
    assert.ok(hit, `控制台应能看到原因：${JSON.stringify(rows)}`);
    assert.match(hit!.message, /陈旧/);
  } finally {
    await h.close();
  }
});
