-- 运行日志：给维护者看的事件流，在控制台展示。
--
-- 存在的理由：群消息只该有那三行人数信息，但「Nearcade 挂了」「同步未确认」
-- 「数据已陈旧」这类情况必须能被看到——否则出问题时无从排查。
-- 两种受众（群友 / 维护者）不共用一个出口。
--
-- 与 data/arcade-queue.log 文本日志的分工：
--   文本日志 = 进程级别（启动、崩溃、未捕获异常），给命令行看
--   本表     = 业务级别（哪个群哪个机厅发生了什么），给控制台看，可按群筛选

CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 事件归属的群（真实 QQ 群号）。空串表示与具体群无关的全局事件。
  group_id   TEXT NOT NULL DEFAULT '',
  -- 机厅名，便于在控制台一眼看出是哪家；不存 id 是因为机厅可能已被删除。
  arcade     TEXT NOT NULL DEFAULT '',
  -- info / warn / error
  level      TEXT NOT NULL DEFAULT 'info',
  -- 事件类别，便于筛选：nearcade.read / nearcade.write / weather / stale / command
  kind       TEXT NOT NULL DEFAULT '',
  -- 给人看的一句话
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 控制台按群倒序翻看，这个索引对应最常见的查询。
CREATE INDEX IF NOT EXISTS event_log_group_time ON event_log (group_id, id DESC);
CREATE INDEX IF NOT EXISTS event_log_created ON event_log (created_at);
