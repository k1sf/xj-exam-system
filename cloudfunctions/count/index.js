/**
 * 统计数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - filter: 筛选条件
 * - where: 筛选条件（同 filter）
 * 
 * 返回：
 * - success: true/false
 * - count: 数量
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

// 允许统计的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

exports.main = async (event, context) => {
  const { table, filter, where } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  try {
    const collection = db.collection(table);
    
    // 构建查询条件
    const query = filter || where || {};
    
    // 执行统计
    const res = await collection.where(query).count();
    
    return success({ count: res.total || 0 });
    
  } catch (err) {
    console.error('统计错误:', err);
    return error('统计失败: ' + err.message);
  }
};
