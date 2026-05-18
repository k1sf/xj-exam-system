/**
 * 更新数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - data: 要更新的数据
 * - match: 匹配条件
 * - id: 文档ID（单条更新）
 * 
 * 返回：
 * - success: true/false
 * - updated: 更新的数量
 */

const tcb = require('tcb-admin-node');
const crypto = require('crypto');

// 初始化
tcb.init();

const db = tcb.database();

// 密码盐值
const SALT = '_pedicure_salt_2026';

function hashPassword(password) {
  return 'sha256:' + crypto.createHash('sha256').update(password + SALT).digest('hex');
}

function success(data) {
  return { success: true, ...data };
}

function error(message) {
  return { success: false, error: message };
}

// 允许更新的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

// 需要密码哈希的表和字段
const PASSWORD_FIELDS = {
  students: 'password',
  admins: 'password'
};

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
  
  if (!match && !id) {
    return error('缺少匹配条件');
  }
  
  try {
    const collection = db.collection(table);
    let updateData = { ...data };
    
    // 更新时间
    updateData.updated_at = new Date().toISOString();
    
    // 密码哈希
    if (PASSWORD_FIELDS[table] && updateData[PASSWORD_FIELDS[table]]) {
      const field = PASSWORD_FIELDS[table];
      if (!updateData[field].startsWith('sha256:')) {
        updateData[field] = hashPassword(updateData[field]);
      }
    }
    
    if (id) {
      // 按 ID 更新
      await collection.doc(id).update(updateData);
      return success({ updated: 1 });
    } else {
      // 按条件更新
      const res = await collection.where(match).update(updateData);
      return success({ updated: res.updated || 1 });
    }
    
  } catch (err) {
    console.error('更新错误:', err);
    return error('更新失败: ' + err.message);
  }
};
