/**
 * 插入数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - data: 单条数据对象
 * - rows: 多条数据数组
 * 
 * 返回：
 * - success: true/false
 * - id: 插入的文档ID
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

// 允许插入的表
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
  const { table, data, rows, upsert, onConflict } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  // 准备插入的数据
  let insertData = rows || (data ? [data] : null);
  
  if (!insertData || insertData.length === 0) {
    return error('缺少要插入的数据');
  }
  
  try {
    const collection = db.collection(table);
    const results = [];
    
    // 处理每条数据
    for (const item of insertData) {
      let processedData = { ...item };
      
      // 添加创建时间
      if (!processedData.created_at) {
        processedData.created_at = new Date().toISOString();
      }
      
      // 密码哈希
      if (PASSWORD_FIELDS[table] && processedData[PASSWORD_FIELDS[table]]) {
        const field = PASSWORD_FIELDS[table];
        if (!processedData[field].startsWith('sha256:')) {
          processedData[field] = hashPassword(processedData[field]);
        }
      }
      
      // 处理 upsert
      if (upsert && onConflict) {
        // 对于云数据库，需要先查询再决定插入或更新
        const conflictFields = onConflict.split(',').map(f => f.trim());
        const query = {};
        
        for (const field of conflictFields) {
          if (processedData[field] !== undefined) {
            query[field] = processedData[field];
          }
        }
        
        if (Object.keys(query).length > 0) {
          const existing = await collection.where(query).limit(1).get();
          
          if (existing.data.length > 0) {
            // 更新现有记录
            await collection.doc(existing.data[0]._id).update(processedData);
            results.push({ id: existing.data[0]._id, updated: true });
            continue;
          }
        }
      }
      
      // 插入新记录
      const res = await collection.add(processedData);
      results.push({ id: res.id, inserted: true });
    }
    
    return success({ 
      ids: results.map(r => r.id),
      count: results.length 
    });
    
  } catch (err) {
    console.error('插入错误:', err);
    return error('插入失败: ' + err.message);
  }
};
