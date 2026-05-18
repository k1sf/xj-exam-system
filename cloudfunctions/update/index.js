/**
 * 更新数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - data: 要更新的数据
 * - match: 匹配条件
 * - id: 文档 ID（直接按 ID 更新）
 * 
 * 返回：
 * - success: true/false
 * - updated: 更新的行数
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { hashPassword, success, error } = require('../common/utils');

// 允许更新的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

// 需要密码哈希的表
const PASSWORD_TABLES = ['students', 'admins'];

exports.main = async (event, context) => {
  const { table, data, match, id } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  if (!data || Object.keys(data).length === 0) {
    return error('缺少更新数据');
  }
  
  if (!id && (!match || Object.keys(match).length === 0)) {
    return error('缺少匹配条件');
  }
  
  try {
    // 处理更新数据
    const updateData = { ...data };
    
    // 密码哈希
    if (PASSWORD_TABLES.includes(table) && updateData.password) {
      if (!updateData.password.startsWith('sha256:')) {
        updateData.password = hashPassword(updateData.password);
      }
    }
    
    // 添加更新时间
    updateData.updated_at = new Date().toISOString();
    
    let updatedCount = 0;
    
    if (id) {
      // 按 ID 更新
      await db.collection(table).doc(id).update({
        data: updateData
      });
      updatedCount = 1;
    } else {
      // 按条件更新
      const res = await db.collection(table)
        .where(match)
        .update({
          data: updateData
        });
      updatedCount = res.stats.updated;
    }
    
    return success({
      updated: updatedCount
    });
    
  } catch (e) {
    console.error('更新错误:', e);
    return error('更新失败: ' + e.message);
  }
};
