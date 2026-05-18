/**
 * 插入数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - data: 单条数据对象 或 rows: 多条数据数组
 * 
 * 返回：
 * - success: true/false
 * - id: 插入的文档 ID（单条）
 * - ids: 插入的文档 ID 数组（多条）
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { hashPassword, generateId, success, error } = require('../common/utils');

// 允许插入的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

// 需要密码哈希的表
const PASSWORD_TABLES = ['students', 'admins'];

exports.main = async (event, context) => {
  const { table, data, rows } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  // 处理单条或多条
  const items = rows || (data ? [data] : null);
  
  if (!items || items.length === 0) {
    return error('缺少数据');
  }
  
  try {
    // 处理每条数据
    const processedItems = items.map(item => {
      const processed = { ...item };
      
      // 密码哈希
      if (PASSWORD_TABLES.includes(table) && processed.password) {
        if (!processed.password.startsWith('sha256:')) {
          processed.password = hashPassword(processed.password);
        }
      }
      
      // 添加创建时间
      if (!processed.created_at) {
        processed.created_at = new Date().toISOString();
      }
      
      // 添加更新时间
      processed.updated_at = new Date().toISOString();
      
      return processed;
    });
    
    // 执行插入
    if (processedItems.length === 1) {
      const res = await db.collection(table).add({
        data: processedItems[0]
      });
      
      return success({
        id: res._id,
        ids: [res._id]
      });
    } else {
      // 批量插入（云开发单次最多 100 条）
      const results = [];
      for (let i = 0; i < processedItems.length; i += 100) {
        const batch = processedItems.slice(i, i + 100);
        const res = await db.collection(table).add({
          data: batch
        });
        results.push(...res._ids);
      }
      
      return success({
        ids: results,
        count: results.length
      });
    }
    
  } catch (e) {
    console.error('插入错误:', e);
    return error('插入失败: ' + e.message);
  }
};
