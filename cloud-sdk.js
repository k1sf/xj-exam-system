/**
 * 云开发 SDK 初始化和 API 封装
 * 用于替代 Supabase SDK
 */

// 云开发环境配置
const CLOUD_CONFIG = {
  envId: 'xj-exam-d8gh1ynujedfe558e', // 部署时填写您的云开发环境 ID
};

// 全局变量
let cloud = null;
let db = null;
let functions = null;

/**
 * 初始化云开发 SDK
 */
async function initCloudBase() {
  // 检查是否在云开发环境中
  if (typeof window !== 'undefined' && window.cloudbase) {
    // Web SDK
    const app = window.cloudbase.init({
      env: CLOUD_CONFIG.envId,
    });
    cloud = app;
    db = app.database();
    functions = app.functions();
    
    // 尝试匿名登录
    try {
      await app.auth().anonymousAuthProvider().signIn();
      console.log('云开发匿名登录成功');
    } catch (e) {
      console.log('匿名登录失败，使用未登录模式', e);
    }
    
    return app;
  } else {
    throw new Error('请先加载云开发 SDK');
  }
}

/**
 * 调用云函数
 */
async function callFunction(name, data) {
  if (!functions) {
    throw new Error('云开发未初始化');
  }
  
  try {
    const result = await functions.callFunction({
      name: name,
      data: data,
    });
    
    if (result.result) {
      return result.result;
    }
    throw new Error('云函数返回数据为空');
  } catch (e) {
    console.error('云函数调用失败:', name, e);
    throw e;
  }
}

/**
 * 登录验证
 */
async function dbLogin(table, username, password, level) {
  return callFunction('login', { table, username, password, level });
}

/**
 * 查询数据
 */
async function dbSelect(table, opts = {}) {
  return callFunction('select', { table, ...opts });
}

/**
 * 插入数据
 */
async function dbInsert(table, opts = {}) {
  return callFunction('insert', { table, ...opts });
}

/**
 * 更新数据
 */
async function dbUpdate(table, data, match) {
  return callFunction('update', { table, data, match });
}

/**
 * 删除数据
 */
async function dbDelete(table, match) {
  return callFunction('delete', { table, match });
}

/**
 * 统计数量
 */
async function dbCount(table, match = {}) {
  return callFunction('count', { table, match });
}

// 导出全局函数
window.initCloudBase = initCloudBase;
window.dbLogin = dbLogin;
window.dbSelect = dbSelect;
window.dbInsert = dbInsert;
window.dbUpdate = dbUpdate;
window.dbDelete = dbDelete;
window.dbCount = dbCount;
window.CLOUD_CONFIG = CLOUD_CONFIG;
