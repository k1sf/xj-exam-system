/**
 * 微信云开发迁移补丁
 * 
 * 将此文件内容替换到 index.html 中的对应位置
 */

// ============================================
// 第一步：替换 SDK 引入（约第 1215 行）
// ============================================

// 原代码：
// <script src="https://unpkg.com/@supabase/supabase-js@2.39.0/dist/umd/supabase.js"></script>

// 替换为：
<script src="https://imgcache.qq.com/qcloud/cloudbase-js-sdk/1.7.1/cloudbase.full.js"></script>
<script src="cloud-api.js"></script>

// ============================================
// 第二步：替换 Supabase 配置（约第 1362-1364 行）
// ============================================

// 原代码：
// const SUPABASE_URL = 'https://...';
// const SUPABASE_ANON_KEY = '...';
// let supabase = null;

// 替换为：
const CLOUD_ENV_ID = '您的云开发环境ID';  // 修改为您的环境ID
let cloudApp = null;

// ============================================
// 第三步：替换初始化函数（约第 2821-2824 行）
// ============================================

// 原代码：
// if (!window.supabase) { ... }
// supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 替换为：
async function initCloud() {
  try {
    await CloudAPI.init(CLOUD_ENV_ID);
    cloudApp = true;
    console.log('云开发初始化成功');
    return true;
  } catch (e) {
    console.error('云开发初始化失败:', e);
    return false;
  }
}

// 页面加载时初始化
await initCloud();

// ============================================
// 第四步：替换 dbSelect 函数（约第 2860-2950 行）
// ============================================

// 原代码使用 supabase.from(table).select()
// 替换为调用云函数：

async function dbSelect(table, opts = {}) {
  try {
    const result = await CloudAPI.select(table, opts);
    return result;
  } catch (e) {
    console.error('dbSelect error:', e);
    return [];
  }
}

// ============================================
// 第五步：替换 dbInsert 函数
// ============================================

async function dbInsert(table, dataOrOpts) {
  try {
    return await CloudAPI.insert(table, dataOrOpts);
  } catch (e) {
    console.error('dbInsert error:', e);
    return { error: e.message };
  }
}

// ============================================
// 第六步：替换 dbUpdate 函数
// ============================================

async function dbUpdate(table, data, match) {
  try {
    return await CloudAPI.update(table, data, match);
  } catch (e) {
    console.error('dbUpdate error:', e);
    return { error: e.message };
  }
}

// ============================================
// 第七步：替换 dbDelete 函数
// ============================================

async function dbDelete(table, match) {
  try {
    return await CloudAPI.delete(table, match);
  } catch (e) {
    console.error('dbDelete error:', e);
    return { error: e.message };
  }
}

// ============================================
// 第八步：替换 dbCount 函数
// ============================================

async function dbCount(table, opts = {}) {
  try {
    return await CloudAPI.count(table, opts);
  } catch (e) {
    console.error('dbCount error:', e);
    return 0;
  }
}

// ============================================
// 第九步：替换登录函数
// ============================================

// 原来的 unifiedLogin 函数中，替换 Supabase 登录逻辑：
async function unifiedLogin(table, username, password, level = null) {
  try {
    const user = await CloudAPI.login(table, username, password, level);
    return { success: true, user };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================
// 第十步：删除所有 supabase 变量检查
// ============================================

// 将所有 `if (supabase)` 改为 `if (cloudApp)`
// 将所有 `!supabase` 改为 `!cloudApp`

// ============================================
// 自动替换脚本（可在浏览器控制台运行）
// ============================================

/*
// 批量替换变量名
document.body.innerHTML = document.body.innerHTML
  .replace(/supabase/g, 'cloudApp')
  .replace(/SUPABASE_URL/g, 'CLOUD_ENV_ID')
  .replace(/SUPABASE_ANON_KEY/g, 'CLOUD_ENV_ID')
  .replace(/\.from\(/g, '.callFunction(')
  .replace(/\.select\(/g, '.select(')
  .replace(/\.insert\(/g, '.insert(')
  .replace(/\.update\(/g, '.update(')
  .replace(/\.delete\(/g, '.delete(');
*/
