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

test('允许缩放（想看清细节时能放大是正当需求）', () => {
  const viewport = html.match(/<meta\s+name="viewport"[\s\S]*?\/>/)![0];
  // 曾用禁缩放来「解决」长机厅名撑破布局的横滑问题，那是治症状不治病。
  // 正解是让长文本换行，布局不溢出自然就没有横滑。
  assert.doesNotMatch(viewport, /user-scalable=no/, '不该禁用户缩放');
  assert.doesNotMatch(viewport, /maximum-scale/, '不该限制最大缩放');
  assert.match(viewport, /viewport-fit=cover/, '仍要处理刘海屏');
});

test('不禁止文本选中（用户要能复制群号、日志等）', () => {
  // 曾为「防长按误触发选择」把整页 user-select:none，代价是什么都复制不了。
  assert.doesNotMatch(html, /user-select:none/, '不该禁止选中文本');
});

test('禁整页橡皮筋回弹（往下拽会露出空白）', () => {
  // 只禁纵向：横向本来就不该有滚动（靠换行保证），禁了反而掩盖问题。
  assert.match(html, /overscroll-behavior-y:none/);
});

test('系统「更大字体」不会把界面撑变形', () => {
  assert.match(html, /text-size-adjust:100%/);
});

// ---------- 长内容不撑破布局 ----------
// 机厅名可能是「焕游星际（上海临港万达广场店）」这种长度，
// 不换行就会把容器顶宽、整页变成可横向滑动，界面看着像坏了。

test('全局允许任意位置断行', () => {
  // anywhere 比 break-word 更彻底：连超长无空格串（如整条 URL）也能断。
  assert.match(html, /body\{[^}]*overflow-wrap:anywhere/);
});

/**
 * 取出 <style> 里的真实 CSS，剥掉注释。
 *
 * 直接对整个 HTML 做断言会被注释文字误伤——本文件的注释里就写着
 * 「曾经用过 overscroll-behavior」之类的说明，那不是生效的样式。
 */
function styleRules(): string {
  const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  return style.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('不得破坏页面纵向滚动', () => {
  const css = styleRules();
  // 实际反馈：加了 overscroll-behavior-y:none 后「必须双指才能往下滑」。
  // 那个属性本意是禁橡皮筋回弹，但在部分浏览器里会把正常滚动手势一起吞掉。
  // 橡皮筋只是观感问题，不值得拿滚动能力去换。
  assert.doesNotMatch(css, /overscroll-behavior/, '不该用 overscroll-behavior');
  // 给 html 设 overflow 会在 iOS Safari 上改变滚动容器行为，导致页面滚不动。
  assert.doesNotMatch(css, /html\s*\{[^}]*overflow/, 'html 上不该设 overflow');
  // touch-action:manipulation 会连带禁掉双击缩放，之前也因此被移除
  assert.doesNotMatch(css, /touch-action:\s*manipulation/);
});

test('防横向溢出只靠换行，不靠隐藏溢出', () => {
  const css = styleRules();
  // 内容本身不溢出就不需要 overflow:hidden 去掩盖；
  // 而且 hidden 会把真的超出的内容裁掉，让人看不见反而更难排查。
  assert.match(css, /body\{overflow-wrap:anywhere/, '靠换行解决');
  const arcadeRule = css.match(/\.arcade\{[^}]*\}/)![0];
  assert.doesNotMatch(arcadeRule, /overflow:hidden/, '机厅卡片不该裁内容');
  assert.match(arcadeRule, /max-width:100%/, '限宽即可');
});

test('抽屉内的群列表仍可独立滚动', () => {
  // 群多了要能在抽屉里滑动，这个 overflow-y 是必要的（作用在局部容器上，
  // 不影响整页滚动）。
  assert.match(html, /#groupList\{[^}]*overflow-y:auto/);
});

test('flex 与 grid 子项放开最小宽度限制', () => {
  // flex 子项默认最小宽度等于内容宽度，不加 min-width:0 的话
  // 长文本照样顶宽整行，overflow-wrap 也救不回来。
  assert.match(html, /\.row>\*,\.grid>\*,\.arcade \.head>\*,\.gitem>\*\{min-width:0\}/);
});

test('机厅名与机厅卡片内的文本允许换行', () => {
  assert.match(html, /\.arcade \.head strong\{[^}]*overflow-wrap:anywhere/);
  assert.match(html, /\.arcade \.meta\{[^}]*overflow-wrap:anywhere/);
});

test('机厅卡片自身不超出容器', () => {
  assert.match(html, /\.arcade\{[^}]*max-width:100%/);
});

test('tag 默认可换行，只有确定很短的状态标签才 nowrap', () => {
  // 日志那栏的 tag 里放的是机厅名，nowrap 会把整行顶宽。
  const tagRule = html.match(/\.tag\{[^}]*\}/)![0];
  assert.doesNotMatch(tagRule, /white-space:nowrap/, '.tag 不该默认 nowrap');
  assert.match(tagRule, /overflow-wrap:anywhere/);
  assert.match(tagRule, /max-width:100%/);
  // 短标签走 .tag.nw
  assert.match(html, /\.tag\.nw\{white-space:nowrap\}/);
  assert.match(html, /class="tag nw"/, '状态标签应当用 .tag.nw');
});

test('群备注名允许换行', () => {
  assert.match(html, /\.gitem \.gname\{[^}]*overflow-wrap:anywhere/);
  assert.match(html, /\.gitem \.gname\{[^}]*flex-wrap:wrap/);
});

test('表格用固定布局并允许单元格换行', () => {
  // 默认的 auto 布局会为容纳长内容无限加宽表格，撑破容器。
  assert.match(html, /table\{[^}]*table-layout:fixed/);
  assert.match(html, /th,td\{[^}]*overflow-wrap:anywhere/);
});

test('日志表给出列宽（fixed 布局下必须指定，否则消息栏太窄）', () => {
  const logRender = script.slice(script.indexOf('async function loadLogs'));
  assert.match(logRender, /<colgroup>/);
  // 消息列不该被 nowrap 卡住
  assert.doesNotMatch(logRender, /white-space:nowrap/);
});

test('占位符示例值（含整条链接）允许换行', () => {
  assert.match(html, /#phHelp td:last-child\{[^}]*overflow-wrap:anywhere/);
});

test('顶栏标题用省略号而非换行（顶栏高度固定）', () => {
  // 这里是唯一该截断的地方：换行会把固定高度的顶栏撑破。
  // 完整名字在「当前群」面板能看到。
  const rule = html.match(/header h1\{[^}]*\}/)![0];
  assert.match(rule, /text-overflow:ellipsis/);
  assert.match(rule, /min-width:0/, '要允许被 flex 压缩，否则省略号不生效');
});
