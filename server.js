const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
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
const ALLOWED_TABLES = ['students', 'questions', 'records', 'exams', 'admins'];
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
const SUPER_ADMIN_HASH = process.env.SUPER_ADMIN_HASH || '91b24f42851d4897224c1ce302f7aa564859feabc2366c64574774333846c86e';

function verifySuperAdmin(password) {
  const hash = crypto.createHash('sha256').update(password + '_super_recovery_salt_2026').digest('hex');
  return hash === SUPER_ADMIN_HASH;
}

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
  'exams': { 'question_ids': 'bigint_array' }
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
    // Verify API token: check both header and URL query param (for sendBeacon which can't set headers)
    const reqToken = req.headers['x-api-token'] || url.searchParams.get('token');
    if (reqToken !== API_TOKEN) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }
    try {
      await handleApi(req, res, url);
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
    res.writeHead(200, { 'Content-Type': MIMES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

async function handleApi(req, res, url) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const params = body ? JSON.parse(body) : {};

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
    case 'register': {
      // 学生报名接口（无需登录）
      const { name, phone, cohort, level } = params;
      if (!name || !phone || !level) {
        sendJson(res, { success: false, error: '缺少必填字段' });
        break;
      }
      // 检查手机号是否已报名
      const checkSql = `SELECT id FROM registrations WHERE phone = ${escVal(phone)} AND status = 'pending'`;
      const existing = await pool.query(checkSql);
      if (existing.rows.length > 0) {
        sendJson(res, { success: false, error: '该手机号已提交报名，请等待审核' });
        break;
      }
      // 插入报名记录
      const insertSql = `INSERT INTO registrations (name, phone, cohort, level, status) VALUES (${escVal(name)}, ${escVal(phone)}, ${escVal(cohort || '')}, ${escVal(level)}, 'pending') RETURNING id`;
      const result = await pool.query(insertSql);
      sendJson(res, { success: true, id: result.rows[0].id });
      break;
    }
    case 'batch-register': {
      // 批量导入报名记录（管理员）
      const { rows } = params;
      if (!Array.isArray(rows) || rows.length === 0) {
        sendJson(res, { success: false, error: '没有要导入的数据' });
        break;
      }
      // 检查手机号重复（只导入未报名的）
      const phones = rows.map(r => r.phone).filter(Boolean);
      if (phones.length === 0) {
        sendJson(res, { success: false, error: '没有有效的手机号' });
        break;
      }
      const placeholders = phones.map((p, i) => `$${i + 1}`).join(',');
      const existSql = `SELECT phone FROM registrations WHERE phone IN (${placeholders})`;
      const existing = await pool.query(existSql, phones);
      const existPhones = new Set(existing.rows.map(r => r.phone));
      const newRows = rows.filter(r => !existPhones.has(r.phone));
      if (newRows.length === 0) {
        sendJson(res, { success: true, imported: 0, skipped: rows.length, error: '所有手机号都已报名' });
        break;
      }
      // 批量插入
      let imported = 0;
      for (const row of newRows) {
        if (!row.name || !row.phone || !row.level) continue;
        const insertSql = `INSERT INTO registrations (name, phone, cohort, level, status) VALUES (${escVal(row.name)}, ${escVal(row.phone)}, ${escVal(row.cohort || '')}, ${escVal(row.level)}, 'pending')`;
        try {
          await pool.query(insertSql);
          imported++;
        } catch(e) { console.error('Batch register error:', e.message); }
      }
      sendJson(res, { success: true, imported, skipped: rows.length - imported });
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
      const { table: rawTable, username, password } = params;
      console.log('verify-password called:', { table: rawTable, username });
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
      // Verify against hardcoded hash (security through obscurity + server-side only)
      const hash = crypto.createHash('sha256').update(password + '_super_recovery_salt_2026').digest('hex');
      if (hash !== SUPER_ADMIN_HASH) {
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
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
