import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  callAction,
  extractPlainText,
  isGroupMessage,
  quickReply,
  sendGroupMessage,
  stripCqCodes,
  verifyOneBotSignature,
} from '../src/onebot.ts';
import { stubFetch } from './helpers/fetch.ts';

const SECRET = 'onebot-secret';

/** 用 node:crypto 独立算签名，作为对 WebCrypto 实现的交叉验证。 */
function sign(body: string, secret = SECRET): string {
  return 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
}

test('verifyOneBotSignature 接受 node:crypto 算出的签名（交叉验证）', async () => {
  const body = '{"post_type":"message","group_id":123}';
  assert.equal(await verifyOneBotSignature(SECRET, sign(body), body), true);
});

test('verifyOneBotSignature 拒绝篡改过的 body', async () => {
  const body = '{"post_type":"message"}';
  const signature = sign(body);
  assert.equal(await verifyOneBotSignature(SECRET, signature, body + ' '), false);
});

test('verifyOneBotSignature 拒绝错误的 secret', async () => {
  const body = '{"a":1}';
  assert.equal(await verifyOneBotSignature('other-secret', sign(body), body), false);
});

test('verifyOneBotSignature 拒绝格式不对的签名头', async () => {
  const body = '{"a":1}';
  const valid = sign(body).slice(5);
  for (const bad of ['', 'nope', valid, 'sha256=' + valid, 'sha1=', 'sha1=xyz']) {
    assert.equal(await verifyOneBotSignature(SECRET, bad, body), false, `header=${bad}`);
  }
});

test('verifyOneBotSignature 拒绝长度不对的 hex', async () => {
  const body = '{"a":1}';
  const hex = sign(body).slice(5);
  assert.equal(await verifyOneBotSignature(SECRET, 'sha1=' + hex.slice(0, 38), body), false);
  assert.equal(await verifyOneBotSignature(SECRET, 'sha1=' + hex + 'ab', body), false);
});

test('verifyOneBotSignature 大小写不敏感（部分实现输出大写 hex）', async () => {
  const body = '{"a":1}';
  const upper = sign(body).slice(5).toUpperCase();
  assert.equal(await verifyOneBotSignature(SECRET, 'sha1=' + upper, body), true);
});

test('未配置 secret 时按 OneBot 规范放行（但部署应当配上）', async () => {
  assert.equal(await verifyOneBotSignature('', '', '{"a":1}'), true);
  assert.equal(await verifyOneBotSignature('', 'sha1=garbage', '{"a":1}'), true);
});

test('stripCqCodes 去掉 CQ 码只留文本', () => {
  assert.equal(stripCqCodes('[CQ:at,qq=123] 万达几'), '万达几');
  assert.equal(stripCqCodes('万达几'), '万达几');
  assert.equal(stripCqCodes('[CQ:at,qq=1]万达+2[CQ:face,id=1]'), '万达+2');
  assert.equal(stripCqCodes(''), '');
});

test('stripCqCodes 还原 CQ 转义序列', () => {
  // 不还原的话 &#91; 会残留在文本里，模板与指令解析都会出错。
  assert.equal(stripCqCodes('&#91;测试&#93;'), '[测试]');
  assert.equal(stripCqCodes('a&#44;b'), 'a,b');
  assert.equal(stripCqCodes('a&amp;b'), 'a&b');
});

test('extractPlainText 支持 CQ 码字符串格式', () => {
  assert.equal(extractPlainText({ message: '[CQ:at,qq=999] 万达几' }), '万达几');
});

test('extractPlainText 支持消息段数组格式', () => {
  const text = extractPlainText({
    message: [
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: ' 万达' } },
      { type: 'text', data: { text: '+2' } },
      { type: 'image', data: { file: 'x.jpg' } },
    ],
  });
  assert.equal(text, '万达+2');
});

test('extractPlainText 数组里没有 text 段时返回空串', () => {
  assert.equal(extractPlainText({ message: [{ type: 'image', data: { file: 'x' } }] }), '');
  assert.equal(extractPlainText({ message: [] }), '');
});

test('extractPlainText 容忍数组里的脏数据', () => {
  const text = extractPlainText({ message: [null, 'str', { type: 'text', data: { text: '万达几' } }, { type: 'text' }] });
  assert.equal(text, '万达几');
});

test('extractPlainText 回退到 raw_message', () => {
  assert.equal(extractPlainText({ raw_message: '[CQ:at,qq=1]万达几' }), '万达几');
  assert.equal(extractPlainText({ message: '', raw_message: '万达5' }), '万达5');
});

test('extractPlainText 两个字段都没有时返回空串', () => {
  assert.equal(extractPlainText({}), '');
});

test('isGroupMessage 只认群消息事件', () => {
  const base = { post_type: 'message', message_type: 'group', group_id: 123456 };
  assert.equal(isGroupMessage(base), true);
  assert.equal(isGroupMessage({ ...base, message_type: 'private' }), false);
  assert.equal(isGroupMessage({ ...base, post_type: 'meta_event' }), false);
  assert.equal(isGroupMessage({ ...base, post_type: 'notice' }), false);
  assert.equal(isGroupMessage(null), false);
  assert.equal(isGroupMessage('string'), false);
});

test('isGroupMessage 拒绝无效群号', () => {
  const base = { post_type: 'message', message_type: 'group' };
  assert.equal(isGroupMessage({ ...base, group_id: 0 }), false);
  assert.equal(isGroupMessage({ ...base, group_id: -1 }), false);
  assert.equal(isGroupMessage({ ...base, group_id: 'abc' }), false);
  assert.equal(isGroupMessage(base), false);
});

test('quickReply 关掉 at_sender 并开启纯文本转义', () => {
  const reply = quickReply('人数：5');
  assert.equal(reply.reply, '人数：5');
  // at_sender 默认是 true，会让每条回复都 @ 人，很吵，显式关掉。
  assert.equal(reply.at_sender, false);
  // 机厅通知里可能有 [ ]，不转义会被当 CQ 码解析。
  assert.equal(reply.auto_escape, true);
});

test('callAction 未配置 apiBase 时抛错', async () => {
  await assert.rejects(() => callAction('send_group_msg', {}, {}), /未配置 ONEBOT_API_BASE/);
});

test('callAction 发出带 Bearer 的 POST 并解出 data', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/send_group_msg', { status: 'ok', retcode: 0, data: { message_id: 42 } });
    const data = await callAction('send_group_msg', { group_id: 1 }, {
      apiBase: 'http://127.0.0.1:3000',
      accessToken: 'tok',
    });
    assert.deepEqual(data, { message_id: 42 });
    const call = stub.calls[0]!;
    assert.equal(call.url, 'http://127.0.0.1:3000/send_group_msg');
    assert.equal(call.headers.authorization, 'Bearer tok');
  } finally {
    stub.restore();
  }
});

test('callAction 容忍 apiBase 末尾的斜杠', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/send_group_msg', { retcode: 0 });
    await callAction('send_group_msg', {}, { apiBase: 'http://127.0.0.1:3000///' });
    assert.equal(stub.calls[0]!.url, 'http://127.0.0.1:3000/send_group_msg');
  } finally {
    stub.restore();
  }
});

test('callAction 对 retcode 非 0 报错（HTTP 200 不代表业务成功）', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/send_group_msg', { status: 'failed', retcode: 100 });
    await assert.rejects(
      () => callAction('send_group_msg', {}, { apiBase: 'http://x' }),
      /retcode=100/,
    );
  } finally {
    stub.restore();
  }
});

test('callAction 对 HTTP 错误报错', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/send_group_msg', {}, 403);
    await assert.rejects(() => callAction('send_group_msg', {}, { apiBase: 'http://x' }), /HTTP 403/);
  } finally {
    stub.restore();
  }
});

test('sendGroupMessage 传出正确参数且开启转义', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/send_group_msg', { retcode: 0 });
    await sendGroupMessage('123456', '你好', { apiBase: 'http://x' });
    const body = JSON.parse(stub.calls[0]!.body!);
    assert.deepEqual(body, { group_id: 123456, message: '你好', auto_escape: true });
  } finally {
    stub.restore();
  }
});
