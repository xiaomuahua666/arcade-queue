/**
 * SQLite 数据访问层（node:sqlite，Node 22.5+ 内置，无需任何第三方依赖）。
 *
 * 这里刻意保留了「prepare / bind / first / all / run / batch」这套接口形状：
 * store.ts 的所有 SQL 与调用方式都不用改。原本是为了适配云端数据库而写成这样，
 * 现在自托管了仍然沿用 —— 它本身是个清晰的边界，也让 store.ts 可以在测试里
 * 换成内存库而不改一行业务代码。
 *
 * node:sqlite 已实测支持本项目需要的全部特性：
 *   - WAL 日志模式（并发读不阻塞写）
 *   - `?1`/`?2` 编号参数与参数复用（store.ts 的 resolve() 依赖这个）
 *   - BEGIN/COMMIT/ROLLBACK 显式事务
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Row = Record<string, unknown>;

export interface PreparedStatement {
  bind(...args: unknown[]): PreparedStatement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  /** 数组内的语句在单个事务里顺序执行；任一失败则整体回滚。 */
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
  close(): void;
}

class Statement implements PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private args: unknown[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]): PreparedStatement {
    const next = new Statement(this.db, this.sql);
    next.args = this.expand(args);
    return next;
  }

  /**
   * 把 `?1`/`?2` 编号参数展开成按出现顺序排列的匿名参数。
   *
   * node:sqlite 支持编号参数，但同一个编号复用多次时，绑定值的个数与占位符个数
   * 不一致会报错。store.ts 的 resolve() 正是把 ?1 用了两次（group_id 同时用于
   * 主查询和子查询），所以统一在这里按出现顺序摊平，行为最可预测。
   */
  private expand(args: unknown[]): unknown[] {
    const numbered = [...this.sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
    if (numbered.length === 0) return args;
    return numbered.map((index) => args[index - 1]);
  }

  private prepared() {
    return this.db.prepare(this.sql.replace(/\?\d+/g, '?'));
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.prepared().get(...(this.args as never[])) as T) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: this.prepared().all(...(this.args as never[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.prepared().run(...(this.args as never[]));
    return { meta: { changes: Number(result.changes ?? 0) } };
  }
}

class SqliteDatabase implements Database {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string): PreparedStatement {
    return new Statement(this.db, sql);
  }

  async batch(statements: PreparedStatement[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** 迁移文件目录。与本文件同级的上一层。 */
const MIGRATIONS_DIR = join(import.meta.dirname, '../migrations');

/** 按文件名顺序执行的迁移清单。新增迁移时在这里登记。 */
const MIGRATIONS = ['0001_init.sql'];

/**
 * 打开数据库并跑迁移。
 *
 * `:memory:` 用于测试。传文件路径时会自动建父目录。
 * 迁移里的语句全部是 `CREATE TABLE IF NOT EXISTS`，重复执行安全，
 * 所以不需要版本记录表。
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL：读不阻塞写。内存库不支持，返回 memory 即可，不当错误。
  db.exec('PRAGMA journal_mode = WAL');
  // 崩溃安全与性能的折中：NORMAL 下断电可能丢最后几个事务，
  // 但排卡人数不是账务数据，可以接受，换来的是写入快得多。
  db.exec('PRAGMA synchronous = NORMAL');
  // 并发写时最多等 5 秒再报 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  for (const name of MIGRATIONS) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
  return new SqliteDatabase(db);
}
