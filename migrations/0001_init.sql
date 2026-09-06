-- 机厅排卡：初始 schema（SQLite，经 node:sqlite 执行）
--
-- 与 bot 版（libraries/maimaidx_group_queue.py）的差异，都是刻意的：
--   1. group_id 直接存**真实 QQ 群号**（字符串形式），不再有「控制台内部群 id →
--      namespace+raw_group_id」那层映射。机器人身份来自 OneBot 客户端登录的真人 QQ。
--   2. 时间戳统一 INTEGER 毫秒（JS Date.now()），bot 版是 REAL 秒。
--   3. 删掉 queue_weather_setting 与 group_arcade.subscribed：本版不做定时播报。
--      天气改为群内 `weather <别名>` 按需查询。
--   4. 新增 seen_message：OneBot 客户端在上报超时时会重发同一事件，用它做幂等，
--      避免重复回复、更避免增量上报被重复累加。

-- 全局机厅：只存人数状态。多个群可共享同一个 arcade_id（各自叫法/模板独立）。
CREATE TABLE IF NOT EXISTS arcade (
  id          TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- 群侧配置：同一机厅在不同群可以有不同别名、机台数、通知与消息模板。
CREATE TABLE IF NOT EXISTS group_arcade (
  group_id          TEXT NOT NULL,
  arcade_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  aliases           TEXT NOT NULL DEFAULT '[]',
  machine_count     INTEGER NOT NULL DEFAULT 1,
  notice            TEXT NOT NULL DEFAULT '',
  latitude          REAL,
  longitude         REAL,
  address           TEXT NOT NULL DEFAULT '',
  direction_guide   TEXT NOT NULL DEFAULT '',
  nearcade_shop_id  INTEGER,
  nearcade_game_id  INTEGER,
  query_template    TEXT NOT NULL DEFAULT '',
  report_template   TEXT NOT NULL DEFAULT '',
  predict_template  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (group_id, arcade_id)
);

-- 别名索引：alias 存 NFKC + casefold 归一化后的值。
CREATE TABLE IF NOT EXISTS queue_alias (
  group_id  TEXT NOT NULL,
  alias     TEXT NOT NULL,
  arcade_id TEXT NOT NULL,
  PRIMARY KEY (group_id, alias)
);

-- 上报流水。查询时刻意不暴露其他群与上报者，见 store.ts 的 history()。
CREATE TABLE IF NOT EXISTS queue_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  arcade_id  TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  count      INTEGER NOT NULL,
  diff       INTEGER NOT NULL,
  actor      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS queue_history_arcade ON queue_history (arcade_id, id);

-- 每群总开关。缺行视为启用（与 bot 版 is_enabled 默认 True 一致）。
CREATE TABLE IF NOT EXISTS queue_group_setting (
  group_id TEXT PRIMARY KEY,
  enabled  INTEGER NOT NULL DEFAULT 1
);

-- 幂等：记录已处理的平台消息 id。
CREATE TABLE IF NOT EXISTS seen_message (
  msg_id     TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS seen_message_created ON seen_message (created_at);
