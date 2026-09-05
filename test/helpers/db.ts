/**
 * 测试用数据库：直接用生产代码的 openDatabase(':memory:')。
 *
 * 这一点很重要：测试跑的是**真正的生产数据访问层与真实 SQL**，
 * 不是另写一份替身。SQL 语法错、参数绑定顺序错、约束冲突、事务回滚行为，
 * 全都会在本机暴露，不必等部署到 VPS。
 */
import { openDatabase, type Database } from '../../src/db.ts';

export function createTestDb(): Database {
  return openDatabase(':memory:');
}
