/**
 * 登录验证云函数
 * 
 * 请求参数：
 * - table: 'students' 或 'admins'
 * - username: 用户名/手机号
 * - password: 密码
 * 
 * 返回：
 * - success: true/false
 * - user: 用户信息（成功时）
 * - error: 错误信息（失败时）
 */

const tcb = require('tcb-admin-node');
const crypto = require('crypto');

// 初始化
tcb.init();

const db = tcb.database();
const _ = db.command;

// 密码盐值
const SALT = '_pedicure_salt_2026';

// 工具函数
function hashPassword(password) {
  return 'sha256:' + crypto.createHash('sha256').update(password + SALT).digest('hex');
}

function verifyPassword(inputPassword, storedPassword) {
  if (!storedPassword) return false;
  
  // 如果是明文密码，直接比较并迁移
  if (storedPassword === inputPassword) {
    return true;
  }
  
  // 如果是 SHA256 哈希格式
  if (storedPassword.startsWith('sha256:')) {
    const hash = hashPassword(inputPassword);
    return storedPassword === hash;
  }
  
  return false;
}

function generateToken(length = 32) {
  return crypto.randomBytes(length).reduce((p, i) => p + (i % 36).toString(36), '');
}

function success(data) {
  return { success: true, ...data };
}

function error(message) {
  return { success: false, error: message };
}

// 5 个级别
const LEVELS = ['初级', '中级', '高级', '技师', '高级技师'];

exports.main = async (event, context) => {
  const { table, username, password, level } = event;
  
  // 参数校验
  if (!table || !username || !password) {
    return error('缺少必要参数');
  }
  
  // 只允许登录这两张表
  if (!['students', 'admins'].includes(table)) {
    return error('无效的登录类型');
  }
  
  try {
    // 查询用户
    const query = { username };
    
    const res = await db.collection(table)
      .where(query)
      .limit(1)
      .get();
    
    if (res.data.length === 0) {
      return error('用户不存在');
    }
    
    const user = res.data[0];
    
    // 验证密码
    if (!verifyPassword(password, user.password)) {
      return error('密码错误');
    }
    
    // 学生额外检查
    if (table === 'students') {
      // 检查账号状态
      if (user.status === 'disabled') {
        return error('账号已被禁用');
      }
      if (user.status === 'expired') {
        return error('账号已过期');
      }
      
      // 检查有效期
      if (user.expires_at && new Date(user.expires_at) < new Date()) {
        // 更新状态为过期
        await db.collection('students').doc(user._id).update({
          status: 'expired'
        });
        return error('账号已过期，请联系管理员续期');
      }
      
      // 检查级别选择权限
      if (user.can_change_level !== true && level && level !== user.level) {
        return error('您没有权限更改学习等级');
      }
      
      // 如果选择了级别且有权限更改，更新级别
      if (level && user.can_change_level === true) {
        await db.collection('students').doc(user._id).update({
          level
        });
        user.level = level;
      }
    }
    
    // 生成会话 Token
    const sessionId = generateToken(32);
    
    // 更新会话 ID
    await db.collection(table).doc(user._id).update({
      session_id: sessionId,
      updated_at: new Date().toISOString()
    });
    
    // 构造返回的用户信息
    const userInfo = {
      id: user._id,
      username: user.username,
      nickname: user.nickname || user.username,
      level: user.level || LEVELS[0],
      cohort: user.cohort || '',
      status: user.status || 'active',
      is_master: user.is_master || false
    };
    
    return success({
      user: userInfo,
      sessionId,
      table
    });
    
  } catch (err) {
    console.error('登录错误:', err);
    return error('登录失败，请稍后重试');
  }
};
