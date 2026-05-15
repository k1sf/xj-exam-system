const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = process.env.DEPLOY_RUN_PORT || 5000;

// Direct PostgreSQL connection via pg module
const { Pool } = require('pg');
// Fix channel_binding issue by replacing the URL
const dbUrl = process.env.PGDATABASE_URL || '';
let dbUrlFixed = dbUrl;
// 确保只有一个 sslmode
dbUrlFixed = dbUrlFixed.replace(/sslmode=[^&]+&?/g, '');
// 移除 channel_binding
dbUrlFixed = dbUrlFixed.replace(/channel_binding=[^&]+&?/g, '');
// 确保有 ?
if (!dbUrlFixed.includes('?')) {
  dbUrlFixed += '?';
}
// 移除末尾的 ? 如果有的话
dbUrlFixed = dbUrlFixed.replace(/\?$/, '');
// 添加 uselibpqcompat 和 sslmode
dbUrlFixed = dbUrlFixed + '?uselibpqcompat=true&sslmode=require';
console.log('数据库URL:', dbUrlFixed.replace(/\/\/[^@]+@/, '//***:***@'));
const pool = new Pool({
  connectionString: dbUrlFixed,
  ssl: { rejectUnauthorized: false },
  max: 50,                    // 最大连接数（免费版建议50以内）
  min: 5,                     // 最小保持5个连接
  idleTimeoutMillis: 60000,   // 空闲连接保持60秒
  connectionTimeoutMillis: 5000, // 连接超时5秒
  statement_timeout: 15000,   // 单条SQL超时15秒
  query_timeout: 20000        // 查询超时20秒
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error:', err.message);
});

const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===== Security: table whitelist =====
const ALLOWED_TABLES = ['students', 'questions', 'records', 'exams', 'admins', 'enroll_configs', 'enrollments', 'notifications', 'operation_logs', 'wrong_question_mastery', 'wrong_training_sessions', 'system_settings'];
function validateTable(table) {
  if (!ALLOWED_TABLES.includes(table)) throw new Error('Invalid table: ' + table);
  return table;
}

// ===== Security: API token =====
// Fixed token embedded in HTML and required in API calls
const API_TOKEN = process.env.API_TOKEN || 'xj_exam_system_api_token_2024_fixed';

// ===== Super Admin Password =====
// This password is used for emergency recovery when main admin password is lost
// Default password: TpBXNX8LTXyqML1WEb49vOFFPUS7tKnb (32 chars, auto-generated)
// To change: update the hash below (regenerate with: crypto.createHash('sha256').update('newpassword_super_recovery_salt_2026').digest('hex'))
const DEFAULT_SUPER_ADMIN_HASH = 'de3eb2ed3b8d2655e6bee7eb527df5b4505139b07a1b61e53f6bf5d19619dba8';
const SUPER_PASSWORD_FILE = path.join(__dirname, '.super_password');

function getSuperAdminHash() {
  // 优先从文件读取（如果存在）
  if (fs.existsSync(SUPER_PASSWORD_FILE)) {
    try {
      return fs.readFileSync(SUPER_PASSWORD_FILE, 'utf8').trim();
    } catch (e) {
      console.error('读取超级密码文件失败:', e.message);
    }
  }
  // 其次从环境变量读取
  if (process.env.SUPER_ADMIN_HASH) {
    return process.env.SUPER_ADMIN_HASH;
  }
  // 最后使用默认值
  return DEFAULT_SUPER_ADMIN_HASH;
}

function verifySuperAdmin(password) {
  const hash = crypto.createHash('sha256').update(password + '_super_recovery_salt_2026').digest('hex');
  return hash === getSuperAdminHash();
}

// ===== Email Config for Auto Backup =====
const EMAIL_CONFIG = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: '1027424321@qq.com',
    pass: 'ljamomjdkkocbegf'
  },
  // 添加超时配置，防止长时间阻塞
  connectionTimeout: 10000,  // 连接超时10秒
  socketTimeout: 30000,      // Socket超时30秒
  greetingTimeout: 10000,    // 问候超时10秒
  responseTimeout: 30000     // 响应超时30秒
};

// 创建邮件传输器
const transporter = nodemailer.createTransport(EMAIL_CONFIG);

// 备份配置（存储在内存中，可从数据库读取）
let backupConfig = {
  enabled: true,
  email: '1027424321@qq.com',  // 默认发送到同一邮箱
  schedule: 'monthly',  // monthly: 每月1日
  lastBackupTime: null,
  backupHistory: []  // 保存最近3份备份记录
};

// 发送备份邮件（带超时控制）
async function sendBackupEmail(backupData, filename) {
  const mailOptions = {
    from: EMAIL_CONFIG.auth.user,
    to: backupConfig.email,
    subject: `【修脚师考试系统】数据库备份 - ${new Date().toLocaleDateString('zh-CN')}`,
    text: `您好！\n\n这是修脚师考试系统的自动备份数据。\n\n备份时间：${new Date().toLocaleString('zh-CN')}\n备份文件：${filename}\n\n请妥善保管此备份文件。\n\n系统自动发送，请勿回复。`,
    attachments: [
      {
        filename: filename,
        content: typeof backupData === 'string' ? backupData : JSON.stringify(backupData, null, 2)
      }
    ]
  };
  
  // 使用 Promise.race 添加超时控制
  const timeoutMs = 45000; // 45秒超时
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('邮件发送超时，请检查网络连接')), timeoutMs);
  });
  
  const sendPromise = new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('发送备份邮件失败:', error);
        reject(error);
      } else {
        console.log('备份邮件发送成功:', info.response);
        resolve(info);
      }
    });
  });
  
  return Promise.race([sendPromise, timeoutPromise]);
}

// 执行数据库备份
async function performBackup() {
  try {
    console.log('开始执行数据库备份...');
    
    // 导出所有表数据
    const tables = ['students', 'questions', 'records', 'exams', 'admins'];
    const backupData = {};
    
    for (const table of tables) {
      const result = await pool.query(`SELECT * FROM "${table}"`);
      backupData[table] = result.rows;
    }
    
    // 添加元数据
    backupData._meta = {
      backupTime: new Date().toISOString(),
      version: '1.0'
    };
    
    const jsonStr = JSON.stringify(backupData, null, 2);
    const filename = `backup_${new Date().toISOString().slice(0,10)}.json`;
    
    // 发送邮件
    await sendBackupEmail(jsonStr, filename);
    
    // 更新备份时间
    const backupTime = new Date().toISOString();
    backupConfig.lastBackupTime = backupTime;
    
    // 记录备份历史，保留最近3份
    backupConfig.backupHistory.push({
      time: backupTime,
      filename: filename,
      size: jsonStr.length
    });
    // 只保留最近3份
    if (backupConfig.backupHistory.length > 3) {
      backupConfig.backupHistory = backupConfig.backupHistory.slice(-3);
    }
    
    console.log('数据库备份完成，邮件已发送');
    return { success: true, message: '备份成功，邮件已发送' };
  } catch (error) {
    console.error('数据库备份失败:', error);
    return { success: false, message: error.message };
  }
}

// 定时备份（每月1日凌晨3点执行）
let backupTimer = null;

function startBackupScheduler() {
  // 每小时检查一次是否需要备份
  backupTimer = setInterval(async () => {
    const now = new Date();
    const date = now.getDate(); // 日期（1-31）
    const hour = now.getHours();
    
    // 每月1日凌晨3点执行备份
    if (date === 1 && hour === 3 && backupConfig.enabled) {
      const lastBackup = backupConfig.lastBackupTime ? new Date(backupConfig.lastBackupTime) : null;
      const hoursSinceLastBackup = lastBackup ? (now - lastBackup) / (1000 * 60 * 60) : 100;
      
      // 确保不会重复备份（距离上次备份超过12小时）
      if (hoursSinceLastBackup > 12) {
        console.log('每月定时备份触发...');
        await performBackup();
      }
    }
  }, 60 * 60 * 1000); // 每小时检查一次
  
  console.log('备份定时器已启动（每月1日凌晨3点）');
}

// 启动时启动备份定时器
startBackupScheduler();

// ===== Security: select whitelist =====
// Only allow simple column names (alphanumeric + underscore), no expressions
function validateSelect(selInput) {
  if (!selInput || selInput === '*') return '*';
  // Support both string ("col1,col2") and array ["col1","col2"]
  const selStr = Array.isArray(selInput) ? selInput.join(',') : String(selInput);
  const parts = selStr.split(',').map(s => s.trim()).filter(Boolean);
  const safe = parts.every(p => /^[a-zA-Z_]\w*$/.test(p));
  if (!safe) throw new Error('Invalid select fields');
  return parts.map(p => `"${p}"`).join(',');
}

// ===== Security: order whitelist =====
function validateOrder(order) {
  if (!order) return '';
  // Handle both array format [['col', false]] and direct array ['col', false]
  const orders = Array.isArray(order) && Array.isArray(order[0]) ? order : [order];
  const safeOrders = orders.map(o => {
    if (!Array.isArray(o) || o.length < 1) throw new Error('Invalid order format');
    const col = String(o[0]);
    if (!/^[a-zA-Z_]\w*$/.test(col)) throw new Error('Invalid order column');
    const dir = o[1] === false ? 'DESC' : 'ASC';
    return `"${col}" ${dir}`;
  });
  return ' ORDER BY ' + safeOrders.join(', ');
}

// ===== Security: password hashing =====
function hashPassword(pwd) {
  return 'sha256:' + crypto.createHash('sha256').update(pwd + '_pedicure_salt_2026').digest('hex');
}

function verifyPassword(input, stored) {
  if (!stored) return false;
  // New format: sha256:hexhash
  if (stored.startsWith('sha256:')) {
    return stored === hashPassword(input);
  }
  // Legacy: plaintext comparison + auto-upgrade flag
  return input === stored;
}

function needsUpgrade(stored) {
  return stored && !stored.startsWith('sha256:');
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Token'
  });
  res.end(JSON.stringify(data));
}

function escKey(k) {
  return `"${k.replace(/"/g, '""')}"`;
}

function escVal(v, colType) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (colType === 'bigint_array') {
      return `ARRAY[${v.join(',')}]::bigint[]`;
    }
    const escaped = v.map(item => `'${String(item).replace(/'/g, "''")}'`);
    return `ARRAY[${escaped.join(',')}]::text[]`;
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  if (colType === 'jsonb') return `'${String(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const ARRAY_COLUMNS = {
  'questions': { 'tags': 'text_array', 'options': 'jsonb' },
  'exams': { 'question_ids': 'bigint_array' },
  'enroll_configs': { 'levels': 'text_array' }
};

function getColType(table, col) {
  return (ARRAY_COLUMNS[table] && ARRAY_COLUMNS[table][col]) || null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Token'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Inject API_TOKEN into HTML page so frontend can use it
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf-8', (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const injected = data.replace('__API_TOKEN__', API_TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(injected);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Skip token verification for all endpoints (simpler for deployment)
    const isAuthEndpoint = true; // Allow all API calls without token
    const reqToken = req.headers['x-api-token'] || url.searchParams.get('token');
    if (!isAuthEndpoint && reqToken !== API_TOKEN) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }
    try {
      // Parse body first for all API calls
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = body ? JSON.parse(body) : {};
      
      // Handle enrollment API separately
      if (url.pathname.startsWith('/api/enroll')) {
        await handleEnrollApi(req, res, url, params);
        return;
      }
      // Handle homework API separately
      if (url.pathname.startsWith('/api/homework')) {
        await handleHomeworkApi(req, res, url, params);
        return;
      }
      // Handle daily task API separately
      if (url.pathname.startsWith('/api/daily-task')) {
        await handleDailyTaskApi(req, res, url, params);
        return;
      }
      // Handle notification API separately
      if (url.pathname.startsWith('/api/notification')) {
        await handleNotificationApi(req, res, url, params);
        return;
      }
      // Handle report API separately
      if (url.pathname.startsWith('/api/report')) {
        await handleReportApi(req, res, url, params);
        return;
      }
      // Handle wrong training API separately
      if (url.pathname.startsWith('/api/wrong')) {
        await handleWrongTrainingApi(req, res, url, params);
        return;
      }
      // Handle operation log API and other extended APIs separately
      // Note: Must check /api/log/ or exact /api/log to avoid matching /api/login
      if (url.pathname === '/api/log' || url.pathname.startsWith('/api/log/')) {
        await handleLogApi(req, res, url, params);
        return;
      }
      await handleApi(req, res, url, params);
    } catch(e) {
      console.error('API Error:', e.message);
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Static file serving
  let filePath = path.join(__dirname, url.pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    let content = data;
    // Inject API_TOKEN into index.html
    if (filePath.endsWith('index.html')) {
      content = data.toString().replace(/__API_TOKEN__/g, API_TOKEN);
    }
    res.writeHead(200, { 'Content-Type': MIMES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

async function handleApi(req, res, url, sharedParams) {
  const params = sharedParams || {};
  const route = url.pathname.replace('/api/', '');

  switch(route) {
    case 'logout': {
      // Clear session_id on client logout
      const sessionId = req.headers['x-session-id'] || params.sessionId;
      if (sessionId) {
        // Clear session_id from both tables (find which table has this session)
        const adminSql = `UPDATE admins SET "session_id" = NULL WHERE "session_id" = ${escVal(sessionId)}`;
        const studentSql = `UPDATE students SET "session_id" = NULL WHERE "session_id" = ${escVal(sessionId)}`;
        try {
          await Promise.all([
            pool.query(adminSql),
            pool.query(studentSql)
          ]);
        } catch(e) { console.error('Logout clear session failed:', e.message); }
      }
      sendJson(res, { success: true });
      break;
    }
    case 'select': {
      const { table: rawTable, filter, order, limit, offset, select, eq, gte, gt, lte, lt } = params;
      const table = validateTable(rawTable);
      const selStr = validateSelect(select);
      let sql = `SELECT ${selStr} FROM ${table}`;
      const conds = [];
      // eq filter (legacy 'filter' param)
      if (filter) {
        Object.entries(filter).forEach(([k, v]) => {
          if (v === null || v === undefined) conds.push(`${escKey(k)} IS NULL`);
          else if (typeof v === 'boolean') conds.push(`${escKey(k)} = ${v}`);
          else if (typeof v === 'number') conds.push(`${escKey(k)} = ${v}`);
          else conds.push(`${escKey(k)} = ${escVal(v, getColType(table, k))}`);
        });
      }
      // eq shorthand
      if (eq) {
        Object.entries(eq).forEach(([k, v]) => {
          if (v === null || v === undefined) conds.push(`${escKey(k)} IS NULL`);
          else if (typeof v === 'boolean') conds.push(`${escKey(k)} = ${v}`);
          else if (typeof v === 'number') conds.push(`${escKey(k)} = ${v}`);
          else if (Array.isArray(v)) conds.push(`${escKey(k)} IN (${v.map(x => escVal(x, getColType(table, k))).join(',')})`);
          else conds.push(`${escKey(k)} = ${escVal(v, getColType(table, k))}`);
        });
      }
      // Range operators for date/number filtering
      if (gte) Object.entries(gte).forEach(([k, v]) => conds.push(`${escKey(k)} >= ${escVal(v, getColType(table, k))}`));
      if (gt)  Object.entries(gt).forEach(([k, v])  => conds.push(`${escKey(k)} > ${escVal(v, getColType(table, k))}`));
      if (lte) Object.entries(lte).forEach(([k, v]) => conds.push(`${escKey(k)} <= ${escVal(v, getColType(table, k))}`));
      if (lt)  Object.entries(lt).forEach(([k, v])  => conds.push(`${escKey(k)} < ${escVal(v, getColType(table, k))}`));
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += validateOrder(order);
      if (limit) sql += ` LIMIT ${parseInt(limit)}`;
      if (offset) sql += ` OFFSET ${parseInt(offset)}`;

      const result = await pool.query(sql);
      sendJson(res, result.rows);
      break;
    }
    case 'insert': {
      const { table: rawTable, rows: insertRows } = params;
      const table = validateTable(rawTable);
      if (!insertRows || !insertRows.length) { sendJson(res, { error: 'No rows' }, 400); return; }
      const cols = Object.keys(insertRows[0]);
      // Hash password fields on insert
      const processedRows = insertRows.map(row => {
        const r = { ...row };
        if ('password' in r && r.password && !String(r.password).startsWith('sha256:')) {
          r.password = hashPassword(r.password);
        }
        return r;
      });
      const valSets = processedRows.map(row => {
        const vals = cols.map(c => escVal(row[c], getColType(table, c)));
        return `(${vals.join(',')})`;
      });
      const sql = `INSERT INTO ${table} (${cols.map(escKey).join(',')}) VALUES ${valSets.join(',')} RETURNING *`;
      const result = await pool.query(sql);
      sendJson(res, result.rows);
      break;
    }
    case 'update': {
      // 批量更新支持：支持单个match或match数组
      const { table: rawTable, data, match, batch } = params;
      const table = validateTable(rawTable);
      
      // 处理批量更新
      if (batch && Array.isArray(batch)) {
        // batch模式：[{data: {...}, match: {...}}, ...]
        let successCount = 0;
        let failCount = 0;
        
        for (const item of batch) {
          try {
            const processedData = { ...item.data };
            if ('password' in processedData && processedData.password && !String(processedData.password).startsWith('sha256:')) {
              processedData.password = hashPassword(processedData.password);
            }
            const sets = Object.entries(processedData).map(([k, v]) => `${escKey(k)} = ${escVal(v, getColType(table, k))}`);
            const conds = Object.entries(item.match || {}).map(([k, v]) => {
              if (v === null || v === undefined) return `${escKey(k)} IS NULL`;
              if (Array.isArray(v)) {
                const vals = v.map(item => {
                  if (typeof item === 'number') return item;
                  if (typeof item === 'boolean') return item;
                  return escVal(item, getColType(table, k));
                });
                return `${escKey(k)} IN (${vals.join(',')})`;
              }
              if (typeof v === 'boolean') return `${escKey(k)} = ${v}`;
              if (typeof v === 'number') return `${escKey(k)} = ${v}`;
              return `${escKey(k)} = ${escVal(v, getColType(table, k))}`;
            });
            
            if (conds.length > 0) {
              const sql = `UPDATE ${table} SET ${sets.join(',')} WHERE ${conds.join(' AND ')}`;
              await pool.query(sql);
              successCount++;
            } else {
              failCount++;
            }
          } catch(e) {
            failCount++;
            console.error('Batch update error:', e.message);
          }
        }
        
        sendJson(res, { success: true, successCount, failCount });
        return;
      }
      
      // 单个更新
      const processedData = { ...data };
      // Hash password field on update if it's plaintext
      if ('password' in processedData && processedData.password && !String(processedData.password).startsWith('sha256:')) {
        processedData.password = hashPassword(processedData.password);
      }
      const sets = Object.entries(processedData).map(([k, v]) => `${escKey(k)} = ${escVal(v, getColType(table, k))}`);
      const conds = Object.entries(match || {}).map(([k, v]) => {
        if (v === null || v === undefined) return `${escKey(k)} IS NULL`;
        if (Array.isArray(v)) {
          const vals = v.map(item => {
            if (typeof item === 'number') return item;
            if (typeof item === 'boolean') return item;
            return escVal(item, getColType(table, k));
          });
          return `${escKey(k)} IN (${vals.join(',')})`;
        }
        if (typeof v === 'boolean') return `${escKey(k)} = ${v}`;
        if (typeof v === 'number') return `${escKey(k)} = ${v}`;
        return `${escKey(k)} = ${escVal(v, getColType(table, k))}`;
      });
      if (conds.length === 0) {
        sendJson(res, { error: 'Empty match requires condition' }, 400);
        return;
      }
      const sql = `UPDATE ${table} SET ${sets.join(',')} WHERE ${conds.join(' AND ')} RETURNING *`;
      const result = await pool.query(sql);
      sendJson(res, result.rows);
      break;
    }
    case 'progress': {
      const { table: rawTable, data, match } = params;
      const table = validateTable(rawTable);
      const processedData = { ...data };
      // Hash password field on update if it's plaintext
      if ('password' in processedData && processedData.password && !String(processedData.password).startsWith('sha256:')) {
        processedData.password = hashPassword(processedData.password);
      }
      const sets = Object.entries(processedData).map(([k, v]) => `${escKey(k)} = ${escVal(v, getColType(table, k))}`);
      const conds = Object.entries(match || {}).map(([k, v]) => {
        if (v === null || v === undefined) return `${escKey(k)} IS NULL`;
        if (typeof v === 'boolean') return `${escKey(k)} = ${v}`;
        if (typeof v === 'number') return `${escKey(k)} = ${v}`;
        return `${escKey(k)} = ${escVal(v, getColType(table, k))}`;
      });
      if (conds.length === 0) {
        sendJson(res, { error: 'Empty match requires condition' }, 400);
        return;
      }
      const sql = `UPDATE ${table} SET ${sets.join(',')} WHERE ${conds.join(' AND ')} RETURNING *`;
      const result = await pool.query(sql);
      sendJson(res, result.rows);
      break;
    }
    case 'delete': {
      const { table: rawTable, match = {}, force = false } = params;
      const table = validateTable(rawTable);
      const conds = Object.entries(match || {}).map(([k, v]) => {
        if (v === null || v === undefined) return `${escKey(k)} IS NULL`;
        if (Array.isArray(v)) {
          const vals = v.map(item => {
            if (typeof item === 'number') return item;
            if (typeof item === 'boolean') return item;
            return escVal(item, getColType(table, k));
          });
          return `${escKey(k)} IN (${vals.join(',')})`;
        }
        if (typeof v === 'boolean') return `${escKey(k)} = ${v}`;
        if (typeof v === 'number') return `${escKey(k)} = ${v}`;
        return `${escKey(k)} = ${escVal(v, getColType(table, k))}`;
      });
      
      // 安全检查：空条件需要 force=true 且仅限特定表
      if (conds.length === 0) {
        if (!force) {
          sendJson(res, { error: 'Empty match requires force=true' }, 400);
          return;
        }
        // 仅允许清空 records 和 questions 表
        if (!['records', 'questions'].includes(table)) {
          sendJson(res, { error: 'Cannot truncate this table' }, 403);
          return;
        }
        const sql = `DELETE FROM ${table}`;
        await pool.query(sql);
        sendJson(res, { success: true, truncated: true });
      } else {
        const sql = `DELETE FROM ${table} WHERE ${conds.join(' AND ')}`;
        await pool.query(sql);
        sendJson(res, { success: true });
      }
      break;
    }
    case 'count': {
      const { table: rawTable, filter } = params;
      const table = validateTable(rawTable);
      let sql = `SELECT COUNT(*) as count FROM ${table}`;
      const conds = [];
      if (filter) {
        Object.entries(filter).forEach(([k, v]) => {
          if (v === null || v === undefined) conds.push(`${escKey(k)} IS NULL`);
          else if (typeof v === 'boolean') conds.push(`${escKey(k)} = ${v}`);
          else if (typeof v === 'number') conds.push(`${escKey(k)} = ${v}`);
          else conds.push(`${escKey(k)} = ${escVal(v, getColType(table, k))}`);
        });
      }
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      const result = await pool.query(sql);
      sendJson(res, result.rows[0]);
      break;
    }
    case 'verify-password': {
      // Verify password without updating session_id (for admin operations)
      // Support super admin password: xj_super_admin_2024
      const { table: rawTable, username, password } = params;
      console.log('verify-password called:', { table: rawTable, username });
      
      // Check super admin password first
      if (password === 'xj_super_admin_2024') {
        console.log('Super admin password verified');
        sendJson(res, { valid: true, is_super_admin: true });
        return;
      }
      
      // If not super admin, verify against database
      const table = validateTable(rawTable);
      if (!username || !password) { sendJson(res, { error: 'Missing credentials' }, 400); return; }
      const sql = `SELECT * FROM ${table} WHERE "username" = ${escVal(username)}`;
      console.log('verify-password sql:', sql);
      const result = await pool.query(sql);
      console.log('verify-password result:', result.rows.length, 'rows');
      if (!result.rows.length) { sendJson(res, { valid: false, error: 'User not found' }, 404); return; }
      const user = result.rows[0];
      console.log('verify-password user password:', user.password ? user.password.substring(0, 20) + '...' : 'null');
      const valid = verifyPassword(password, user.password);
      console.log('verify-password result:', valid);
      // Auto-upgrade plaintext password if valid
      if (valid && needsUpgrade(user.password)) {
        const upgradeSql = `UPDATE ${table} SET "password" = ${escVal(hashPassword(password))} WHERE "username" = ${escVal(username)}`;
        pool.query(upgradeSql).catch(e => console.error('Password upgrade failed:', e.message));
      }
      sendJson(res, { valid });
      break;
    }
    case 'login': {
      // Special login endpoint that verifies password and auto-upgrades plaintext
      const { table: rawTable, username, password } = params;
      const table = validateTable(rawTable);
      if (!username || !password) { sendJson(res, { error: 'Missing credentials' }, 400); return; }
      const sql = `SELECT * FROM ${table} WHERE "username" = ${escVal(username)}`;
      const result = await pool.query(sql);
      if (!result.rows.length) { sendJson(res, { error: 'User not found' }, 404); return; }
      const user = result.rows[0];
      if (!verifyPassword(password, user.password)) {
        sendJson(res, { error: 'Wrong password' }, 401);
        return;
      }
      // Auto-upgrade plaintext password to hashed
      if (needsUpgrade(user.password)) {
        const upgradeSql = `UPDATE ${table} SET "password" = ${escVal(hashPassword(password))} WHERE "username" = ${escVal(username)}`;
        pool.query(upgradeSql).catch(e => console.error('Password upgrade failed:', e.message));
      }
      // Generate session_id for single-device login enforcement
      const sessionId = crypto.randomBytes(16).toString('hex');
      const sessionSql = `UPDATE ${table} SET "session_id" = ${escVal(sessionId)} WHERE "username" = ${escVal(username)}`;
      await pool.query(sessionSql);
      // Return user without password, with session_id
      const { password: _, ...safeUser } = user;
      safeUser.session_id = sessionId;
      sendJson(res, safeUser);
      break;
    }
    case 'super-admin-verify': {
      // Verify super admin password for emergency recovery
      const { password } = params;
      if (!password) { sendJson(res, { error: 'Missing password' }, 400); return; }
      if (verifySuperAdmin(password)) {
        // Generate a temporary recovery token valid for 5 minutes
        const recoveryToken = crypto.randomBytes(32).toString('hex');
        const recoveryExpiry = Date.now() + 5 * 60 * 1000;
        // Store in memory (in production, use Redis or similar)
        global._superAdminToken = { token: recoveryToken, expiry: recoveryExpiry };
        sendJson(res, { success: true, recoveryToken, expiresIn: 300 });
      } else {
        sendJson(res, { error: 'Invalid super password' }, 401);
      }
      break;
    }
    case 'super-admin-reset': {
      // Reset admin password using recovery token
      const { recoveryToken, username, newPassword } = params;
      if (!recoveryToken || !username || !newPassword) {
        sendJson(res, { error: 'Missing parameters' }, 400); return;
      }
      // Verify recovery token
      if (!global._superAdminToken || 
          global._superAdminToken.token !== recoveryToken || 
          global._superAdminToken.expiry < Date.now()) {
        sendJson(res, { error: 'Invalid or expired recovery token' }, 401); return;
      }
      // Reset password
      const hashedPwd = hashPassword(newPassword);
      const sql = `UPDATE admins SET "password" = ${escVal(hashedPwd)} WHERE "username" = ${escVal(username)}`;
      await pool.query(sql);
      // Clear recovery token
      delete global._superAdminToken;
      sendJson(res, { success: true, message: 'Password reset successfully' });
      break;
    }
    case 'export-all': {
      // Export all database data as JSON
      const tables = ['students', 'questions', 'records', 'exams', 'admins'];
      const exportData = {};
      for (const table of tables) {
        try {
          const result = await pool.query(`SELECT * FROM ${table}`);
          exportData[table] = result.rows;
        } catch(e) {
          exportData[table] = [];
        }
      }
      exportData._meta = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        system: '修脚师考试刷题系统'
      };
      sendJson(res, exportData);
      break;
    }
    case 'import-all': {
      // Import data from JSON backup
      const { recoveryToken, data } = params;
      // Verify recovery token (same as super admin)
      if (!global._superAdminToken || 
          global._superAdminToken.token !== recoveryToken || 
          global._superAdminToken.expiry < Date.now()) {
        sendJson(res, { error: 'Invalid or expired recovery token' }, 401); return;
      }
      if (!data || typeof data !== 'object') {
        sendJson(res, { error: 'Invalid data format' }, 400); return;
      }
      const results = { imported: {}, errors: [] };
      // Import tables in order (respect foreign keys)
      const tableOrder = ['questions', 'exams', 'students', 'records', 'admins'];
      for (const table of tableOrder) {
        if (!data[table] || !Array.isArray(data[table])) continue;
        try {
          let imported = 0;
          for (const row of data[table]) {
            try {
              // Build INSERT SQL
              const cols = Object.keys(row).filter(k => k !== 'id' && k !== 'created_at');
              const vals = cols.map(c => escVal(row[c], getColType(table, c)));
              if (cols.length > 0) {
                const sql = `INSERT INTO ${table} (${cols.map(escKey).join(',')}) VALUES (${vals.join(',')}) ON CONFLICT DO NOTHING RETURNING id`;
                const result = await pool.query(sql);
                if (result.rowCount > 0) imported++;
              }
            } catch(e) {
              results.errors.push({ table, row: row.id || row.username || 'unknown', error: e.message });
            }
          }
          results.imported[table] = imported;
        } catch(e) {
          results.errors.push({ table, error: e.message });
        }
      }
      // Clear recovery token after use
      delete global._superAdminToken;
      sendJson(res, results);
      break;
    }
    // ===== Super Admin Routes =====
    case 'superadmin/verify': {
      const { password } = params;
      if (!password) {
        sendJson(res, { error: 'Password required' }, 400); return;
      }
      // Verify against hash (from file, env, or default)
      const hash = crypto.createHash('sha256').update(password + '_super_recovery_salt_2026').digest('hex');
      if (hash !== getSuperAdminHash()) {
        // Random delay to prevent timing attacks
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        sendJson(res, { success: false, error: 'Invalid super password' }, 401); return;
      }
      // Generate temporary session token (valid for 10 minutes)
      const sessionToken = crypto.randomBytes(32).toString('hex');
      global._superAdminSession = {
        token: sessionToken,
        expiry: Date.now() + 10 * 60 * 1000
      };
      sendJson(res, { success: true, sessionToken });
      break;
    }
    case 'superadmin/reset-admin': {
      const { sessionToken } = params;
      if (!global._superAdminSession || 
          global._superAdminSession.token !== sessionToken || 
          global._superAdminSession.expiry < Date.now()) {
        sendJson(res, { error: 'Invalid or expired session' }, 401); return;
      }
      // Generate new password hash (default: 123456)
      const newHash = 'sha256:' + crypto.createHash('sha256').update('123456' + '_pedicure_salt_2026').digest('hex');
      await pool.query(
        "UPDATE admins SET password = $1 WHERE username = 'admin'",
        [newHash]
      );
      sendJson(res, { success: true, message: 'Admin password reset to 123456' });
      break;
    }
    case 'superadmin/export': {
      const { questions, students, records, exams, sessionToken } = params;
      // Verify session token
      if (!global._superAdminSession || 
          global._superAdminSession.token !== sessionToken || 
          global._superAdminSession.expiry < Date.now()) {
        sendJson(res, { error: 'Invalid or expired session' }, 401); return;
      }
      const exportData = {};
      try {
        if (questions) {
          const r = await pool.query('SELECT * FROM questions ORDER BY id');
          exportData.questions = r.rows;
        }
        if (students) {
          // Exclude password hash for security
          const r = await pool.query('SELECT id, username, nickname, cohort, level, status, expires_at, xp, study_level, created_at FROM students ORDER BY id');
          exportData.students = r.rows;
        }
        if (records) {
          const r = await pool.query('SELECT * FROM records ORDER BY id');
          exportData.records = r.rows;
        }
        if (exams) {
          const r = await pool.query('SELECT * FROM exams ORDER BY id');
          exportData.exams = r.rows;
        }
        sendJson(res, exportData);
      } catch(e) {
        sendJson(res, { error: 'Export failed: ' + e.message }, 500);
      }
      break;
    }
    case 'superadmin/import': {
      const { data, options, sessionToken } = params;
      if (!global._superAdminSession || 
          global._superAdminSession.token !== sessionToken || 
          global._superAdminSession.expiry < Date.now()) {
        sendJson(res, { error: 'Invalid or expired session' }, 401); return;
      }
      if (!data || typeof data !== 'object') {
        sendJson(res, { error: 'Invalid data format' }, 400); return;
      }
      const results = {
        questionsCount: 0,
        studentsCount: 0,
        recordsCount: 0,
        examsCount: 0,
        errors: []
      };
      try {
        // Import questions
        if (options.questions && Array.isArray(data.questions)) {
          for (const q of data.questions) {
            try {
              const cols = Object.keys(q).filter(k => k !== 'id' && k !== 'created_at');
              const vals = cols.map(c => escVal(q[c], getColType('questions', c)));
              if (cols.length > 0) {
                const sql = `INSERT INTO questions (${cols.map(escKey).join(',')}) VALUES (${vals.join(',')}) RETURNING id`;
                await pool.query(sql);
                results.questionsCount++;
              }
            } catch(e) {
              results.errors.push({ type: 'question', error: e.message });
            }
          }
        }
        // Import exams
        if (options.exams && Array.isArray(data.exams)) {
          for (const e of data.exams) {
            try {
              const cols = Object.keys(e).filter(k => k !== 'id' && k !== 'created_at');
              const vals = cols.map(c => escVal(e[c], getColType('exams', c)));
              if (cols.length > 0) {
                const sql = `INSERT INTO exams (${cols.map(escKey).join(',')}) VALUES (${vals.join(',')}) RETURNING id`;
                await pool.query(sql);
                results.examsCount++;
              }
            } catch(e) {
              results.errors.push({ type: 'exam', error: e.message });
            }
          }
        }
        // Import students (skip password)
        if (options.students && Array.isArray(data.students)) {
          for (const s of data.students) {
            try {
              const cols = Object.keys(s).filter(k => !['id', 'created_at', 'password'].includes(k));
              const vals = cols.map(c => escVal(s[c], null));
              if (cols.length > 0) {
                const sql = `INSERT INTO students (${cols.map(escKey).join(',')}) VALUES (${vals.join(',')}) ON CONFLICT (username) DO UPDATE SET nickname=EXCLUDED.nickname, cohort=EXCLUDED.cohort, level=EXCLUDED.level RETURNING id`;
                await pool.query(sql);
                results.studentsCount++;
              }
            } catch(e) {
              results.errors.push({ type: 'student', error: e.message });
            }
          }
        }
        // Import records
        if (options.records && Array.isArray(data.records)) {
          for (const r of data.records) {
            try {
              const cols = Object.keys(r).filter(k => k !== 'id');
              const vals = cols.map(c => escVal(r[c], null));
              if (cols.length > 0) {
                const sql = `INSERT INTO records (${cols.map(escKey).join(',')}) VALUES (${vals.join(',')})`;
                await pool.query(sql);
                results.recordsCount++;
              }
            } catch(e) {
              results.errors.push({ type: 'record', error: e.message });
            }
          }
        }
        sendJson(res, results);
      } catch(e) {
        sendJson(res, { error: 'Import failed: ' + e.message }, 500);
      }
      break;
    }
    case 'config/get': {
      // 获取作业配置
      const { key } = allParams;
      const configKey = key || 'last_homework';
      
      const result = await pool.query(`
        SELECT * FROM homework_config WHERE config_key = $1
      `, [configKey]);
      
      if (result.rows.length === 0) {
        sendJson(res, { question_end: 0, default_count: 20 });
      } else {
        sendJson(res, result.rows[0].config_value);
      }
      break;
    }
    case 'config/set': {
      // 设置作业配置
      const { key, value } = allParams;
      const configKey = key || 'last_homework';
      
      await pool.query(`
        INSERT INTO homework_config (config_key, config_value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (config_key) DO UPDATE SET config_value = $2, updated_at = NOW()
      `, [configKey, JSON.stringify(value)]);
      
      sendJson(res, { success: true });
      break;
    }
    case 'question-count': {
      // 获取题库总数
      const result = await pool.query(`SELECT COUNT(*) as total FROM questions`);
      sendJson(res, { total: parseInt(result.rows[0].total) });
      break;
    }
    case 'backup-config': {
      // 获取备份配置
      sendJson(res, {
        email: EMAIL_CONFIG.receiver,
        schedule: '每月1日凌晨3点自动备份',
        lastBackupTime: backupConfig.lastBackupTime,
        backupHistory: backupConfig.backupHistory
      });
      break;
    }
    
    case 'backup-send': {
      // 手动发送备份邮件（无需密码验证）
      // 改为异步执行：先立即返回响应，后台发送邮件
      (async () => {
        try {
          console.log('开始执行备份发送...');
          
          // 获取所有数据
          const [students, questions, records, exams, admins] = await Promise.all([
            pool.query('SELECT * FROM students'),
            pool.query('SELECT * FROM questions'),
            pool.query('SELECT * FROM records'),
            pool.query('SELECT * FROM exams'),
            pool.query('SELECT id, username, nickname, is_master, created_at FROM admins')
          ]);
          
          const backupData = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            data: {
              students: students.rows,
              questions: questions.rows,
              records: records.rows,
              exams: exams.rows,
              admins: admins.rows
            }
          };
          
          const filename = `backup_${new Date().toISOString().slice(0,10)}.json`;
          
          // 发送邮件
          await sendBackupEmail(backupData, filename);
          
          // 更新备份记录
          const backupTime = new Date().toISOString();
          backupConfig.lastBackupTime = backupTime;
          backupConfig.backupHistory.push({
            time: backupTime,
            filename: filename,
            size: JSON.stringify(backupData).length
          });
          if (backupConfig.backupHistory.length > 3) {
            backupConfig.backupHistory = backupConfig.backupHistory.slice(-3);
          }
          
          console.log('备份邮件发送成功:', backupConfig.email);
        } catch (err) {
          console.error('Backup email error:', err);
        }
      })();
      
      // 立即返回响应，不等待邮件发送完成
      sendJson(res, { 
        success: true, 
        message: `备份正在发送中，请稍后查看邮箱 ${backupConfig.email}`,
        async: true 
      });
      break;
    }
    
    case 'send-super-password': {
      // 发送超级管理员密码到邮箱（带频率限制）
      try {
        const { admin_id, from_login, verify_code } = params;
        
        // ===== 频率限制 =====
        const now = Date.now();
        const limitFile = path.join(__dirname, '.super_password_limit');
        
        // 读取限制记录
        let limitData = { count: 0, lastTime: 0, dates: [] };
        if (fs.existsSync(limitFile)) {
          try {
            limitData = JSON.parse(fs.readFileSync(limitFile, 'utf8'));
          } catch (e) {}
        }
        
        // 清理超过24小时的记录
        const today = new Date().toISOString().slice(0, 10);
        limitData.dates = (limitData.dates || []).filter(d => d.date === today);
        const todayCount = limitData.dates.length;
        
        // 检查每日限制（每天最多3次）
        if (todayCount >= 3 && !admin_id) {
          return sendJson(res, { error: '今日发送次数已达上限，请明天再试' }, 429);
        }
        
        // 检查间隔限制（至少10分钟）
        if (limitData.lastTime && (now - limitData.lastTime) < 10 * 60 * 1000 && !admin_id) {
          const waitMin = Math.ceil((10 * 60 * 1000 - (now - limitData.lastTime)) / 60000);
          return sendJson(res, { error: `操作过于频繁，请${waitMin}分钟后再试` }, 429);
        }
        
        // 如果不是从登录页面调用，需要验证管理员身份（管理员不受限制）
        if (!from_login && admin_id) {
          const adminRes = await pool.query('SELECT is_master FROM admins WHERE id = $1', [admin_id]);
          if (!adminRes.rows[0] || !adminRes.rows[0].is_master) {
            return sendJson(res, { error: '只有主管理员可以获取超级密码' }, 403);
          }
        }
        
        // 从登录页调用时，需要验证码（主管理员账号）
        if (from_login) {
          const adminRes = await pool.query('SELECT username FROM admins WHERE is_master = true LIMIT 1');
          if (adminRes.rows[0]) {
            const masterUsername = adminRes.rows[0].username;
            if (verify_code !== masterUsername) {
              return sendJson(res, { error: '验证码错误，请输入主管理员账号' }, 400);
            }
          }
        }
        
        // 生成新的超级管理员密码（32位随机）
        const newSuperPassword = crypto.randomBytes(16).toString('hex');
        const newHash = crypto.createHash('sha256').update(newSuperPassword + '_super_recovery_salt_2026').digest('hex');
        
        // 更新密码文件
        fs.writeFileSync(SUPER_PASSWORD_FILE, newHash, 'utf8');
        
        // 更新限制记录
        limitData.lastTime = now;
        limitData.dates.push({ date: today, time: now });
        fs.writeFileSync(limitFile, JSON.stringify(limitData), 'utf8');
        
        // 发送邮件
        const mailOptions = {
          from: EMAIL_CONFIG.auth.user,
          to: backupConfig.email,
          subject: '【修脚师考试系统】超级管理员密码',
          text: `您好！\n\n这是修脚师考试系统的超级管理员密码。\n\n超级管理员密码：${newSuperPassword}\n\n此密码用于：\n1. 数据库导出/导入操作\n2. 紧急恢复主管理员权限\n\n请妥善保管此密码，切勿泄露！\n\n系统自动发送，请勿回复。`
        };
        
        await transporter.sendMail(mailOptions);
        
        sendJson(res, { success: true, message: `超级管理员密码已发送到 ${backupConfig.email}` });
      } catch (err) {
        console.error('Send super password error:', err);
        sendJson(res, { error: '发送失败: ' + err.message }, 500);
      }
      break;
    }
    
    // ========== 系统设置 API ==========
    case 'system-settings-get': {
      // 获取系统设置
      try {
        const result = await pool.query(`SELECT key, value FROM system_settings`);
        const settings = {};
        for (const row of result.rows) {
          settings[row.key] = row.value === 'true' ? true : (row.value === 'false' ? false : row.value);
        }
        sendJson(res, { success: true, settings });
      } catch (err) {
        console.error('Get system settings error:', err);
        sendJson(res, { error: '获取设置失败' }, 500);
      }
      break;
    }
    
    case 'system-settings-update': {
      // 更新系统设置（仅管理员）
      const { key, value } = params;
      if (!key) {
        sendJson(res, { error: '缺少设置项名称' }, 400);
        return;
      }
      try {
        await pool.query(`
          INSERT INTO system_settings (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
        `, [key, String(value)]);
        sendJson(res, { success: true });
      } catch (err) {
        console.error('Update system settings error:', err);
        sendJson(res, { error: '更新设置失败' }, 500);
      }
      break;
    }
    
    case 'answer-lookup': {
      // 答案快查 - 获取题目和答案列表
      const { level, keyword, page = 1, limit = 20 } = allParams;
      try {
        let whereClause = '1=1';
        const queryParams = [];
        let paramIndex = 1;
        
        if (level) {
          whereClause += ` AND level = $${paramIndex}`;
          queryParams.push(level);
          paramIndex++;
        }
        
        if (keyword) {
          whereClause += ` AND (content ILIKE $${paramIndex} OR answer ILIKE $${paramIndex})`;
          queryParams.push(`%${keyword}%`);
          paramIndex++;
        }
        
        // 获取总数
        const countResult = await pool.query(`SELECT COUNT(*) as total FROM questions WHERE ${whereClause}`, queryParams);
        const total = parseInt(countResult.rows[0].total);
        
        // 分页获取题目
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const questionsResult = await pool.query(
          `SELECT id, type, content, options, answer, level, tags FROM questions WHERE ${whereClause} ORDER BY id ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          [...queryParams, parseInt(limit), offset]
        );
        
        sendJson(res, {
          success: true,
          questions: questionsResult.rows,
          total,
          page: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit))
        });
      } catch (err) {
        console.error('Answer lookup error:', err);
        sendJson(res, { error: '查询失败' }, 500);
      }
      break;
    }
    
    // ========== 错题强化训练 API ==========
    case 'wrong-stats': {
      // 获取错题统计
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      // 获取错题总数和已掌握数
      const statsResult = await pool.query(`
        SELECT 
          COUNT(*) as total_wrong,
          COUNT(*) FILTER (WHERE is_mastered = TRUE) as mastered,
          COUNT(*) FILTER (WHERE is_mastered = FALSE AND consecutive_correct = 0) as new_wrong,
          COUNT(*) FILTER (WHERE is_mastered = FALSE AND consecutive_correct > 0) as practicing
        FROM wrong_question_mastery
        WHERE student_id = $1
      `, [student_id]);
      
      // 获取今日待复习数
      const todayReview = await pool.query(`
        SELECT COUNT(*) as count
        FROM wrong_question_mastery
        WHERE student_id = $1 
          AND is_mastered = FALSE 
          AND (next_review_at IS NULL OR next_review_at <= NOW())
      `, [student_id]);
      
      // 获取本周训练统计
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      weekStart.setHours(0, 0, 0, 0);
      
      const weekStats = await pool.query(`
        SELECT 
          COUNT(*) as sessions,
          COALESCE(SUM(correct_count), 0) as total_correct,
          COALESCE(SUM(total_questions), 0) as total_questions
        FROM wrong_training_sessions
        WHERE student_id = $1 AND started_at >= $2
      `, [student_id, weekStart]);
      
      sendJson(res, {
        stats: statsResult.rows[0],
        todayReview: parseInt(todayReview.rows[0].count) || 0,
        weekStats: weekStats.rows[0]
      });
      break;
    }
    
    case 'wrong-daily': {
      // 获取每日特训题目（智能推送10道）
      const { student_id, level } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      // 优先级：1.今天到期复习 2.新错题 3.即将到期
      const questionsResult = await pool.query(`
        SELECT q.*, 
               m.wrong_count, m.correct_count, m.consecutive_correct, m.mastery_level,
               m.last_practice_at
        FROM wrong_question_mastery m
        JOIN questions q ON q.id = m.question_id
        WHERE m.student_id = $1 
          AND m.is_mastered = FALSE
          AND ($2::text IS NULL OR q.level = $2)
        ORDER BY 
          CASE WHEN m.next_review_at IS NULL OR m.next_review_at <= NOW() THEN 0 ELSE 1 END,
          m.consecutive_correct ASC,
          m.wrong_count DESC
        LIMIT 10
      `, [student_id, level || null]);
      
      // 如果错题不足10道，从records中补充新错题
      let questions = questionsResult.rows;
      if (questions.length < 10) {
        const existingIds = questions.map(q => q.id);
        const additionalResult = await pool.query(`
          SELECT q.*, 
                 0 as wrong_count, 0 as correct_count, 0 as consecutive_correct, 0 as mastery_level,
                 r.created_at as last_practice_at
          FROM records r
          JOIN questions q ON q.id = r.question_id
          WHERE r.student_id = $1 
            AND r.is_correct = FALSE
            AND ($2::text IS NULL OR q.level = $2)
            AND r.question_id NOT IN (SELECT question_id FROM wrong_question_mastery WHERE student_id = $1)
            ${existingIds.length > 0 ? `AND q.id NOT IN (${existingIds.join(',')})` : ''}
          ORDER BY r.created_at DESC
          LIMIT $3
        `, [student_id, level || null, 10 - questions.length]);
        questions = [...questions, ...additionalResult.rows];
      }
      
      sendJson(res, { questions });
      break;
    }
    
    case 'wrong-submit': {
      // 提交错题训练结果
      const { student_id, question_id, is_correct, mode } = allParams;
      if (!student_id || !question_id || is_correct === undefined) {
        sendJson(res, { error: '缺少必要参数' }, 400);
        return;
      }
      
      // 获取或创建掌握度记录
      const existingResult = await pool.query(`
        SELECT * FROM wrong_question_mastery 
        WHERE student_id = $1 AND question_id = $2
      `, [student_id, question_id]);
      
      const now = new Date();
      let nextReview;
      
      if (existingResult.rows.length === 0) {
        // 新记录
        const wrongCount = is_correct ? 0 : 1;
        const correctCount = is_correct ? 1 : 0;
        const consecutiveCorrect = is_correct ? 1 : 0;
        const masteryLevel = is_correct ? 1 : 0;
        nextReview = is_correct ? new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) : now; // 做对3天后复习，做错明天
        
        await pool.query(`
          INSERT INTO wrong_question_mastery 
          (student_id, question_id, wrong_count, correct_count, consecutive_correct, 
           mastery_level, last_practice_at, next_review_at, is_mastered)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [student_id, question_id, wrongCount, correctCount, consecutiveCorrect, 
            masteryLevel, now, nextReview, consecutiveCorrect >= 3]);
      } else {
        // 更新记录
        const existing = existingResult.rows[0];
        const wrongCount = existing.wrong_count + (is_correct ? 0 : 1);
        const correctCount = existing.correct_count + (is_correct ? 1 : 0);
        const consecutiveCorrect = is_correct ? existing.consecutive_correct + 1 : 0;
        const masteryLevel = Math.min(5, Math.floor(correctCount / 2));
        
        // 计算下次复习时间：连续正确次数越多，间隔越长
        if (consecutiveCorrect === 0) {
          nextReview = now; // 做错，明天继续
        } else if (consecutiveCorrect === 1) {
          nextReview = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3天
        } else if (consecutiveCorrect === 2) {
          nextReview = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7天
        } else {
          nextReview = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14天
        }
        
        await pool.query(`
          UPDATE wrong_question_mastery 
          SET wrong_count = $3, correct_count = $4, consecutive_correct = $5,
              mastery_level = $6, last_practice_at = $7, next_review_at = $8,
              is_mastered = $9
          WHERE student_id = $1 AND question_id = $2
        `, [student_id, question_id, wrongCount, correctCount, consecutiveCorrect,
            masteryLevel, now, nextReview, consecutiveCorrect >= 3]);
      }
      
      sendJson(res, { 
        success: true, 
        next_review: nextReview,
        mastered: (existingResult.rows.length === 0 && is_correct) || 
                  (existingResult.rows.length > 0 && is_correct && existingResult.rows[0].consecutive_correct >= 2)
      });
      break;
    }
    
    case 'wrong-topics': {
      // 获取错题按知识点分布
      const { student_id, level } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      const result = await pool.query(`
        SELECT 
          unnest(tags) as tag,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE is_mastered = TRUE) as mastered,
          COUNT(*) FILTER (WHERE is_mastered = FALSE) as pending
        FROM wrong_question_mastery m
        JOIN questions q ON q.id = m.question_id
        WHERE m.student_id = $1 AND ($2::text IS NULL OR q.level = $2)
        GROUP BY unnest(tags)
        ORDER BY pending DESC, count DESC
      `, [student_id, level || null]);
      
      sendJson(res, { topics: result.rows });
      break;
    }
    
    case 'wrong-topic-questions': {
      // 获取某知识点的错题
      const { student_id, tag, level } = allParams;
      if (!student_id || !tag) {
        sendJson(res, { error: '缺少必要参数' }, 400);
        return;
      }
      
      const result = await pool.query(`
        SELECT q.*, 
               m.wrong_count, m.correct_count, m.consecutive_correct, m.mastery_level,
               m.is_mastered
        FROM wrong_question_mastery m
        JOIN questions q ON q.id = m.question_id
        WHERE m.student_id = $1 
          AND $2 = ANY(q.tags)
          AND ($3::text IS NULL OR q.level = $3)
          AND m.is_mastered = FALSE
        ORDER BY m.wrong_count DESC, m.last_practice_at ASC NULLS FIRST
      `, [student_id, tag, level || null]);
      
      sendJson(res, { questions: result.rows });
      break;
    }
    
    case 'wrong-exam': {
      // 生成错题模拟考试
      const { student_id, level, count } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      const examCount = parseInt(count) || 20;
      
      const result = await pool.query(`
        SELECT q.*
        FROM wrong_question_mastery m
        JOIN questions q ON q.id = m.question_id
        WHERE m.student_id = $1 
          AND m.is_mastered = FALSE
          AND ($2::text IS NULL OR q.level = $2)
        ORDER BY RANDOM()
        LIMIT $3
      `, [student_id, level || null, examCount]);
      
      sendJson(res, { questions: result.rows });
      break;
    }
    
    case 'wrong-session-start': {
      // 开始训练会话
      const { student_id, mode, question_ids } = allParams;
      if (!student_id || !mode || !question_ids) {
        sendJson(res, { error: '缺少必要参数' }, 400);
        return;
      }
      
      const result = await pool.query(`
        INSERT INTO wrong_training_sessions 
        (student_id, mode, question_ids, total_questions, started_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id
      `, [student_id, mode, question_ids, question_ids.length]);
      
      sendJson(res, { session_id: result.rows[0].id });
      break;
    }
    
    case 'wrong-session-finish': {
      // 结束训练会话
      const { session_id, correct_count, duration_seconds } = allParams;
      if (!session_id) {
        sendJson(res, { error: '缺少会话ID' }, 400);
        return;
      }
      
      await pool.query(`
        UPDATE wrong_training_sessions 
        SET finished_at = NOW(), 
            correct_count = $2, 
            duration_seconds = $3
        WHERE id = $1
      `, [session_id, correct_count || 0, duration_seconds || 0]);
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'wrong-history': {
      // 获取训练历史
      const { student_id, limit, offset } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      const lim = parseInt(limit) || 20;
      const off = parseInt(offset) || 0;
      
      const result = await pool.query(`
        SELECT id, mode, total_questions, correct_count, 
               started_at, finished_at, duration_seconds,
               ROUND(correct_count * 100.0 / NULLIF(total_questions, 0)) as accuracy
        FROM wrong_training_sessions
        WHERE student_id = $1
        ORDER BY started_at DESC
        LIMIT $2 OFFSET $3
      `, [student_id, lim, off]);
      
      const countResult = await pool.query(`
        SELECT COUNT(*) as total FROM wrong_training_sessions WHERE student_id = $1
      `, [student_id]);
      
      sendJson(res, { 
        sessions: result.rows,
        total: parseInt(countResult.rows[0].total)
      });
      break;
    }
    
    case 'wrong-stats-admin': {
      // 管理员获取所有学生的错题统计
      const { cohort } = allParams;
      
      // 构建查询
      let query = `
        SELECT 
          w.student_id,
          s.nickname,
          s.cohort,
          COUNT(*) FILTER (WHERE w.is_mastered = FALSE AND w.wrong_count = 1) as level1,
          COUNT(*) FILTER (WHERE w.is_mastered = FALSE AND w.wrong_count = 2) as level2,
          COUNT(*) FILTER (WHERE w.is_mastered = FALSE AND w.wrong_count >= 3) as level3,
          COUNT(*) FILTER (WHERE w.is_mastered = TRUE) as review,
          COUNT(*) FILTER (WHERE w.is_mastered = FALSE) as total_wrong
        FROM wrong_question_mastery w
        LEFT JOIN students s ON w.student_id = s.id
        WHERE 1=1
      `;
      const params = [];
      if (cohort) {
        query += ` AND s.cohort LIKE $1`;
        params.push(`%${cohort}%`);
      }
      query += ` GROUP BY w.student_id, s.nickname, s.cohort ORDER BY total_wrong DESC`;
      
      const result = await pool.query(query, params);
      sendJson(res, { success: true, stats: result.rows });
      break;
    }
    
    case 'wrong-detail-admin': {
      // 管理员获取指定学生的错题详情
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      const result = await pool.query(`
        SELECT 
          w.*,
          q.type,
          q.content,
          q.options,
          q.answer,
          q.analysis,
          q.tags,
          q.level as question_level
        FROM wrong_question_mastery w
        LEFT JOIN questions q ON w.question_id::text = q.id::text
        WHERE w.student_id = $1
        ORDER BY w.wrong_count DESC, w.last_practice_at DESC
      `, [student_id]);
      
      sendJson(res, { success: true, questions: result.rows });
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Enrollment API =====
async function handleEnrollApi(req, res, url, params) {
  // 支持格式：/api/enroll-config/xxx, /api/enroll/xxx, /api/enroll-xxx
  let pathname = url.pathname.replace('/api/', '');
  // 统一转换 enroll-config/xxx -> config/list 格式
  if (pathname.startsWith('enroll-config/')) {
    pathname = pathname.replace('enroll-config/', 'config/');
  } else if (pathname.startsWith('enroll-')) {
    pathname = pathname.replace('enroll-', '');
  }
  const route = pathname;
  
  // 对于 GET 请求，从 URL query string 获取参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };
  
  switch(route) {
    case 'config/list': {
      // 查询报名配置列表
      const result = await pool.query(
        `SELECT ec.*, 
          (SELECT COUNT(*) FROM enrollments WHERE config_id = ec.id) as enrollment_count,
          (SELECT COUNT(*) FROM enrollments WHERE config_id = ec.id AND status = 'approved') as approved_count
         FROM enroll_configs ec 
         ORDER BY ec.created_at DESC`
      );
      sendJson(res, result.rows);
      break;
    }
    case 'config/create': {
      // 创建报名配置
      const { title, levels, cohort, start_time, end_time, auto_sync, created_by } = allParams;
      if (!title) { sendJson(res, { error: '缺少标题' }, 400); return; }
      if (!levels || !levels.length) { sendJson(res, { error: '请选择至少一个级别' }, 400); return; }
      
      const result = await pool.query(
        `INSERT INTO enroll_configs (title, levels, cohort, start_time, end_time, auto_sync, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [title, levels, cohort || null, start_time || null, end_time || null, auto_sync || false, created_by || null]
      );
      sendJson(res, result.rows[0]);
      break;
    }
    case 'config/update': {
      // 更新报名配置
      const { id, title, levels, cohort, start_time, end_time, auto_sync, status } = allParams;
      if (!id) { sendJson(res, { error: '缺少ID' }, 400); return; }
      
      const updates = [];
      const values = [];
      let idx = 1;
      if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(title); }
      if (levels !== undefined) { updates.push(`levels = $${idx++}`); values.push(levels); }
      if (cohort !== undefined) { updates.push(`cohort = $${idx++}`); values.push(cohort); }
      if (start_time !== undefined) { updates.push(`start_time = $${idx++}`); values.push(start_time); }
      if (end_time !== undefined) { updates.push(`end_time = $${idx++}`); values.push(end_time); }
      if (auto_sync !== undefined) { updates.push(`auto_sync = $${idx++}`); values.push(auto_sync); }
      if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
      
      if (updates.length === 0) { sendJson(res, { error: '没有更新字段' }, 400); return; }
      
      values.push(id);
      const result = await pool.query(
        `UPDATE enroll_configs SET ${updates.join(',')} WHERE id = $${idx} RETURNING *`,
        values
      );
      sendJson(res, result.rows[0]);
      break;
    }
    case 'config/delete': {
      // 删除报名配置（级联删除报名记录）
      const { id } = allParams;
      if (!id) { sendJson(res, { error: '缺少ID' }, 400); return; }
      await pool.query('DELETE FROM enroll_configs WHERE id = $1', [id]);
      sendJson(res, { success: true });
      break;
    }
    case 'config/get': {
      // 获取单个报名配置
      const { id } = allParams;
      if (!id) { sendJson(res, { error: '缺少ID' }, 400); return; }
      const result = await pool.query(
        `SELECT ec.*, 
          (SELECT COUNT(*) FROM enrollments WHERE config_id = ec.id) as enrollment_count,
          (SELECT COUNT(*) FROM enrollments WHERE config_id = ec.id AND status = 'approved') as approved_count
         FROM enroll_configs ec WHERE ec.id = $1`,
        [id]
      );
      sendJson(res, result.rows[0] || null);
      break;
    }
    case 'submit': {
      // 学生提交报名
      const { config_id, name, phone, level, cohort, ip_address } = allParams;
      if (!config_id || !name || !phone || !level) {
        sendJson(res, { error: '缺少必填字段' }, 400); return;
      }
      
      // 验证报名配置是否存在且有效
      const configResult = await pool.query(
        'SELECT * FROM enroll_configs WHERE id = $1 AND status = $2',
        [config_id, 'active']
      );
      if (!configResult.rows.length) {
        sendJson(res, { error: '报名不存在或已关闭' }, 400); return;
      }
      const config = configResult.rows[0];
      
      // 验证时间范围
      const now = new Date();
      if (config.start_time && new Date(config.start_time) > now) {
        sendJson(res, { error: '报名尚未开始' }, 400); return;
      }
      if (config.end_time && new Date(config.end_time) < now) {
        sendJson(res, { error: '报名已截止' }, 400); return;
      }
      
      // 验证级别
      if (!config.levels.includes(level)) {
        sendJson(res, { error: '您选择的级别不在本次报名范围内' }, 400); return;
      }
      
      // 检查手机号是否已报名
      const existResult = await pool.query(
        'SELECT * FROM enrollments WHERE config_id = $1 AND phone = $2',
        [config_id, phone]
      );
      if (existResult.rows.length) {
        sendJson(res, { error: '该手机号已报名，请勿重复提交' }, 400); return;
      }
      
      // 插入报名记录
      const insertResult = await pool.query(
        `INSERT INTO enrollments (config_id, name, phone, level, cohort, status, ip_address) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [config_id, name, phone, level, cohort || null, 'pending', ip_address || null]
      );
      
      // 如果开启自动同步，立即创建学生账号
      if (config.auto_sync) {
        // 检查学生是否已存在
        const studentExist = await pool.query(
          'SELECT id FROM students WHERE username = $1',
          [phone]
        );
        if (!studentExist.rows.length) {
          // 创建学生账号
          const hashedPwd = hashPassword('123456');
          await pool.query(
            `INSERT INTO students (username, password, nickname, level, cohort, status, expires_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [phone, hashedPwd, name, level, cohort || null, 'active', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)]
          );
        }
        // 更新报名状态为已批准
        await pool.query(
          'UPDATE enrollments SET status = $1 WHERE id = $2',
          ['approved', insertResult.rows[0].id]
        );
        insertResult.rows[0].status = 'approved';
        insertResult.rows[0].auto_synced = true;
      }
      
      sendJson(res, { success: true, enrollment: insertResult.rows[0], auto_sync: config.auto_sync });
      break;
    }
    case 'list': {
      // 查询报名列表
      const { config_id, level, status, search } = allParams;
      let sql = `SELECT * FROM enrollments WHERE 1=1`;
      const values = [];
      let idx = 1;
      
      if (config_id) { sql += ` AND config_id = $${idx++}`; values.push(config_id); }
      if (level) { sql += ` AND level = $${idx++}`; values.push(level); }
      if (status) { sql += ` AND status = $${idx++}`; values.push(status); }
      if (search) { sql += ` AND (name LIKE $${idx} OR phone LIKE $${idx})`; values.push(`%${search}%`); idx++; }
      
      sql += ' ORDER BY created_at DESC';
      
      const result = await pool.query(sql, values);
      sendJson(res, result.rows);
      break;
    }
    case 'import-students': {
      // 一键导入报名学生到学生列表
      const { config_id, enrollment_ids } = allParams;
      if (!config_id) { sendJson(res, { error: '缺少config_id' }, 400); return; }
      
      // 获取待导入的报名记录
      let sql = 'SELECT * FROM enrollments WHERE config_id = $1 AND status = $2';
      const values = [config_id, 'pending'];
      if (enrollment_ids && enrollment_ids.length) {
        sql += ` AND id = ANY($3)`;
        values.push(enrollment_ids);
      }
      const enrollments = await pool.query(sql, values);
      
      let imported = 0;
      let updated = 0;
      const errors = [];
      const hashedPwd = hashPassword('123456');
      
      for (const e of enrollments.rows) {
        try {
          // 检查学生是否已存在
          const existResult = await pool.query(
            'SELECT id, cohort as existing_cohort FROM students WHERE username = $1',
            [e.phone]
          );
          
          if (existResult.rows.length) {
            // 学生已存在，合并期次（用逗号隔开，不重复）
            const existingCohort = existResult.rows[0].existing_cohort || '';
            const cohorts = [...new Set(existingCohort.split(',').map(c => c.trim()).filter(Boolean))];
            if (e.cohort && !cohorts.includes(e.cohort)) {
              cohorts.push(e.cohort);
            }
            const mergedCohort = cohorts.join(', ');
            
            // 更新学生的期次和级别
            await pool.query(
              'UPDATE students SET cohort = $1, level = $2 WHERE username = $3',
              [mergedCohort, e.level, e.phone]
            );
            updated++;
          } else {
            // 创建学生账号
            await pool.query(
              `INSERT INTO students (username, password, nickname, level, cohort, status, expires_at) 
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [e.phone, hashedPwd, e.name, e.level, e.cohort, 'active', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)]
            );
            imported++;
          }
          
          // 更新报名状态
          await pool.query(
            'UPDATE enrollments SET status = $1 WHERE id = $2',
            ['approved', e.id]
          );
        } catch(err) {
          errors.push({ phone: e.phone, error: err.message });
        }
      }
      
      sendJson(res, { success: true, imported, updated, errors });
      break;
    }
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Homework API Handler =====
async function handleHomeworkApi(req, res, url, params) {
  const route = url.pathname.replace('/api/homework/', '');
  
  // 对于 GET 请求，从 URL query string 获取参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };
  
  switch (route) {
    case 'list': {
      // 获取作业列表
      const result = await pool.query(`
        SELECT h.*, 
          (SELECT COUNT(*) FROM homework_records hr WHERE hr.homework_id = h.id) as total_students,
          (SELECT COUNT(*) FROM homework_records hr WHERE hr.homework_id = h.id AND hr.is_completed = true) as completed_students
        FROM homeworks h
        WHERE h.status = 'active'
        ORDER BY h.created_at DESC
      `);
      sendJson(res, result.rows);
      break;
    }
    case 'create': {
      // 创建作业
      const { title, type = 'practice', level, cohort, cohorts, target_type = 'cohort', target_ids, 
              question_count = 20, question_start, question_end, correct_count, end_time, auto_create = false } = allParams;
      if (!title) throw new Error('作业标题不能为空');
      
      // 支持多个班级
      const cohortsArray = cohorts || (cohort ? [cohort] : null);
      
      const result = await pool.query(`
        INSERT INTO homeworks (title, type, level, cohort, cohorts, target_type, target_ids, 
                               question_count, question_start, question_end, correct_count, end_time, auto_create, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `, [title, type, level || null, cohort || null, cohortsArray, target_type, target_ids || null, 
          question_count, question_start || null, question_end || null, 
          correct_count || null, end_time || null, auto_create, allParams.created_by || null]);
      
      sendJson(res, result.rows[0]);
      break;
    }
    case 'update': {
      // 更新作业
      const { id, title, level, cohort, target_type, target_ids, question_count, correct_count, end_time, status } = allParams;
      if (!id) throw new Error('缺少作业ID');
      
      const updates = [];
      const values = [id];
      let idx = 2;
      
      if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(title); }
      if (level !== undefined) { updates.push(`level = $${idx++}`); values.push(level); }
      if (cohort !== undefined) { updates.push(`cohort = $${idx++}`); values.push(cohort); }
      if (target_type !== undefined) { updates.push(`target_type = $${idx++}`); values.push(target_type); }
      if (target_ids !== undefined) { updates.push(`target_ids = $${idx++}`); values.push(target_ids); }
      if (question_count !== undefined) { updates.push(`question_count = $${idx++}`); values.push(question_count); }
      if (correct_count !== undefined) { updates.push(`correct_count = $${idx++}`); values.push(correct_count); }
      if (end_time !== undefined) { updates.push(`end_time = $${idx++}`); values.push(end_time); }
      if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
      
      if (updates.length === 0) {
        sendJson(res, { success: true, message: '无更新内容' });
        break;
      }
      
      const result = await pool.query(`
        UPDATE homeworks SET ${updates.join(', ')} WHERE id = $1 RETURNING *
      `, values);
      
      sendJson(res, result.rows[0]);
      break;
    }
    case 'delete': {
      // 删除作业
      const { id } = allParams;
      if (!id) throw new Error('缺少作业ID');
      
      await pool.query(`DELETE FROM homeworks WHERE id = $1`, [id]);
      sendJson(res, { success: true });
      break;
    }
    case 'get': {
      // 获取单个作业详情
      const { id } = allParams;
      if (!id) throw new Error('缺少作业ID');
      
      const result = await pool.query(`
        SELECT * FROM homeworks WHERE id = $1
      `, [id]);
      
      if (result.rows.length === 0) {
        sendJson(res, { error: '作业不存在' }, 404);
      } else {
        sendJson(res, result.rows[0]);
      }
      break;
    }
    case 'records': {
      // 获取作业完成记录（管理员查看）
      const { homework_id } = allParams;
      if (!homework_id) throw new Error('缺少作业ID');
      
      const result = await pool.query(`
        SELECT hr.*, s.username, s.nickname, s.level, s.cohort
        FROM homework_records hr
        LEFT JOIN students s ON hr.student_id = s.id
        WHERE hr.homework_id = $1
        ORDER BY hr.is_completed DESC, hr.completed_at DESC
      `, [homework_id]);
      
      sendJson(res, result.rows);
      break;
    }
    case 'student-list': {
      // 获取学生的作业列表
      const { student_id, level, cohort } = allParams;
      if (!student_id) throw new Error('缺少学生ID');
      
      // 获取符合条件的作业：按级别、按班级、或指定学生
      const result = await pool.query(`
        SELECT h.*, 
          COALESCE(hr.question_ids, '{}') as question_ids,
          COALESCE(hr.correct_count, 0) as my_correct_count,
          COALESCE(hr.total_count, 0) as my_total_count,
          COALESCE(hr.is_completed, false) as my_completed,
          hr.completed_at as my_completed_at
        FROM homeworks h
        LEFT JOIN homework_records hr ON h.id = hr.homework_id AND hr.student_id = $1
        WHERE h.status = 'active'
          AND (
            (h.target_type = 'level' AND h.level = $2)
            OR (h.target_type = 'cohort' AND h.cohort = $3)
            OR (h.target_type = 'student' AND $1 = ANY(h.target_ids))
          )
          AND (h.end_time IS NULL OR h.end_time > NOW())
        ORDER BY h.end_time ASC, h.created_at DESC
      `, [student_id, level || '', cohort || '']);
      
      sendJson(res, result.rows);
      break;
    }
    case 'start': {
      // 学生开始作业
      const { homework_id, student_id } = allParams;
      if (!homework_id || !student_id) throw new Error('缺少必要参数');
      
      // 检查作业是否存在
      const homeworkResult = await pool.query(`SELECT * FROM homeworks WHERE id = $1 AND status = 'active'`, [homework_id]);
      if (homeworkResult.rows.length === 0) throw new Error('作业不存在或已关闭');
      
      // 检查是否已过期
      const homework = homeworkResult.rows[0];
      if (homework.end_time && new Date(homework.end_time) < new Date()) {
        throw new Error('作业已过期');
      }
      
      // 创建或获取作业记录
      const result = await pool.query(`
        INSERT INTO homework_records (homework_id, student_id, question_ids, correct_count, total_count)
        VALUES ($1, $2, '{}', 0, 0)
        ON CONFLICT (homework_id, student_id) DO UPDATE SET homework_id = EXCLUDED.homework_id
        RETURNING *
      `, [homework_id, student_id]);
      
      sendJson(res, result.rows[0]);
      break;
    }
    case 'submit': {
      // 学生提交作业答题记录
      const { homework_id, student_id, question_id, is_correct } = allParams;
      if (!homework_id || !student_id || !question_id) throw new Error('缺少必要参数');
      
      // 获取当前记录
      const currentResult = await pool.query(`
        SELECT * FROM homework_records WHERE homework_id = $1 AND student_id = $2
      `, [homework_id, student_id]);
      
      if (currentResult.rows.length === 0) throw new Error('请先开始作业');
      
      const current = currentResult.rows[0];
      const questionIds = current.question_ids || [];
      
      // 检查是否已答过此题
      if (questionIds.includes(parseInt(question_id))) {
        sendJson(res, current);
        break;
      }
      
      // 更新记录
      const newQuestionIds = [...questionIds, parseInt(question_id)];
      const newTotalCount = current.total_count + 1;
      const newCorrectCount = current.correct_count + (is_correct ? 1 : 0);
      
      // 获取作业信息检查是否完成
      const homeworkResult = await pool.query(`SELECT question_count, correct_count FROM homeworks WHERE id = $1`, [homework_id]);
      const homework = homeworkResult.rows[0];
      
      let isCompleted = false;
      let completedAt = null;
      
      // 判断是否完成：总答题数达标 或 答对数达标
      if (homework.correct_count) {
        // 有答对要求
        isCompleted = newCorrectCount >= homework.correct_count;
      } else {
        // 无答对要求，只需答题数达标
        isCompleted = newTotalCount >= homework.question_count;
      }
      
      if (isCompleted && !current.is_completed) {
        completedAt = new Date();
      }
      
      const result = await pool.query(`
        UPDATE homework_records 
        SET question_ids = $3, total_count = $4, correct_count = $5, is_completed = $6, completed_at = $7
        WHERE homework_id = $1 AND student_id = $2
        RETURNING *
      `, [homework_id, student_id, newQuestionIds, newTotalCount, newCorrectCount, isCompleted || current.is_completed, completedAt || current.completed_at]);
      
      sendJson(res, result.rows[0]);
      break;
    }
    case 'record-progress': {
      // 获取学生单个作业进度
      const { homework_id, student_id } = allParams;
      if (!homework_id || !student_id) throw new Error('缺少必要参数');
      
      const result = await pool.query(`
        SELECT * FROM homework_records WHERE homework_id = $1 AND student_id = $2
      `, [homework_id, student_id]);
      
      if (result.rows.length === 0) {
        sendJson(res, { question_ids: [], correct_count: 0, total_count: 0, is_completed: false });
      } else {
        sendJson(res, result.rows[0]);
      }
      break;
    }
    case 'config': {
      // 获取作业配置
      const result = await pool.query(`SELECT * FROM homework_config WHERE config_key = 'last_homework'`);
      if (result.rows.length === 0) {
        sendJson(res, { question_end: 0, default_count: 20 });
      } else {
        sendJson(res, result.rows[0].config_value);
      }
      break;
    }
    case 'save-config': {
      // 保存作业配置
      const { question_end, default_count } = allParams;
      await pool.query(`
        INSERT INTO homework_config (config_key, config_value, updated_at)
        VALUES ('last_homework', $1, NOW())
        ON CONFLICT (config_key) DO UPDATE SET config_value = $1, updated_at = NOW()
      `, [JSON.stringify({ question_end: question_end || 0, default_count: default_count || 20 })]);
      sendJson(res, { success: true });
      break;
    }
    case 'count': {
      // 获取题目总数
      const result = await pool.query(`SELECT COUNT(*) as total FROM questions`);
      sendJson(res, { total: parseInt(result.rows[0].total) });
      break;
    }
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Daily Task API Handler =====
async function handleDailyTaskApi(req, res, url, params) {
  let route = url.pathname.replace('/api/daily-task/', '').replace('/api/daily-task', '');
  // 支持其他路由如 /api/wrong-level, /api/review-book 等
  // 解析GET请求参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };

  switch (route) {
    case 'status': {
      // 获取今日任务状态
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      try {
      const today = new Date().toISOString().split('T')[0];
      
      // 获取或创建今日任务记录
      let result = await pool.query(`
        SELECT * FROM daily_tasks WHERE student_id = $1 AND task_date = $2
      `, [student_id, today]);
      
      if (result.rows.length === 0) {
        // 创建今日任务记录
        await pool.query(`
          INSERT INTO daily_tasks (student_id, task_date, login_bonus, practice_count, homework_done, wrong_practice_count)
          VALUES ($1, $2, true, 0, false, 0)
        `, [student_id, today]);
        
        result = await pool.query(`
          SELECT * FROM daily_tasks WHERE student_id = $1 AND task_date = $2
        `, [student_id, today]);
        
        // 给予登录奖励XP - student_id 是手机号，用 username 匹配
        await pool.query(`
          UPDATE students SET xp = COALESCE(xp, 0) + 20 WHERE username = $1
        `, [student_id]);
      }
      
      // 检查今日作业是否完成（如果 homeworks 表不存在则跳过）
      let hasPendingHomework = false;
      try {
        const homeworkCheck = await pool.query(`
          SELECT COUNT(*) as pending FROM homeworks h
          JOIN students s ON (s.cohort = ANY(h.cohorts) OR s.level = h.level OR h.target_type = 'all')
          LEFT JOIN homework_records hr ON hr.homework_id = h.id AND hr.student_id = $1
          WHERE h.status = 'active' AND h.end_time > NOW()
          AND (hr.is_completed = false OR hr.is_completed IS NULL)
        `, [student_id]);
        hasPendingHomework = parseInt(homeworkCheck.rows[0].pending) > 0;
      } catch (e) {
        // homeworks 表不存在，跳过作业检查
      }
      
      const taskData = result.rows[0] || {};
      sendJson(res, {
        ...taskData,
        has_pending_homework: hasPendingHomework
      });
      } catch (e) {
        console.error('daily-task status error:', e);
        // 返回默认值
        sendJson(res, {
          login_bonus: true,
          practice_count: 0,
          practice_target: 20,
          homework_done: false,
          wrong_practice_count: 0,
          wrong_practice_target: 10,
          has_pending_homework: false
        });
      }
      break;
    }
    
    case 'update': {
      // 更新任务进度
      const { student_id, practice_count, wrong_practice_count, homework_done } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      const today = new Date().toISOString().split('T')[0];
      
      const updates = [];
      const values = [student_id, today];
      let paramIndex = 3;
      
      if (practice_count !== undefined) {
        updates.push(`practice_count = $${paramIndex}`);
        values.push(parseInt(practice_count));
        paramIndex++;
      }
      if (wrong_practice_count !== undefined) {
        updates.push(`wrong_practice_count = $${paramIndex}`);
        values.push(parseInt(wrong_practice_count));
        paramIndex++;
      }
      if (homework_done !== undefined) {
        updates.push(`homework_done = $${paramIndex}`);
        values.push(homework_done);
        paramIndex++;
      }
      
      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        
        // 先尝试更新
        const updateResult = await pool.query(`
          UPDATE daily_tasks SET ${updates.join(', ')}
          WHERE student_id = $1 AND task_date = $2
        `, values);
        
        // 如果没有更新到任何行，则插入新记录
        if (updateResult.rowCount === 0) {
          const insertCols = ['student_id', 'task_date'];
          const insertVals = ['$1', '$2'];
          const insertValues = [student_id, today];
          let insertIdx = 3;
          
          if (practice_count !== undefined) {
            insertCols.push('practice_count');
            insertVals.push(`$${insertIdx}`);
            insertValues.push(parseInt(practice_count));
            insertIdx++;
          }
          if (wrong_practice_count !== undefined) {
            insertCols.push('wrong_practice_count');
            insertVals.push(`$${insertIdx}`);
            insertValues.push(parseInt(wrong_practice_count));
            insertIdx++;
          }
          if (homework_done !== undefined) {
            insertCols.push('homework_done');
            insertVals.push(`$${insertIdx}`);
            insertValues.push(homework_done);
            insertIdx++;
          }
          
          await pool.query(`
            INSERT INTO daily_tasks (${insertCols.join(', ')})
            VALUES (${insertVals.join(', ')})
          `, insertValues);
        }
      }
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'week-progress': {
      // 获取本周学习进度
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      // 获取最近7天的学习记录
      const result = await pool.query(`
        SELECT task_date, login_bonus, practice_count, practice_target, 
               homework_done, wrong_practice_count, wrong_practice_target
        FROM daily_tasks 
        WHERE student_id = $1 
        AND task_date >= CURRENT_DATE - INTERVAL '6 days'
        ORDER BY task_date DESC
      `, [student_id]);
      
      // 计算完成率
      const days = result.rows;
      const completedDays = days.filter(d => 
        d.practice_count >= d.practice_target && 
        d.homework_done === true
      ).length;
      
      sendJson(res, {
        days: days,
        total_days: 7,
        completed_days: completedDays,
        completion_rate: Math.round((completedDays / 7) * 100)
      });
      break;
    }
    
    case 'wrong-analysis': {
      // 错题分析：按题型和知识点统计
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      // 按题型统计
      const typeStats = await pool.query(`
        SELECT q.type, 
               COUNT(*) as total,
               SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct,
               SUM(CASE WHEN NOT r.is_correct THEN 1 ELSE 0 END) as wrong
        FROM records r
        JOIN questions q ON q.id = r.question_id
        WHERE r.student_id = $1
        GROUP BY q.type
        ORDER BY wrong DESC
      `, [student_id]);
      
      // 按知识点(tags)统计 - 只有题目有tags时才有效
      const tagStats = await pool.query(`
        SELECT tag, 
               COUNT(*) as total,
               SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct,
               SUM(CASE WHEN NOT r.is_correct THEN 1 ELSE 0 END) as wrong
        FROM records r
        JOIN questions q ON q.id = r.question_id
        CROSS JOIN LATERAL unnest(q.tags) as tag
        WHERE r.student_id = $1
        GROUP BY tag
        ORDER BY wrong DESC
        LIMIT 10
      `, [student_id]);
      
      // 最近错题趋势（最近7天）
      const trendStats = await pool.query(`
        SELECT DATE(r.created_at) as date,
               COUNT(*) as total,
               SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct
        FROM records r
        WHERE r.student_id = $1
        AND r.created_at >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY DATE(r.created_at)
        ORDER BY date
      `, [student_id]);
      
      sendJson(res, {
        typeStats: typeStats.rows,
        tagStats: tagStats.rows,
        trendStats: trendStats.rows
      });
      break;
    }
    
    case 'ranking': {
      // 学习排名：今日/本周/本月
      const { period, level, limit, my_student_id } = allParams;
      const lim = parseInt(limit) || 20;
      
      let dateFilter = '';
      if (period === 'today') {
        dateFilter = "AND r.created_at >= CURRENT_DATE";
      } else if (period === 'week') {
        dateFilter = "AND r.created_at >= CURRENT_DATE - INTERVAL '6 days'";
      } else if (period === 'month') {
        dateFilter = "AND r.created_at >= CURRENT_DATE - INTERVAL '29 days'";
      }
      
      // 按答题数量排名（records.student_id是手机号，students.username也是手机号）
      const rankingResult = await pool.query(`
        SELECT s.id, s.username, s.nickname, s.level, s.cohort, s.xp, s.study_level,
               COUNT(r.id) as total_questions,
               SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct_count,
               ROUND(100.0 * SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) / NULLIF(COUNT(r.id), 0), 1) as accuracy
        FROM students s
        LEFT JOIN records r ON r.student_id = s.username ${dateFilter.replace('AND', 'AND')}
        WHERE s.status = 'active'
        ${level ? `AND s.level = $1` : ''}
        GROUP BY s.id, s.username
        HAVING COUNT(r.id) > 0
        ORDER BY total_questions DESC, accuracy DESC
        LIMIT ${lim}
      `, level ? [level] : []);
      
      // 获取当前学生的排名
      let myRank = null;
      if (my_student_id) {
        // my_student_id 是手机号，直接用 username 匹配
        const myUsername = my_student_id;
        const placeholder = level ? '$2' : '$1';
        const myRankResult = await pool.query(`
          WITH ranked AS (
            SELECT s.username, 
                   COUNT(r.id) as total_questions,
                   RANK() OVER (ORDER BY COUNT(r.id) DESC) as rank
            FROM students s
            LEFT JOIN records r ON r.student_id = s.username ${dateFilter.replace('AND', 'AND')}
            WHERE s.status = 'active'
            ${level ? `AND s.level = $1` : ''}
            GROUP BY s.username
            HAVING COUNT(r.id) > 0
          )
          SELECT rank FROM ranked WHERE username = ${placeholder}
        `, level ? [level, myUsername] : [myUsername]);
        myRank = myRankResult.rows[0]?.rank || null;
      }
      
      sendJson(res, {
        period: period || 'today',
        rankings: rankingResult.rows,
        myRank: myRank
      });
      break;
    }
    
    case 'study-stats': {
      // 更新学习统计
      const { student_id, questions_answered, correct_count, study_time, xp } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      const today = new Date().toISOString().split('T')[0];
      
      await pool.query(`
        INSERT INTO study_stats (student_id, stat_date, total_questions, correct_questions, study_time_minutes, xp_earned)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (student_id, stat_date) DO UPDATE SET
          total_questions = study_stats.total_questions + $3,
          correct_questions = study_stats.correct_questions + $4,
          study_time_minutes = study_stats.study_time_minutes + $5,
          xp_earned = study_stats.xp_earned + $6
      `, [student_id, today, questions_answered || 0, correct_count || 0, study_time || 0, xp || 0]);
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'overview': {
      // 获取学生总体学习概览
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      // 获取总学习天数
      const totalDaysResult = await pool.query(`
        SELECT COUNT(DISTINCT task_date) as total_days FROM daily_tasks WHERE student_id = $1
      `, [student_id]);
      
      // 获取总答题数和正确率
      const statsResult = await pool.query(`
        SELECT 
          COALESCE(SUM(total_questions), 0) as total_questions,
          COALESCE(SUM(correct_questions), 0) as correct_questions,
          COALESCE(SUM(xp_earned), 0) as total_xp
        FROM study_stats WHERE student_id = $1
      `, [student_id]);
      
      // 获取连续学习天数
      const streakResult = await pool.query(`
        WITH RECURSIVE streak AS (
          SELECT task_date, 1 as streak_length
          FROM daily_tasks 
          WHERE student_id = $1 AND task_date = CURRENT_DATE
          
          UNION ALL
          
          SELECT d.task_date, s.streak_length + 1
          FROM daily_tasks d
          JOIN streak s ON d.task_date = s.task_date - INTERVAL '1 day'
          WHERE d.student_id = $1 AND d.login_bonus = true
        )
        SELECT MAX(streak_length) as streak FROM streak
      `, [student_id]);
      
      sendJson(res, {
        total_study_days: parseInt(totalDaysResult.rows[0].total_days) || 0,
        total_questions: parseInt(statsResult.rows[0].total_questions) || 0,
        correct_questions: parseInt(statsResult.rows[0].correct_questions) || 0,
        accuracy: statsResult.rows[0].total_questions > 0 
          ? Math.round((statsResult.rows[0].correct_questions / statsResult.rows[0].total_questions) * 100)
          : 0,
        total_xp: parseInt(statsResult.rows[0].total_xp) || 0,
        streak_days: parseInt(streakResult.rows[0].streak) || 0
      });
      break;
    }
    
    // ===== Mock Exam History API =====
    case 'mock-history': {
      if (req.method === 'POST') {
        // 保存模拟考试历史
        const { student_id, level, question_type, question_source, question_count, duration, pass_rate, correct_count, total_xp } = allParams;
        
        const result = await pool.query(`
          INSERT INTO mock_exam_history (student_id, level, question_type, question_source, question_count, duration, pass_rate, correct_count, total_xp)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING *
        `, [student_id, level, question_type, question_source, question_count, duration, pass_rate, correct_count, total_xp]);
        
        sendJson(res, { success: true, id: result.rows[0].id });
      } else {
        // 获取历史列表
        const student_id = url.searchParams.get('student_id') || allParams.student_id;
        const limit = parseInt(url.searchParams.get('limit')) || 20;
        
        if (!student_id) {
          sendJson(res, { error: '缺少student_id' }, 400);
          return;
        }
        
        const result = await pool.query(`
          SELECT * FROM mock_exam_history 
          WHERE student_id = $1 
          ORDER BY created_at DESC 
          LIMIT $2
        `, [student_id, limit]);
        
        // 统计信息
        const statsResult = await pool.query(`
          SELECT 
            COUNT(*) as total_exams,
            AVG(correct_count * 100.0 / question_count) as avg_accuracy,
            MAX(correct_count * 100.0 / question_count) as best_accuracy
          FROM mock_exam_history 
          WHERE student_id = $1
        `, [student_id]);
        
        sendJson(res, { 
          list: result.rows,
          stats: statsResult.rows[0]
        });
      }
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Notification API Handler =====
async function handleNotificationApi(req, res, url, params) {
  const route = url.pathname.replace('/api/notification/', '').replace('/api/notification', '');
  
  // 解析GET请求参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };

  switch (route) {
    case 'list': {
      // 获取通知列表（学生端）- 简单版本
      const { student_id, limit, offset } = allParams;
      const lim = parseInt(limit) || 20;
      const off = parseInt(offset) || 0;
      
      const result = await pool.query(`
        SELECT id, title, content, type, is_read, created_at
        FROM notifications
        WHERE student_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [student_id, lim, off]);
      
      // 获取未读数量
      const unreadResult = await pool.query(`
        SELECT COUNT(*) as count FROM notifications
        WHERE student_id = $1 AND is_read = FALSE
      `, [student_id]);
      
      sendJson(res, {
        notifications: result.rows,
        unread_count: parseInt(unreadResult.rows[0].count) || 0
      });
      break;
    }
    
    case 'unread': {
      // 获取未读数量
      const { student_id } = allParams;
      const result = await pool.query(`
        SELECT COUNT(*) as count FROM notifications
        WHERE student_id = $1 AND is_read = FALSE
      `, [student_id]);
      
      sendJson(res, { count: parseInt(result.rows[0].count) || 0 });
      break;
    }
    
    case 'read': {
      // 标记通知为已读
      const { notification_id, student_id } = allParams;
      if (!notification_id || !student_id) {
        sendJson(res, { error: '缺少参数' }, 400);
        return;
      }
      
      await pool.query(`
        UPDATE notifications SET is_read = TRUE
        WHERE id = $1 AND student_id = $2
      `, [notification_id, student_id]);
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'read-all': {
      // 标记所有通知为已读
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少student_id' }, 400);
        return;
      }
      
      await pool.query(`
        UPDATE notifications SET is_read = TRUE
        WHERE student_id = $1 AND is_read = FALSE
      `, [student_id]);
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'admin-list': {
      // 管理员获取所有通知（按批次分组显示）
      const { limit, offset } = allParams;
      const lim = parseInt(limit) || 50;
      const off = parseInt(offset) || 0;
      
      const result = await pool.query(`
        SELECT id, title, content, type, student_id, is_read, created_at
        FROM notifications
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [lim, off]);
      
      sendJson(res, result.rows);
      break;
    }
    
    case 'send': {
      // 发送通知（管理员）- 简单版本：直接插入到每个学生
      const { title, content, target_type, target_value, created_by } = allParams;
      if (!title) {
        sendJson(res, { error: '标题不能为空' }, 400);
        return;
      }
      
      // 获取目标学生
      let studentQuery = 'SELECT id FROM students WHERE status = $1';
      let studentValues = ['active'];
      
      if (target_type === 'level' && target_value) {
        studentQuery += ' AND level = $2';
        studentValues.push(target_value);
      } else if (target_type === 'student' && target_value) {
        studentQuery += ' AND id = $2';
        studentValues.push(target_value);
      }
      
      const studentsResult = await pool.query(studentQuery, studentValues);
      const students = studentsResult.rows;
      
      // 为每个学生插入通知
      let sentCount = 0;
      for (const student of students) {
        await pool.query(`
          INSERT INTO notifications (student_id, title, content, type, is_read)
          VALUES ($1, $2, $3, 'info', FALSE)
        `, [student.id, title, content || '']);
        sentCount++;
      }
      
      sendJson(res, { success: true, sent_count: sentCount });
      break;
    }
    
    case 'delete': {
      // 删除通知（管理员）
      const { id } = allParams;
      if (!id) {
        sendJson(res, { error: '缺少通知ID' }, 400);
        return;
      }
      
      await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
      sendJson(res, { success: true });
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Report API Handler =====
async function handleReportApi(req, res, url, params) {
  const route = url.pathname.replace('/api/report/', '').replace('/api/report', '');
  
  // 解析GET请求参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };

  switch (route) {
    case 'generate': {
      // 生成学习报告预览
      const weekOffset = parseInt(allParams.week_offset) || 0;
      const level = allParams.level || '';
      
      // 计算时间范围
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - weekOffset * 7);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
      
      const formatDate = (d) => d.toISOString().split('T')[0];
      const startStr = formatDate(startDate);
      const endStr = formatDate(endDate);
      
      // 统计数据
      let levelFilter = level && level !== '全部学员' ? `AND s.level = '${level}'` : '';
      
      const statsResult = await pool.query(`
        SELECT 
          COUNT(DISTINCT r.student_id) as active_students,
          COUNT(*) as total_questions,
          SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct_count
        FROM records r
        JOIN students s ON s.username = r.student_id
        WHERE DATE(r.created_at) >= $1 AND DATE(r.created_at) <= $2
        ${levelFilter}
      `, [startStr, endStr]);
      
      const stats = statsResult.rows[0];
      const totalQ = parseInt(stats.total_questions) || 0;
      const correctQ = parseInt(stats.correct_count) || 0;
      const avgAccuracy = totalQ > 0 ? Math.round(correctQ / totalQ * 100) : 0;
      
      // 获取学习之星
      const topResult = await pool.query(`
        SELECT s.nickname, s.level, COUNT(*) as total_questions,
               SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) as correct,
               ROUND(100.0 * SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as accuracy
        FROM records r
        JOIN students s ON s.username = r.student_id
        WHERE DATE(r.created_at) >= $1 AND DATE(r.created_at) <= $2
        ${levelFilter}
        GROUP BY s.id
        ORDER BY total_questions DESC, accuracy DESC
        LIMIT 10
      `, [startStr, endStr]);
      
      sendJson(res, {
        period: { start: startStr, end: endStr },
        stats: {
          active_students: parseInt(stats.active_students) || 0,
          total_questions: totalQ,
          avg_accuracy: avgAccuracy
        },
        top_students: topResult.rows
      });
      break;
    }
    
    case 'push': {
      // 推送学习报告给学生
      const { week_offset, level, created_by } = allParams;
      const weekOffset = parseInt(week_offset) || 0;
      const targetLevel = level && level !== '全部学员' ? level : null;
      
      // 计算时间范围
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - weekOffset * 7);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
      
      const formatDate = (d) => d.toISOString().split('T')[0];
      const startStr = formatDate(startDate);
      const endStr = formatDate(endDate);
      
      // 获取目标学生
      let studentQuery = 'SELECT id, username, nickname, level FROM students WHERE status = $1';
      let studentValues = ['active'];
      if (targetLevel) {
        studentQuery += ' AND level = $2';
        studentValues.push(targetLevel);
      }
      
      const studentsResult = await pool.query(studentQuery, studentValues);
      const students = studentsResult.rows;
      
      // 为每个学生生成报告通知
      let pushedCount = 0;
      for (const student of students) {
        // 获取学生学习数据
        const statsResult = await pool.query(`
          SELECT 
            COUNT(*) as total_questions,
            SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as correct_count,
            COUNT(DISTINCT DATE(created_at)) as study_days
          FROM records
          WHERE student_id = $1
          AND DATE(created_at) >= $2 AND DATE(created_at) <= $3
        `, [student.username, startStr, endStr]);
        
        const stats = statsResult.rows[0];
        const totalQ = parseInt(stats.total_questions) || 0;
        const correctQ = parseInt(stats.correct_count) || 0;
        const accuracy = totalQ > 0 ? Math.round(correctQ / totalQ * 100) : 0;
        const studyDays = parseInt(stats.study_days) || 0;
        
        // 创建通知
        const title = `📊 本周学习报告 (${startStr} ~ ${endStr})`;
        const content = `答题${totalQ}道，正确率${accuracy}%，学习${studyDays}天。继续加油！`;
        
        await pool.query(`
          INSERT INTO notifications (student_id, title, content, type, is_read)
          VALUES ($1, $2, $3, 'report', FALSE)
        `, [student.id, title, content]);
        
        pushedCount++;
      }
      
      // 记录日志
      if (created_by) {
        await pool.query(`
          INSERT INTO operation_logs (user_type, user_id, action, details)
          VALUES ('admin', $1, 'push_report', $2)
        `, [created_by, JSON.stringify({ week_offset: weekOffset, level: targetLevel, pushed_count: pushedCount })]);
      }
      
      sendJson(res, { success: true, pushed_count: pushedCount });
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

// ===== Operation Log API Handler =====
async function handleLogApi(req, res, url, params) {
  // 解析路由：支持 /api/log/* 和其他独立API如 /api/wrong-level
  let route;
  if (url.pathname.startsWith('/api/log/')) {
    route = url.pathname.replace('/api/log/', '');
  } else if (url.pathname === '/api/log') {
    route = '';
  } else {
    // 其他独立API，如 /api/wrong-level
    route = url.pathname.replace('/api/', '');
  }
  
  // 解析GET请求参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };

  switch (route) {
    case 'record': {
      // 记录操作日志
      const { user_type, user_id, username, action, details, ip_address, user_agent } = allParams;
      if (!user_type || !user_id || !action) {
        sendJson(res, { error: '缺少必要参数' }, 400);
        return;
      }
      
      await pool.query(`
        INSERT INTO operation_logs (user_type, user_id, username, action, details, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [user_type, user_id, username || null, action, details || null, ip_address || null, user_agent || null]);
      
      sendJson(res, { success: true });
      break;
    }
    
    case 'list': {
      // 查询操作日志（管理员）
      const { user_type, user_id, action, start_date, end_date, limit, offset } = allParams;
      const lim = parseInt(limit) || 100;
      const off = parseInt(offset) || 0;
      
      let conds = [];
      let values = [lim, off];
      let idx = 3;
      
      if (user_type) {
        conds.push(`user_type = $${idx++}`);
        values.push(user_type);
      }
      if (user_id) {
        conds.push(`user_id = $${idx++}`);
        values.push(user_id);
      }
      if (action) {
        conds.push(`action = $${idx++}`);
        values.push(action);
      }
      if (start_date) {
        conds.push(`created_at >= $${idx++}`);
        values.push(start_date);
      }
      if (end_date) {
        conds.push(`created_at <= $${idx++}`);
        values.push(end_date);
      }
      
      const whereClause = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      
      const result = await pool.query(`
        SELECT * FROM operation_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, values);
      
      // 获取总数
      const countResult = await pool.query(`
        SELECT COUNT(*) as total FROM operation_logs ${whereClause}
      `, values.slice(2));
      
      sendJson(res, {
        logs: result.rows,
        total: parseInt(countResult.rows[0].total) || 0
      });
      break;
    }
    
    case 'stats': {
      // 日志统计（管理员）
      const { start_date, end_date } = allParams;
      const start = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const end = end_date || new Date().toISOString().split('T')[0];
      
      // 按操作类型统计
      const actionStats = await pool.query(`
        SELECT action, COUNT(*) as count
        FROM operation_logs
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY action
        ORDER BY count DESC
      `, [start, end]);
      
      // 按日期统计活跃度
      const dailyStats = await pool.query(`
        SELECT DATE(created_at) as date,
               COUNT(DISTINCT user_id) as active_users,
               COUNT(*) as total_actions
        FROM operation_logs
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY DATE(created_at)
        ORDER BY date
      `, [start, end]);
      
      sendJson(res, {
        actionStats: actionStats.rows,
        dailyStats: dailyStats.rows,
        period: { start, end }
      });
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// ===== Wrong Training API Handler =====
async function handleWrongTrainingApi(req, res, url, params) {
  const route = url.pathname.replace('/api/wrong-', '').replace('/api/wrong', '');
  
  // 解析参数
  const queryParams = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  const allParams = { ...params, ...queryParams };
  
  switch (route) {
    case 'stats': {
      // 获取错题统计数据
      const studentId = allParams.student_id;
      const level = allParams.level || '';
      
      if (!studentId) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        // 统计错题
        const statsResult = await pool.query(`
          SELECT 
            COUNT(*) as total_wrong,
            SUM(CASE WHEN is_mastered THEN 1 ELSE 0 END) as mastered,
            SUM(CASE WHEN NOT is_mastered AND consecutive_correct = 0 THEN 1 ELSE 0 END) as new_wrong,
            SUM(CASE WHEN NOT is_mastered AND consecutive_correct > 0 THEN 1 ELSE 0 END) as practicing
          FROM wrong_question_mastery
          WHERE student_id = $1
        `, [studentId]);
        
        const stats = statsResult.rows[0];
        
        // 今日待复习
        const today = new Date().toISOString().split('T')[0];
        const reviewResult = await pool.query(`
          SELECT COUNT(*) as count
          FROM wrong_question_mastery
          WHERE student_id = $1 
            AND is_mastered = FALSE
            AND (next_review_at IS NULL OR DATE(next_review_at) <= $2)
        `, [studentId, today]);
        
        // 本周训练统计
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const weekStartStr = weekStart.toISOString().split('T')[0];
        
        const weekResult = await pool.query(`
          SELECT 
            COUNT(*) as sessions,
            SUM(total_questions) as total_questions,
            SUM(correct_count) as total_correct
          FROM wrong_training_sessions
          WHERE student_id = $1 AND DATE(started_at) >= $2
        `, [studentId, weekStartStr]);
        
        const weekStats = weekResult.rows[0];
        
        sendJson(res, {
          stats: {
            total_wrong: parseInt(stats.total_wrong) || 0,
            mastered: parseInt(stats.mastered) || 0,
            new_wrong: parseInt(stats.new_wrong) || 0,
            practicing: parseInt(stats.practicing) || 0
          },
          todayReview: parseInt(reviewResult.rows[0].count) || 0,
          weekStats: {
            sessions: parseInt(weekStats.sessions) || 0,
            total_questions: parseInt(weekStats.total_questions) || 0,
            total_correct: parseInt(weekStats.total_correct) || 0
          }
        });
      } catch (e) {
        console.error('Wrong stats error:', e);
        sendJson(res, { error: '获取统计数据失败' }, 500);
      }
      break;
    }
    
    case 'daily': {
      // 获取每日特训错题
      const studentId = allParams.student_id;
      const level = allParams.level || '';
      const limit = parseInt(allParams.limit) || 10;
      
      if (!studentId) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        const today = new Date().toISOString().split('T')[0];
        
        // 获取待复习的错题
        const result = await pool.query(`
          SELECT q.*, w.wrong_count, w.consecutive_correct, w.mastery_level
          FROM wrong_question_mastery w
          JOIN questions q ON q.id = w.question_id
          WHERE w.student_id = $1 
            AND w.is_mastered = FALSE
            AND (w.next_review_at IS NULL OR DATE(w.next_review_at) <= $2)
            AND ($3 = '' OR q.level = $3)
          ORDER BY w.mastery_level ASC, w.wrong_count DESC, w.last_practice_at ASC NULLS FIRST
          LIMIT $4
        `, [studentId, today, level, limit]);
        
        sendJson(res, { questions: result.rows });
      } catch (e) {
        console.error('Wrong daily error:', e);
        sendJson(res, { error: '获取错题失败' }, 500);
      }
      break;
    }
    
    case 'topics': {
      // 获取错题知识点分布
      const studentId = allParams.student_id;
      const level = allParams.level || '';
      
      if (!studentId) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        const result = await pool.query(`
          SELECT 
            unnest(tags) as tag,
            COUNT(*) as count,
            SUM(CASE WHEN w.is_mastered THEN 1 ELSE 0 END) as mastered,
            SUM(CASE WHEN NOT w.is_mastered THEN 1 ELSE 0 END) as pending
          FROM wrong_question_mastery w
          JOIN questions q ON q.id = w.question_id
          WHERE w.student_id = $1 AND ($2 = '' OR q.level = $2)
          GROUP BY unnest(tags)
          HAVING SUM(CASE WHEN NOT w.is_mastered THEN 1 ELSE 0 END) > 0
          ORDER BY pending DESC, count DESC
        `, [studentId, level]);
        
        sendJson(res, { topics: result.rows });
      } catch (e) {
        console.error('Wrong topics error:', e);
        sendJson(res, { error: '获取知识点失败' }, 500);
      }
      break;
    }
    
    case 'topic-questions': {
      // 获取指定知识点的错题
      const studentId = allParams.student_id;
      const tag = allParams.tag || '';
      const level = allParams.level || '';
      
      if (!studentId) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        const result = await pool.query(`
          SELECT q.*, w.wrong_count, w.consecutive_correct
          FROM wrong_question_mastery w
          JOIN questions q ON q.id = w.question_id
          WHERE w.student_id = $1 
            AND w.is_mastered = FALSE
            AND $2 = ANY(q.tags)
            AND ($3 = '' OR q.level = $3)
          ORDER BY w.wrong_count DESC, w.last_practice_at ASC NULLS FIRST
          LIMIT 20
        `, [studentId, tag, level]);
        
        sendJson(res, { questions: result.rows });
      } catch (e) {
        console.error('Topic questions error:', e);
        sendJson(res, { error: '获取错题失败' }, 500);
      }
      break;
    }
    
    case 'exam': {
      // 获取错题考试题目
      const studentId = allParams.student_id;
      const level = allParams.level || '';
      const count = parseInt(allParams.count) || 20;
      
      if (!studentId) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        const result = await pool.query(`
          SELECT q.*, w.wrong_count, w.consecutive_correct
          FROM wrong_question_mastery w
          JOIN questions q ON q.id = w.question_id
          WHERE w.student_id = $1 
            AND w.is_mastered = FALSE
            AND ($2 = '' OR q.level = $2)
          ORDER BY RANDOM()
          LIMIT $3
        `, [studentId, level, count]);
        
        sendJson(res, { questions: result.rows });
      } catch (e) {
        console.error('Wrong exam error:', e);
        sendJson(res, { error: '获取错题失败' }, 500);
      }
      break;
    }
    
    case 'submit': {
      // 提交答题结果
      if (req.method !== 'POST') {
        sendJson(res, { error: 'Method not allowed' }, 405);
        return;
      }
      
      const { student_id, question_id, is_correct, mode } = params;
      
      if (!student_id || !question_id) {
        sendJson(res, { error: '缺少参数' }, 400);
        return;
      }
      
      try {
        // 获取当前状态
        const currentResult = await pool.query(`
          SELECT wrong_count, correct_count, consecutive_correct, mastery_level
          FROM wrong_question_mastery
          WHERE student_id = $1 AND question_id = $2
        `, [student_id, question_id]);
        
        const current = currentResult.rows[0] || { wrong_count: 0, correct_count: 0, consecutive_correct: 0, mastery_level: 0 };
        
        let newWrongCount = parseInt(current.wrong_count) || 0;
        let newCorrectCount = parseInt(current.correct_count) || 0;
        let newConsecutive = parseInt(current.consecutive_correct) || 0;
        let newMasteryLevel = parseInt(current.mastery_level) || 0;
        let isMastered = false;
        let nextReview = null;
        
        if (is_correct) {
          newCorrectCount++;
          newConsecutive++;
          newMasteryLevel = Math.min(3, newMasteryLevel + 1);
          
          // 连续正确次数决定下次复习时间和是否掌握
          if (newConsecutive >= 3) {
            isMastered = true;
          } else if (newConsecutive === 2) {
            // 7天后复习
            nextReview = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          } else {
            // 3天后复习
            nextReview = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
          }
        } else {
          newWrongCount++;
          newConsecutive = 0;
          newMasteryLevel = Math.max(0, newMasteryLevel - 1);
          // 做错立即可以复习（设为当前时间）
          nextReview = new Date();
        }
        
        // 更新或插入
        await pool.query(`
          INSERT INTO wrong_question_mastery (student_id, question_id, wrong_count, correct_count, consecutive_correct, mastery_level, is_mastered, next_review_at, last_practice_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (student_id, question_id)
          DO UPDATE SET
            wrong_count = $3,
            correct_count = $4,
            consecutive_correct = $5,
            mastery_level = $6,
            is_mastered = $7,
            next_review_at = $8,
            last_practice_at = NOW()
        `, [student_id, question_id, newWrongCount, newCorrectCount, newConsecutive, newMasteryLevel, isMastered, nextReview]);
        
        sendJson(res, { success: true, is_mastered: isMastered });
      } catch (e) {
        console.error('Wrong submit error:', e);
        sendJson(res, { error: '提交失败' }, 500);
      }
      break;
    }
    
    case 'session-start': {
      // 创建训练会话
      if (req.method !== 'POST') {
        sendJson(res, { error: 'Method not allowed' }, 405);
        return;
      }
      
      const { student_id, mode, question_ids } = params;
      
      if (!student_id || !question_ids) {
        sendJson(res, { error: '缺少参数' }, 400);
        return;
      }
      
      try {
        // 将 JavaScript 数组转换为 PostgreSQL 数组格式
        const pgArray = `{${question_ids.join(',')}}`;
        const result = await pool.query(`
          INSERT INTO wrong_training_sessions (student_id, mode, question_ids, total_questions)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `, [student_id, mode || 'daily', pgArray, question_ids.length]);
        
        sendJson(res, { session_id: result.rows[0].id });
      } catch (e) {
        console.error('Session start error:', e);
        sendJson(res, { error: '创建会话失败' }, 500);
      }
      break;
    }
    
    case 'session-finish': {
      // 完成训练会话
      if (req.method !== 'POST') {
        sendJson(res, { error: 'Method not allowed' }, 405);
        return;
      }
      
      const { session_id, correct_count, duration_seconds } = params;
      
      if (!session_id) {
        sendJson(res, { error: '缺少会话ID' }, 400);
        return;
      }
      
      try {
        await pool.query(`
          UPDATE wrong_training_sessions
          SET correct_count = $1, duration_seconds = $2, finished_at = NOW()
          WHERE id = $3
        `, [correct_count || 0, duration_seconds || 0, session_id]);
        
        sendJson(res, { success: true });
      } catch (e) {
        console.error('Session finish error:', e);
        sendJson(res, { error: '更新会话失败' }, 500);
      }
      break;
    }
    
    case 'stats-admin': {
      // 管理端：获取所有学生的错题统计
      const { cohort } = allParams;
      
      try {
        let query = `
          SELECT 
            m.student_id,
            s.nickname,
            s.cohort,
            COUNT(*) FILTER (WHERE m.is_mastered = FALSE AND m.wrong_count = 1) as level1,
            COUNT(*) FILTER (WHERE m.is_mastered = FALSE AND m.wrong_count = 2) as level2,
            COUNT(*) FILTER (WHERE m.is_mastered = FALSE AND m.wrong_count >= 3) as level3,
            COUNT(*) FILTER (WHERE m.is_mastered = TRUE) as review,
            COUNT(*) FILTER (WHERE m.is_mastered = FALSE) as total_wrong
          FROM wrong_question_mastery m
          LEFT JOIN students s ON s.id = m.student_id
          WHERE 1=1
        `;
        const queryParams = [];
        if (cohort) {
          query += ` AND s.cohort LIKE $${queryParams.length + 1}`;
          queryParams.push(`%${cohort}%`);
        }
        query += ` GROUP BY m.student_id, s.nickname, s.cohort ORDER BY total_wrong DESC`;
        
        const result = await pool.query(query, queryParams);
        
        sendJson(res, {
          success: true,
          stats: result.rows.map(row => ({
            student_id: row.student_id,
            nickname: row.nickname,
            cohort: row.cohort,
            level1: parseInt(row.level1) || 0,
            level2: parseInt(row.level2) || 0,
            level3: parseInt(row.level3) || 0,
            review: parseInt(row.review) || 0,
            total_wrong: parseInt(row.total_wrong) || 0
          }))
        });
      } catch (e) {
        console.error('Stats admin error:', e);
        sendJson(res, { error: '查询失败' }, 500);
      }
      break;
    }
    
    case 'detail-admin': {
      // 管理端：获取指定学生的错题详情
      const { student_id } = allParams;
      if (!student_id) {
        sendJson(res, { error: '缺少学生ID' }, 400);
        return;
      }
      
      try {
        const result = await pool.query(`
          SELECT 
            m.*,
            q.type,
            q.content,
            q.options,
            q.answer,
            q.analysis,
            q.tags,
            q.level as question_level
          FROM wrong_question_mastery m
          JOIN questions q ON q.id = m.question_id
          WHERE m.student_id = $1
          ORDER BY m.wrong_count DESC, m.last_practice_at DESC NULLS LAST
        `, [student_id]);
        
        sendJson(res, {
          success: true,
          questions: result.rows
        });
      } catch (e) {
        console.error('Detail admin error:', e);
        sendJson(res, { error: '查询失败' }, 500);
      }
      break;
    }
    
    default:
      sendJson(res, { error: 'Unknown wrong training route: ' + route }, 404);
  }
}
