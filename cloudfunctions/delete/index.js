/**
 * 删除数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - match: 匹配条件
 * - id: 文档 ID（直接按 ID 删除）
 * 
 * 返回：
 * - success: true/false
 * - deleted: 删除的行数
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { success, error } = require('../common/utils');

// 允许删除的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

exports.main = async (event, context) => {
  const { table, match, id } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  if (!id && (!match || Object.keys(match).length === 0)) {
    return error('缺少匹配条件');
  }
  
  try {
    let deletedCount = 0;
    
    if (id) {
      // 按 ID 删除
      await db.collection(table).doc(id).remove();
      deletedCount = 1;
    } else {
      // 按条件删除
      const res = await db.collection(table)
        .where(match)
        .remove();
      deletedCount = res.stats.removed;
    }
    
    return success({
      deleted: deletedCount
    });
    
  } catch (e) {
    console.error('删除错误:', e);
    return error('删除失败: ' + e.message);
  }
};
