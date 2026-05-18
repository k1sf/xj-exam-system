/**
 * 微信云开发 - 前端 API 适配层
 * 
 * 使用方式：
 * 1. 在 HTML 中引入云开发 SDK
 *    <script src="https://imgcache.qq.com/qcloud/cloudbase-js-sdk/1.7.1/cloudbase.full.js"></script>
 * 2. 初始化云开发
 *    initCloudApp('您的云开发环境ID');
 * 3. 调用 API（与原来 Supabase 方式类似）
 *    await dbSelect('students', { eq: { status: 'active' } });
 */

// 云开发实例
let cloudApp = null;
let cloudDb = null;
let cloudFunctions = null;

// 当前用户信息
let currentUser = null;
let currentToken = null;

/**
 * 初始化云开发
 * @param {string} envId 云开发环境ID
 */
async function initCloudApp(envId) {
  try {
    cloudApp = cloudbase.init({
      env: envId
    });
    
    // 匿名登录（网页端必须先匿名登录才能调用云函数）
    await cloudApp.auth().anonymousAuthProvider().signIn();
    
    cloudFunctions = cloudApp.app;
    console.log('云开发初始化成功');
    return true;
  } catch (e) {
    console.error('云开发初始化失败:', e);
    return false;
  }
}

/**
 * 调用云函数
 * @param {string} name 云函数名称
 * @param {object} data 参数
 * @returns {Promise<object>} 结果
 */
async function callFunction(name, data = {}) {
  if (!cloudApp) {
    throw new Error('云开发未初始化');
  }
  
  try {
    const res = await cloudApp.callFunction({
      name,
      data
    });
    
    if (res.result && res.result.success) {
      return res.result.data;
    } else {
      throw new Error(res.result?.error || '调用失败');
    }
  } catch (e) {
    console.error(`云函数 ${name} 调用失败:`, e);
    throw e;
  }
}

/**
 * 登录
 * @param {string} table 表名 ('students' 或 'admins')
 * @param {string} username 用户名
 * @param {string} password 密码
 * @param {string} level 级别（学生可选）
 * @returns {Promise<object>} 用户信息
 */
async function cloudLogin(table, username, password, level = null) {
  const data = { table, username, password };
  if (level) data.level = level;
  
  const result = await callFunction('login', data);
  
  if (result && result.user) {
    currentUser = result.user;
    currentToken = result.token;
    
    // 存储到 localStorage
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    localStorage.setItem('currentToken', currentToken);
    localStorage.setItem('userTable', table);
    
    return result.user;
  }
  
  throw new Error('登录失败');
}

/**
 * 查询数据
 * @param {string} table 表名
 * @param {object} opts 选项 { filter, eq, gte, gt, lte, lt, in, neq, like, limit, offset, order, select }
 * @returns {Promise<array>} 数据数组
 */
async function dbSelect(table, opts = {}) {
  const result = await callFunction('select', { table, ...opts });
  return result.data || [];
}

/**
 * 插入数据
 * @param {string} table 表名
 * @param {object|function} dataOrOpts 数据或选项
 * @returns {Promise<object>} 结果
 */
async function dbInsert(table, dataOrOpts) {
  // 兼容两种调用方式
  if (typeof dataOrOpts === 'function') {
    // dbInsert(table, cb => cb(data))
    let data = null;
    dataOrOpts(d => { data = d; });
    return callFunction('insert', { table, data });
  } else if (dataOrOpts.rows) {
    // dbInsert(table, { rows: [...] })
    return callFunction('insert', { table, rows: dataOrOpts.rows });
  } else {
    // dbInsert(table, data)
    return callFunction('insert', { table, data: dataOrOpts });
  }
}

/**
 * 更新数据
 * @param {string} table 表名
 * @param {object} data 更新的数据
 * @param {object} match 匹配条件
 * @returns {Promise<object>} 结果
 */
async function dbUpdate(table, data, match = null) {
  if (match) {
    return callFunction('update', { table, data, match });
  } else {
    // 兼容 dbUpdate(table, { data, match }) 格式
    return callFunction('update', { table, data: data.data, match: data.match });
  }
}

/**
 * 删除数据
 * @param {string} table 表名
 * @param {object} match 匹配条件
 * @returns {Promise<object>} 结果
 */
async function dbDelete(table, match) {
  return callFunction('delete', { table, match });
}

/**
 * 统计数量
 * @param {string} table 表名
 * @param {object} opts 选项
 * @returns {Promise<number>} 数量
 */
async function dbCount(table, opts = {}) {
  const result = await callFunction('count', { table, ...opts });
  return result.count || 0;
}

/**
 * 获取当前用户
 * @returns {object|null} 当前用户
 */
function getCurrentUser() {
  if (!currentUser) {
    const stored = localStorage.getItem('currentUser');
    if (stored) {
      currentUser = JSON.parse(stored);
    }
  }
  return currentUser;
}

/**
 * 获取当前 Token
 * @returns {string|null} Token
 */
function getCurrentToken() {
  if (!currentToken) {
    currentToken = localStorage.getItem('currentToken');
  }
  return currentToken;
}

/**
 * 退出登录
 */
function logout() {
  currentUser = null;
  currentToken = null;
  localStorage.removeItem('currentUser');
  localStorage.removeItem('currentToken');
  localStorage.removeItem('userTable');
}

/**
 * 检查会话状态
 * @returns {boolean} 是否已登录
 */
function isLoggedIn() {
  return getCurrentUser() !== null;
}

// 导出到全局
window.CloudAPI = {
  init: initCloudApp,
  login: cloudLogin,
  select: dbSelect,
  insert: dbInsert,
  update: dbUpdate,
  delete: dbDelete,
  count: dbCount,
  getUser: getCurrentUser,
  getToken: getCurrentToken,
  logout,
  isLoggedIn
};

// 兼容旧 API
window.dbSelect = dbSelect;
window.dbInsert = dbInsert;
window.dbUpdate = dbUpdate;
window.dbDelete = dbDelete;
window.dbCount = dbCount;
