/**
 * 查询数据云函数
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
 * - like: 模糊匹配 { field: value }
 * - limit: 限制数量
 * - offset: 偏移量
 * - order: 排序 [字段, 是否降序]
 * - select: 选择字段数组
 * 
 * 返回：
 * - success: true/false
 * - data: 数据数组
 * - count: 总数（可选）
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
  const { table, filter, eq, gte, gt, lte, lt, in: inCond, neq, like, limit, offset, order, select } = event;
  
  // 参数校验
  if (!table) {
    return error('缺少表名');
  }
  
  if (!ALLOWED_TABLES.includes(table)) {
    return error('无效的表名');
  }
  
  try {
    let query = db.collection(table);
    
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
    
    // 模糊匹配
    if (like && typeof like === 'object') {
      for (const [key, value] of Object.entries(like)) {
        // 云数据库使用正则表达式
        where[key] = db.RegExp({
          regexp: value,
          options: 'i'
        });
      }
    }
    
    // 应用条件
    if (Object.keys(where).length > 0) {
      query = query.where(where);
    }
    
    // 获取总数
    let totalCount = null;
    const countRes = await db.collection(table).where(where).count();
    totalCount = countRes.total;
    
    // 排序
    if (order && Array.isArray(order) && order.length >= 1) {
      const [field, desc] = order;
      query = query.orderBy(field, desc ? 'desc' : 'asc');
    } else {
      // 默认按 _id 升序
      query = query.orderBy('_id', 'asc');
    }
    
    // 偏移
    if (offset && offset > 0) {
      query = query.skip(offset);
    }
    
    // 限制
    if (limit && limit > 0) {
      query = query.limit(Math.min(limit, 100)); // 最大 100
    } else {
      query = query.limit(20); // 默认 20
    }
    
    // 执行查询
    const res = await query.get();
    
    // 处理返回数据
    let data = res.data;
    
    // 字段选择
    if (select && Array.isArray(select) && select.length > 0) {
      data = data.map(item => {
        const selected = {};
        select.forEach(field => {
          if (item[field] !== undefined) {
            selected[field] = item[field];
          }
        });
        return selected;
      });
    }
    
    return success({
      data,
      count: totalCount
    });
    
  } catch (e) {
    console.error('查询错误:', e);
    return error('查询失败: ' + e.message);
  }
};
