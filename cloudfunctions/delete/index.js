/**
 * 删除数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - match: 匹配条件
 * - id: 文档ID（单条删除）
 * 
 * 返回：
 * - success: true/false
 * - deleted: 删除的数量
 */

const tcb = require('tcb-admin-node');

// 初始化
tcb.init();

const db = tcb.database();

function success(data) {
  return { success: true, ...data };
}

function error(message) {
  return { success: false, error: message };
}

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
  
  if (!match && !id) {
    return error('缺少匹配条件');
  }
  
  try {
    const collection = db.collection(table);
    
    if (id) {
      // 按 ID 删除
      await collection.doc(id).remove();
      return success({ deleted: 1 });
    } else {
      // 按条件删除
      const res = await collection.where(match).remove();
      return success({ deleted: res.deleted || 1 });
    }
    
  } catch (err) {
    console.error('删除错误:', err);
    return error('删除失败: ' + err.message);
  }
};
