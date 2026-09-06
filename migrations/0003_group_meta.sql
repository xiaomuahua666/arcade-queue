-- 群备注：给群起个人能记住的名字。
--
-- 存在的理由：控制台列出来的群只有一串数字（如 123456789），
-- 管三五个群还行，多了根本分不清哪个是哪个。这里让用户给群起名，
-- 比如「临港排卡群」。
--
-- 单独一张表而不是塞进 queue_group_setting：那张表管的是功能开关，
-- 语义不同；而且备注是纯展示用途，混在一起以后不好拆。

CREATE TABLE IF NOT EXISTS group_meta (
  group_id   TEXT PRIMARY KEY,
  -- 人能看懂的名字，空串表示没起名，界面上就显示群号。
  label      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
