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

const tcb = require('tcb-admin-node');

// 初始化
tcb.init();

const db = tcb.database();
const _ = db.command;

function success(data) {
  return { success: true, ...data };
}

function error(message) {
  return { success: false, error: message };
}

// 允许查询的表
const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'homeworks', 'homework_records'
];

exports.main = async (event, context) => {
  const { table, filter, eq, gte, gt, lte, lt, in: inCond, neq, like, limit, offset, order, select: selectFields } = event;
  
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
    
    // 不等于条件
    if (neq && typeof neq === 'object') {
      for (const [key, value] of Object.entries(neq)) {
        where[key] = _.neq(value);
      }
    }
    
    // 模糊匹配
    if (like && typeof like === 'object') {
      for (const [key, value] of Object.entries(like)) {
        // 云数据库使用正则匹配
        where[key] = db.RegExp({
          regexp: value,
          options: 'i'
        });
      }
    }
    
    // 构建查询
    let query = db.collection(table);
    
    // 应用条件
    if (Object.keys(where).length > 0) {
      query = query.where(where);
    }
    
    // 排序
    if (order) {
      const [field, desc] = Array.isArray(order) ? order : [order, false];
      query = query.orderBy(field, desc ? 'desc' : 'asc');
    }
    
    // 偏移
    if (offset && offset > 0) {
      query = query.skip(offset);
    }
    
    // 限制数量
    if (limit && limit > 0) {
      query = query.limit(Math.min(limit, 1000));
    }
    
    // 执行查询
    const res = await query.get();
    
    // 转换 _id 为 id
    const data = res.data.map(item => {
      if (item._id) {
        item.id = item._id;
        delete item._id;
      }
      return item;
    });
    
    return success({ data });
    
  } catch (err) {
    console.error('查询错误:', err);
    return error('查询失败: ' + err.message);
  }
};
