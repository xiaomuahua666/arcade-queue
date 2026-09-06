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
