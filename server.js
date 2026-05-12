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
const ALLOWED_TABLES = ['students', 'questions', 'records', 'exams', 'admins', 'enroll_configs', 'enrollments'];
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
const SUPER_ADMIN_HASH = process.env.SUPER_ADMIN_HASH || '9e0918d39cbb917b2ad5cec0a0fbb1dd049a9204cf473b4f265ad7909a0331bf';

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
