/**
 * 统计数据云函数
 * 
 * 请求参数：
 * - table: 表名
 * - filter: 筛选条件对象
 * - eq: 等于条件 { field: value }
 * - gte: 大于等于 { field: value }
 * - gt: 大于 { field: value }
 * - lte: 小于等于 { field: value }
 * - lt: 小于 { field: value }
 * - in: IN 条件 { field: [values] }
 * - neq: 不等于 { field: value }
 * 
 * 返回：
 * - success: true/false
 * - count: 数量
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { success, error } = require('../common/utils');

// 允许查询的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

exports.main = async (event, context) => {
  const { table, filter, eq, gte, gt, lte, lt, in: inCond, neq } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  try {
    // 构建查询条件
    let where = {};
    
    // 基础筛选
    if (filter && typeof filter === 'object') {
      Object.assign(where, filter);
    }
    
    // 等于条件
    if (eq && typeof eq === 'object') {
      for (const [key, value] of Object.entries(eq)) {
        where[key] = value;
      }
    }
    
    // 大于等于
    if (gte && typeof gte === 'object') {
      for (const [key, value] of Object.entries(gte)) {
        where[key] = _.gte(value);
      }
    }
    
    // 大于
    if (gt && typeof gt === 'object') {
      for (const [key, value] of Object.entries(gt)) {
        where[key] = _.gt(value);
      }
    }
    
    // 小于等于
    if (lte && typeof lte === 'object') {
      for (const [key, value] of Object.entries(lte)) {
        where[key] = _.lte(value);
      }
    }
    
    // 小于
    if (lt && typeof lt === 'object') {
      for (const [key, value] of Object.entries(lt)) {
        where[key] = _.lt(value);
      }
    }
    
    // IN 条件
    if (inCond && typeof inCond === 'object') {
      for (const [key, values] of Object.entries(inCond)) {
        if (Array.isArray(values)) {
          where[key] = _.in(values);
        }
      }
    }
    
    // 不等于
    if (neq && typeof neq === 'object') {
      for (const [key, value] of Object.entries(neq)) {
        where[key] = _.neq(value);
      }
    }
    
    // 执行计数
    const res = await db.collection(table).where(where).count();
    
    return success({
      count: res.total
    });
    
  } catch (e) {
    console.error('统计错误:', e);
    return error('统计失败: ' + e.message);
  }
};
