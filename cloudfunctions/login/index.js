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

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { hashPassword, verifyPassword, generateToken, success, error } = require('../common/utils');

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
          data: { status: 'expired' }
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
          data: { level }
        });
        user.level = level;
      }
    }
    
    // 生成会话 Token
    const sessionId = generateToken(32);
    const token = generateToken(32);
    
    // 更新会话 ID
    await db.collection(table).doc(user._id).update({
      data: { 
        session_id: sessionId,
        updated_at: new Date().toISOString()
      }
    });
    
    // 返回用户信息（不包含密码）
    const { password: _, ...safeUser } = user;
    safeUser.session_id = sessionId;
    
    return success({
      user: safeUser,
      token,
      level: safeUser.level
    });
    
  } catch (e) {
    console.error('登录错误:', e);
    return error('登录失败: ' + e.message);
  }
};
