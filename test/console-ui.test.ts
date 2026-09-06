import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 控制台前端是单文件 HTML，没有构建步骤也没有组件测试框架。
 * 这里做静态检查，覆盖「改坏了会直接不能用」的那几类问题：
 * JS 语法、id 引用、移动端适配的关键 CSS。
 */

const html = readFileSync(join(import.meta.dirname, '../public/index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

test('内联脚本语法正确', () => {
  // 语法错会让整个控制台白屏，而这类错误 tsc 检查不到（不是 .ts 文件）。
  assert.doesNotThrow(() => new Function(script));
});

test('所有 $(id) 引用的元素都真实存在', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));
  const refs = [...new Set([...script.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]!))];
  const missing = refs.filter((ref) => !ids.has(ref));
  assert.deepEqual(missing, [], `引用了不存在的 id：${missing.join(', ')}`);
});

test('有左侧抽屉与群列表容器', () => {
  assert.match(html, /id="drawer"/);
  assert.match(html, /id="groupList"/);
  assert.match(html, /id="scrim"/, '需要遮罩层，窄屏下点它关抽屉');
  assert.match(html, /id="menuBtn"/, '需要汉堡按钮');
});

test('窄屏下抽屉收起、汉堡按钮出现（响应式断点）', () => {
  const media = html.slice(html.indexOf('@media (max-width:820px)'));
  assert.match(media, /#menuBtn\{display:flex\}/, '窄屏要显示汉堡按钮');
  assert.match(media, /#drawer\{transform:translateX\(-100%\)/, '窄屏抽屉默认收起');
  assert.match(media, /main\{margin-left:0/, '窄屏主区不该给抽屉留边距');
});

test('宽屏下抽屉常驻，主区留出边距', () => {
  assert.match(html, /main\{[^}]*margin-left:var\(--drawer-w\)/, '宽屏主区要避开抽屉');
  // 汉堡按钮默认隐藏，只在窄屏媒体查询里显示
  assert.match(html, /#menuBtn\{display:none/);
});

test('输入框字号 >= 16px，避免 iOS 自动放大页面', () => {
  // iOS Safari 对 font-size < 16px 的输入框会在聚焦时缩放整个页面，很难用。
  const inputRule = html.slice(html.indexOf('input,textarea,select{'));
  assert.match(inputRule.slice(0, 260), /font-size:16px/);
});

test('触控目标不小于 40px', () => {
  assert.match(html, /--tap:40px/);
  assert.match(html, /button\{[^}]*min-height:var\(--tap\)/);
});

test('考虑了刘海屏安全区域', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
});

test('窄屏选中群后自动收起抽屉（否则挡住内容）', () => {
  assert.match(script, /isNarrow\s*=\s*\(\)\s*=>\s*window\.matchMedia/, '应有窄屏判断');
  const selectBlock = script.slice(script.indexOf('async function selectGroup'));
  assert.match(selectBlock.slice(0, 700), /if \(isNarrow\(\)\) openDrawer\(false\)/);
});

test('群列表展示机厅数、人数、最后活动时间与关闭状态', () => {
  const render = script.slice(script.indexOf('async function loadGroups'));
  assert.match(render, /arcade_count/);
  assert.match(render, /total_count/);
  assert.match(render, /relTime\(g\.last_report_at\)/);
  assert.match(render, /已关闭/, '关闭的群要有明显标记');
});

test('群列表内容做了 HTML 转义（备注名是用户输入）', () => {
  const render = script.slice(script.indexOf('async function loadGroups'), script.indexOf('$(\'reloadGroups\')'));
  assert.match(render, /escapeHtml\(g\.label/);
  assert.match(render, /escapeHtml\(g\.group_id\)/);
});

test('刷新后自动恢复上次的群，不需要手动再点加载', () => {
  const restore = script.slice(script.indexOf('async function restoreSession'));
  assert.match(restore, /localStorage\.getItem\('arcade_gid'\)/);
  assert.match(restore, /await selectGroup\(savedGid\)/);
  // 上次的群不在了（比如机厅被删干净）也要有兜底
  assert.match(restore, /else if \(groups\.length\) await selectGroup\(groups\[0\]\.group_id\)/);
});

test('密钥失效时清掉登录态而非停在假登录界面', () => {
  const restore = script.slice(script.indexOf('async function restoreSession'));
  assert.match(restore, /sessionStorage\.removeItem\('arcade_token'\)/);
  assert.match(restore, /setLoggedIn\(false\)/);
});

test('自动刷新日志在页面不可见时跳过（省流量与电量）', () => {
  assert.match(script, /!document\.hidden/);
});

test('群号做了格式校验', () => {
  assert.match(script, /\/\^\\d\{5,15\}\$\//);
});

// ---------- 占位符 ----------

/** 从 src/queue.ts 的 renderTemplate 里提取服务端真正支持的占位符名单。 */
function serverPlaceholders(): Set<string> {
  const source = readFileSync(join(import.meta.dirname, '../src/queue.ts'), 'utf8');
  const start = source.indexOf('const values: Record<string, string | number> = {');
  const block = source.slice(start, source.indexOf('\n  };', start));
  // 同时匹配 `key: value` 与简写 `key,`（waitTime、notice 用的是简写）
  return new Set([...block.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*[,:]/gm)].map((m) => m[1]!));
}

/** 前端 PLACEHOLDERS 里列出的名单。 */
function uiPlaceholders(): string[] {
  return [...html.matchAll(/\{ key: '([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
}

test('前端列出的占位符全部被服务端支持', () => {
  // 列了不支持的，用户点进去、发到群里会看到字面的 {xxx}，很难自己发现原因。
  const server = serverPlaceholders();
  const unsupported = uiPlaceholders().filter((key) => !server.has(key));
  assert.deepEqual(unsupported, [], `这些占位符服务端不认：${unsupported.join(', ')}`);
});

test('占位符列表非空且含最常用的几个', () => {
  const ui = uiPlaceholders();
  assert.ok(ui.length >= 8, `至少该列出常用的那些，实际 ${ui.length} 个`);
  for (const key of ['currentCount', 'freshness', 'updateTime', 'waitTime']) {
    assert.ok(ui.includes(key), `缺少常用占位符 ${key}`);
  }
});

test('每个占位符都有中文说明与示例值', () => {
  const entries = [...html.matchAll(/\{ key: '([A-Za-z0-9_]+)', desc: '([^']*)', sample: '([^']*)' \}/g)];
  assert.equal(entries.length, uiPlaceholders().length, '有占位符缺 desc 或 sample');
  for (const [, key, desc, sample] of entries) {
    assert.ok(desc!.length > 0, `${key} 没有说明`);
    assert.ok(sample!.length > 0, `${key} 没有示例值`);
  }
});

test('点占位符是插到光标处，不是追加到末尾', () => {
  // 直接 value += 会让用户没法在中间插入，只能手动剪切粘贴。
  assert.match(script, /function insertAtCursor/);
  const insert = script.slice(script.indexOf('function insertAtCursor'), script.indexOf('function renderPlaceholders'));
  assert.match(insert, /setRangeText/, '应当用 setRangeText 处理光标与选区');
  assert.match(insert, /selectionStart/, '要读光标位置');
  assert.match(insert, /selectionEnd/, '有选中内容时应当替换');
});

test('插入后会触发预览更新', () => {
  const insert = script.slice(script.indexOf('function insertAtCursor'), script.indexOf('function renderPlaceholders'));
  // 脚本改 value 不会自动触发 input 事件，必须手动派发，否则预览不动。
  assert.match(insert, /dispatchEvent\(new Event\('input'/);
});

test('有模板实时预览，且未知占位符会给出警告', () => {
  assert.match(script, /function renderPreview/);
  const preview = script.slice(script.indexOf('function renderPreview'));
  assert.match(preview, /这些名字不认识/, '拼错的占位符要提示，否则会原样发到群里');
  // 预览行为要与服务端一致：连续空行压成一个
  assert.match(preview, /\\n\{3,\}/);
});

// ---------- 移动端 ----------

test('禁止双指缩放（工具界面已按屏宽适配，缩放只会看到错位界面）', () => {
  const viewport = html.match(/<meta\s+name="viewport"[\s\S]*?\/>/)![0];
  // iOS 从 10 起忽略 user-scalable 但尊重 maximum-scale；Android 相反。两个都要写。
  assert.match(viewport, /maximum-scale=1/);
  assert.match(viewport, /user-scalable=no/);
  assert.match(viewport, /viewport-fit=cover/, '仍要处理刘海屏');
});

test('禁双击缩放', () => {
  assert.match(html, /touch-action:manipulation/);
});

test('禁整页橡皮筋回弹（往下拽会露出空白）', () => {
  assert.match(html, /overscroll-behavior:none/);
});

test('系统「更大字体」不会把界面撑变形', () => {
  assert.match(html, /text-size-adjust:100%/);
});

test('界面文字默认不可选中，但可复制的内容开放选中', () => {
  // 手机上长按界面文字容易触发选择而不是滚动。
  assert.match(html, /body\{-webkit-user-select:none/);
  // 群号、日志、机厅 id 这些是真要复制的
  assert.match(html, /code,#logs,\.gnum,#gidText,input,textarea\{-webkit-user-select:text/);
});
