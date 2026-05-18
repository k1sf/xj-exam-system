/**
 * 微信云开发 - 公共工具函数
 */

const crypto = require('crypto');

// 密码盐值
const SALT = '_pedicure_salt_2026';

/**
 * SHA256 哈希密码
 * @param {string} password 明文密码
 * @returns {string} 哈希后的密码 (sha256:xxx 格式)
 */
function hashPassword(password) {
  const hash = crypto.createHash('sha256');
  hash.update(password + SALT);
  return 'sha256:' + hash.digest('hex');
}

/**
 * 验证密码
 * @param {string} password 明文密码
 * @param {string} storedPassword 存储的密码（可能是明文或哈希）
 * @returns {boolean} 是否匹配
 */
function verifyPassword(password, storedPassword) {
  // 如果是哈希格式
  if (storedPassword.startsWith('sha256:')) {
    return storedPassword === hashPassword(password);
  }
  // 如果是明文（兼容旧数据）
  return password === storedPassword;
}

/**
 * 生成随机 Token
 * @param {number} length 长度，默认 32
 * @returns {string} 随机 Token
 */
function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * 获取云数据库实例
 * @returns {Object} 数据库实例
 */
function getDb() {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  return cloud.database();
}

/**
 * 获取当前环境 ID
 * @returns {string} 环境 ID
 */
function getEnvId() {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  return cloud.DYNAMIC_CURRENT_ENV;
}

/**
 * 生成唯一 ID（类似 UUID）
 * @returns {string} 唯一 ID
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * 格式化日期
 * @param {Date|string|number} date 日期
 * @returns {string} ISO 格式字符串
 */
function formatDate(date) {
  if (!date) return null;
  const d = new Date(date);
  return d.toISOString();
}

/**
 * 检查是否过期
 * @param {string} expiresAt 过期时间
 * @returns {boolean} 是否已过期
 */
function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

/**
 * 成功响应
 * @param {any} data 数据
 * @returns {Object} 响应对象
 */
function success(data) {
  return {
    success: true,
    data
  };
}

/**
 * 失败响应
 * @param {string} message 错误信息
 * @param {number} code 错误码
 * @returns {Object} 响应对象
 */
function error(message, code = -1) {
  return {
    success: false,
    error: message,
    code
  };
}

/**
 * 验证 Token
 * @param {Object} db 数据库实例
 * @param {string} token Token
 * @param {string} table 表名
 * @param {string} id 用户 ID
 * @returns {Promise<Object|null>} 用户信息或 null
 */
async function validateToken(db, token, table, id) {
  if (!token || !id) return null;
  try {
    const res = await db.collection(table).doc(id).get();
    if (res.data && res.data.session_id === token) {
      return res.data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  getDb,
  getEnvId,
  generateId,
  formatDate,
  isExpired,
  success,
  error,
  validateToken
};
