import test from 'node:test';
import assert from 'node:assert/strict';

import { arcadeWeather } from '../src/weather.ts';
import { stubFetch } from './helpers/fetch.ts';

const TARGET = { name: '万达', latitude: 30.5, longitude: 114.3 };

const OPEN_METEO_OK = {
  current: { time: '2026-09-06T12:00', temperature_2m: 28.4, precipitation: 0, weather_code: 1, wind_speed_10m: 9 },
};

const QWEATHER_OK = {
  code: '200',
  now: {
    obsTime: '2026-09-06T12:00+08:00',
    text: '多云',
    temp: '28',
    feelsLike: '30',
    humidity: '70',
    windDir: '东南风',
    windScale: '2',
    windSpeed: '8',
  },
};

test('未设置坐标时直接报错，不发任何请求', async () => {
  const stub = stubFetch();
  try {
    await assert.rejects(() => arcadeWeather({ name: 'x', latitude: null, longitude: null }), /未设置经纬度/);
    await assert.rejects(() => arcadeWeather({ name: 'x', latitude: 30, longitude: null }), /未设置经纬度/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('未配置和风 key 时直接用 Open-Meteo', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('open-meteo.com', OPEN_METEO_OK);
    const text = await arcadeWeather(TARGET);
    assert.match(text, /万达 天气/);
    assert.match(text, /多云/);
    assert.match(text, /28\.4°C/);
    assert.match(text, /Open-Meteo/);
    assert.equal(stub.countFor('qweather'), 0);
  } finally {
    stub.restore();
  }
});

test('Open-Meteo 的经纬度与时区参数正确', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('open-meteo.com', OPEN_METEO_OK);
    await arcadeWeather(TARGET);
    const url = stub.calls[0]!.url;
    assert.match(url, /latitude=30\.5/);
    assert.match(url, /longitude=114\.3/);
    assert.match(url, /timezone=Asia%2FShanghai/);
  } finally {
    stub.restore();
  }
});

test('恶劣天气码会附加出行提示，可用开关关掉', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('open-meteo.com', { current: { ...OPEN_METEO_OK.current, weather_code: 95 } });
    assert.match(await arcadeWeather(TARGET), /雷暴/);
    assert.match(await arcadeWeather(TARGET), /恶劣天气提示/);
    assert.doesNotMatch(await arcadeWeather(TARGET, { severeWeather: false }), /恶劣天气提示/);
  } finally {
    stub.restore();
  }
});

test('普通天气码不会附加恶劣天气提示', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('open-meteo.com', OPEN_METEO_OK);
    assert.doesNotMatch(await arcadeWeather(TARGET), /恶劣天气提示/);
  } finally {
    stub.restore();
  }
});

test('未知天气码显示原始码而不是崩掉', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('open-meteo.com', { current: { ...OPEN_METEO_OK.current, weather_code: 12345 } });
    assert.match(await arcadeWeather(TARGET), /天气码 12345/);
  } finally {
    stub.restore();
  }
});

test('配了和风 key 时优先用和风，并附上预警', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/v7/weather/now', QWEATHER_OK);
    stub.onJson('/v7/warning/now', { warning: [{ text: '暴雨黄色预警' }] });
    const text = await arcadeWeather(TARGET, { qweatherKey: 'k', qweatherHost: 'devapi.qweather.com' });
    assert.match(text, /和风天气/);
    assert.match(text, /体感 30°C/);
    assert.match(text, /天气预警：暴雨黄色预警/);
    assert.equal(stub.countFor('open-meteo.com'), 0);
  } finally {
    stub.restore();
  }
});

test('和风的 location 参数是「经度,纬度」顺序', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/v7/weather/now', QWEATHER_OK);
    stub.onJson('/v7/warning/now', { warning: [] });
    await arcadeWeather(TARGET, { qweatherKey: 'k' });
    assert.match(stub.calls[0]!.url, /location=114\.30,30\.50/);
    assert.equal(stub.calls[0]!.headers['x-qw-api-key'], 'k');
  } finally {
    stub.restore();
  }
});

test('和风返回业务错误码（HTTP 200）时降级到 Open-Meteo', async () => {
  const stub = stubFetch();
  try {
    // 和风失败即使 HTTP 200 也要认出来——只看状态码会把错误当成功。
    stub.onJson('/v7/weather/now', { code: '401' });
    stub.onJson('open-meteo.com', OPEN_METEO_OK);
    const text = await arcadeWeather(TARGET, { qweatherKey: 'k' });
    assert.match(text, /Open-Meteo/);
    assert.match(text, /已回退/);
  } finally {
    stub.restore();
  }
});

test('和风网络故障时降级到 Open-Meteo', async () => {
  const stub = stubFetch();
  try {
    stub.onError('/v7/weather/now');
    stub.onJson('open-meteo.com', OPEN_METEO_OK);
    assert.match(await arcadeWeather(TARGET, { qweatherKey: 'k' }), /已回退/);
  } finally {
    stub.restore();
  }
});

test('预警接口挂了不影响主天气结果', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/v7/weather/now', QWEATHER_OK);
    stub.onError('/v7/warning/now');
    const text = await arcadeWeather(TARGET, { qweatherKey: 'k' });
    assert.match(text, /和风天气/);
    assert.doesNotMatch(text, /已回退/);
    assert.doesNotMatch(text, /天气预警/);
  } finally {
    stub.restore();
  }
});

test('weatherAlerts 关掉后不请求预警接口', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/v7/weather/now', QWEATHER_OK);
    await arcadeWeather(TARGET, { qweatherKey: 'k', weatherAlerts: false });
    assert.equal(stub.countFor('/v7/warning/now'), 0);
  } finally {
    stub.restore();
  }
});

test('空的预警列表不会产生空的预警行', async () => {
  const stub = stubFetch();
  try {
    stub.onJson('/v7/weather/now', QWEATHER_OK);
    stub.onJson('/v7/warning/now', { warning: [] });
    assert.doesNotMatch(await arcadeWeather(TARGET, { qweatherKey: 'k' }), /天气预警/);
  } finally {
    stub.restore();
  }
});

test('两家都挂时抛错，由调用方兜底提示', async () => {
  const stub = stubFetch();
  try {
    stub.onError('/v7/weather/now');
    stub.onError('open-meteo.com');
    await assert.rejects(() => arcadeWeather(TARGET, { qweatherKey: 'k' }));
  } finally {
    stub.restore();
  }
});
