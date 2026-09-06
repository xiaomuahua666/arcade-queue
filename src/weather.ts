/**
 * 机厅天气查询。双供应商：和风天气（需 key，含预警）→ Open-Meteo（免 key）自动降级。
 *
 * 与 bot 版的差异：**没有定时播报**。bot 版靠 apscheduler 每 5 分钟醒一次逐群推送，
 * 本版按需求明确不做定时任务。所以天气只在群里主动发 `weather <别名>` 时查一次，
 * 相应地 queue_weather_setting 表也不存在。
 */

/** WMO 天气码中文表（Open-Meteo 用这套编码）。 */
const WMO_CODE: Record<number, string> = {
  0: '晴',
  1: '多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '强毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '极强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

/** 需要额外提示出行安全的天气码。 */
const SEVERE_CODES = new Set([65, 67, 75, 82, 86, 95, 96, 99]);

const TIMEOUT_MS = 6000;

export interface WeatherConfig {
  qweatherKey?: string;
  qweatherHost?: string;
  severeWeather?: boolean;
  weatherAlerts?: boolean;
}

export interface WeatherTarget {
  name: string;
  latitude: number | null;
  longitude: number | null;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
  return response.json();
}

function formatOpenMeteo(target: WeatherTarget, current: Record<string, unknown>, severeWeather: boolean): string {
  const code = Math.trunc(Number(current.weather_code) || 0);
  const description = WMO_CODE[code] ?? `天气码 ${code}`;
  let text =
    `${target.name} 天气（${String(current.time ?? '')}）\n` +
    `${description} · 气温 ${String(current.temperature_2m ?? '?')}°C` +
    ` · 降水 ${String(current.precipitation ?? '?')}mm` +
    ` · 风速 ${String(current.wind_speed_10m ?? '?')}km/h\n` +
    '数据来源：Open-Meteo';
  if (severeWeather && SEVERE_CODES.has(code)) text += '\n⚠️ 恶劣天气提示：请留意出行安全。';
  return text;
}

async function openMeteoCurrent(target: WeatherTarget): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({
    latitude: String(target.latitude),
    longitude: String(target.longitude),
    current: 'temperature_2m,precipitation,weather_code,wind_speed_10m',
    timezone: 'Asia/Shanghai',
  });
  const payload = (await fetchJson(`https://api.open-meteo.com/v1/forecast?${query}`)) as {
    current?: Record<string, unknown>;
  };
  if (!payload.current) throw new Error('Open-Meteo 未返回实况数据');
  return payload.current;
}

function formatQWeather(target: WeatherTarget, now: Record<string, unknown>): string {
  return (
    `${target.name} 天气（${String(now.obsTime ?? '')}）\n` +
    `${String(now.text ?? '未知')} · 气温 ${String(now.temp ?? '?')}°C` +
    ` · 体感 ${String(now.feelsLike ?? '?')}°C` +
    ` · 湿度 ${String(now.humidity ?? '?')}%` +
    ` · 风向 ${String(now.windDir ?? '?')} ${String(now.windScale ?? '?')}级` +
    ` 风速 ${String(now.windSpeed ?? '?')}km/h\n` +
    '数据来源：和风天气'
  );
}

/** 和风的 location 参数是「经度,纬度」，顺序与直觉相反，别写反。 */
function qweatherLocation(target: WeatherTarget): string {
  return `${Number(target.longitude).toFixed(2)},${Number(target.latitude).toFixed(2)}`;
}

async function qweatherCurrent(target: WeatherTarget, key: string, host: string): Promise<Record<string, unknown>> {
  const payload = (await fetchJson(`https://${host}/v7/weather/now?location=${qweatherLocation(target)}`, {
    'X-QW-Api-Key': key,
  })) as { code?: unknown; now?: Record<string, unknown> };
  // 和风即使业务失败也返回 HTTP 200，必须查 body 里的 code。
  if (!['200', '0'].includes(String(payload.code))) throw new Error(`和风天气接口错误：${String(payload.code)}`);
  if (!payload.now) throw new Error('和风天气未返回实况数据');
  return payload.now;
}

async function qweatherWarning(target: WeatherTarget, key: string, host: string): Promise<string> {
  const payload = (await fetchJson(`https://${host}/v7/warning/now?location=${qweatherLocation(target)}`, {
    'X-QW-Api-Key': key,
  })) as { warning?: unknown };
  const warnings = Array.isArray(payload.warning) ? payload.warning : [];
  return warnings
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return String(record.text ?? record.title ?? '').trim();
    })
    .filter(Boolean)
    .join('；')
    .slice(0, 1000);
}

/**
 * 查机厅天气。配了和风 key 就先用和风（多了预警信息），失败自动降级 Open-Meteo。
 * 没配坐标直接抛错，提示去控制台补。
 */
export async function arcadeWeather(target: WeatherTarget, config: WeatherConfig = {}): Promise<string> {
  if (target.latitude === null || target.longitude === null) {
    throw new Error('该机厅未设置经纬度，请先在控制台补充后再查天气。');
  }
  const severeWeather = config.severeWeather !== false;
  const weatherAlerts = config.weatherAlerts !== false;
  const key = String(config.qweatherKey ?? '').trim();
  const host = String(config.qweatherHost ?? 'devapi.qweather.com').trim() || 'devapi.qweather.com';

  if (key) {
    try {
      const now = await qweatherCurrent(target, key, host);
      let text = formatQWeather(target, now);
      if (weatherAlerts) {
        // 预警是加分项，拿不到就算了，不能因此让整条天气查询失败。
        try {
          const warning = await qweatherWarning(target, key, host);
          if (warning) text += '\n⚠️ 天气预警：' + warning;
        } catch {
          /* 预警不可用时静默跳过 */
        }
      }
      return text;
    } catch {
      const current = await openMeteoCurrent(target);
      return formatOpenMeteo(target, current, severeWeather) + '\n（和风接口暂不可用，已回退）';
    }
  }
  const current = await openMeteoCurrent(target);
  return formatOpenMeteo(target, current, severeWeather);
}
