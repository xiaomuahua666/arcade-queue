import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditConfig, loadConfig, loadEnvFile, type Config } from '../src/config.ts';

/** 隔离环境变量：每个用例跑完恢复原样，避免互相污染。 */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const keys = [
    'HOST',
    'PORT',
    'DB_PATH',
    'CONSOLE_TOKEN',
    'ONEBOT_SECRET',
    'ONEBOT_API_BASE',
    'ONEBOT_ACCESS_TOKEN',
    'NEARCADE_TOKEN',
    'QWEATHER_KEY',
    'QWEATHER_HOST',
    'LOG_FILE',
    'LOG_MAX_MB',
    'TRUST_PROXY',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 8787,
    dbPath: ':memory:',
    consoleToken: 'a-sufficiently-long-token',
    onebotSecret: 'onebot-secret',
    onebotApiBase: '',
    onebotAccessToken: '',
    nearcadeToken: '',
    qweatherKey: '',
    qweatherHost: 'devapi.qweather.com',
    // 测试里不写日志文件：只验配置体检逻辑，不该产生副作用文件。
    logFile: '',
    logMaxMb: 10,
    trustProxy: false,
    ...overrides,
  };
}

test('loadConfig 提供合理默认值', () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 8787);
    assert.equal(config.dbPath, './data/arcade-queue.db');
    assert.equal(config.consoleToken, '');
    assert.equal(config.qweatherHost, 'devapi.qweather.com');
  });
});

test('loadConfig 读取环境变量并去掉首尾空白', () => {
  withEnv({ HOST: '127.0.0.1', PORT: '9000', CONSOLE_TOKEN: '  tok  ' }, () => {
    const config = loadConfig();
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 9000);
    assert.equal(config.consoleToken, 'tok');
  });
});

test('loadConfig 拒绝非法端口', () => {
  for (const bad of ['0', '70000', 'abc', '-1']) {
    withEnv({ PORT: bad }, () => {
      assert.throws(() => loadConfig(), /PORT 无效/, `PORT=${bad}`);
    });
  }
});

test('loadEnvFile 加载键值且不覆盖已有环境变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcade-env-'));
  const file = join(dir, '.env');
  writeFileSync(
    file,
    ['# 注释行', '', 'CONSOLE_TOKEN=from-file', 'ONEBOT_SECRET="quoted-secret"', "NEARCADE_TOKEN='single'"].join('\n'),
  );
  withEnv({ CONSOLE_TOKEN: 'from-real-env' }, () => {
    loadEnvFile(file);
    // 真实环境变量优先，文件只做补充。
    assert.equal(process.env.CONSOLE_TOKEN, 'from-real-env');
    assert.equal(process.env.ONEBOT_SECRET, 'quoted-secret');
    assert.equal(process.env.NEARCADE_TOKEN, 'single');
  });
});

test('loadEnvFile 对不存在的文件静默返回', () => {
  assert.doesNotThrow(() => loadEnvFile('/nonexistent/path/.env'));
});

test('auditConfig 对缺少 CONSOLE_TOKEN 报警', () => {
  const warnings = auditConfig(baseConfig({ consoleToken: '' }));
  assert.ok(warnings.some((w) => w.includes('CONSOLE_TOKEN')));
  // 必须说清是「全部拒绝」而不是「放开」，否则用户会误判安全状态。
  assert.ok(warnings.some((w) => w.includes('拒绝访问')));
});

test('auditConfig 对过短的 CONSOLE_TOKEN 报警', () => {
  assert.ok(auditConfig(baseConfig({ consoleToken: 'short' })).some((w) => w.includes('16 字符')));
});

test('auditConfig 对足够长的 CONSOLE_TOKEN 不报警', () => {
  const warnings = auditConfig(baseConfig({ consoleToken: 'x'.repeat(32) }));
  assert.equal(warnings.filter((w) => w.includes('CONSOLE_TOKEN')).length, 0);
});

test('auditConfig：公网监听且无 ONEBOT_SECRET 时给出严重警告', () => {
  const warnings = auditConfig(baseConfig({ host: '0.0.0.0', onebotSecret: '' }));
  const secretWarning = warnings.find((w) => w.includes('ONEBOT_SECRET'));
  assert.ok(secretWarning);
  // 这种组合下任何人都能伪造上报，措辞必须比本机监听时更重。
  assert.match(secretWarning!, /伪造/);
});

test('auditConfig：仅本机监听且无 ONEBOT_SECRET 时措辞较轻', () => {
  const warnings = auditConfig(baseConfig({ host: '127.0.0.1', onebotSecret: '' }));
  const secretWarning = warnings.find((w) => w.includes('ONEBOT_SECRET'));
  assert.ok(secretWarning);
  assert.doesNotMatch(secretWarning!, /伪造/);
});

test('auditConfig：公网监听时提示明文传输风险', () => {
  assert.ok(auditConfig(baseConfig({ host: '0.0.0.0' })).some((w) => w.includes('明文')));
});

test('auditConfig：本机监听不提示明文风险', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const warnings = auditConfig(baseConfig({ host }));
    assert.equal(warnings.filter((w) => w.includes('明文')).length, 0, `host=${host}`);
  }
});

test('auditConfig：配置齐全且只听本机时零警告', () => {
  assert.deepEqual(auditConfig(baseConfig()), []);
});

test('loadConfig 读取日志配置并提供默认值', () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.logFile, './data/arcade-queue.log');
    assert.equal(config.logMaxMb, 10);
  });
  withEnv({ LOG_FILE: '/var/log/arcade.log', LOG_MAX_MB: '50' }, () => {
    const config = loadConfig();
    assert.equal(config.logFile, '/var/log/arcade.log');
    assert.equal(config.logMaxMb, 50);
  });
});

test('LOG_FILE 可显式留空表示只输出到屏幕', () => {
  withEnv({ LOG_FILE: '' }, () => {
    assert.equal(loadConfig().logFile, '');
  });
});

test('loadConfig 拒绝非法的 LOG_MAX_MB', () => {
  for (const bad of ['0', '-5', 'abc']) {
    withEnv({ LOG_MAX_MB: bad }, () => {
      assert.throws(() => loadConfig(), /LOG_MAX_MB 无效/, `LOG_MAX_MB=${bad}`);
    });
  }
});

test('TRUST_PROXY 默认关闭，只有显式 true/1/yes 才开启', () => {
  withEnv({}, () => assert.equal(loadConfig().trustProxy, false, '默认必须是安全的那一侧'));
  for (const value of ['true', 'TRUE', '1', 'yes']) {
    withEnv({ TRUST_PROXY: value }, () => assert.equal(loadConfig().trustProxy, true, `TRUST_PROXY=${value}`));
  }
  // 拼错、乱填一律按「不信任」处理，不能因为写了个非空值就当开启
  for (const value of ['false', '0', 'no', 'ture', 'on', '']) {
    withEnv({ TRUST_PROXY: value }, () => assert.equal(loadConfig().trustProxy, false, `TRUST_PROXY=${value}`));
  }
});

test('auditConfig：公网监听 + 信任代理头是最危险组合，必须警告', () => {
  const warnings = auditConfig(baseConfig({ host: '0.0.0.0', trustProxy: true }));
  const hit = warnings.find((w) => w.includes('TRUST_PROXY'));
  assert.ok(hit, `应当警告这个组合：${JSON.stringify(warnings)}`);
  assert.match(hit!, /绕过/, '要说清后果是限流被绕过');
});

test('auditConfig：仅本机监听时开 TRUST_PROXY 不警告（代理场景合理）', () => {
  const warnings = auditConfig(baseConfig({ host: '127.0.0.1', trustProxy: true }));
  assert.equal(warnings.filter((w) => w.includes('TRUST_PROXY')).length, 0);
});
