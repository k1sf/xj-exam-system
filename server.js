const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.DEPLOY_RUN_PORT || 5000;

// Direct PostgreSQL connection via pg module
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.PGDATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,              // Max connections in pool (Supabase free tier allows ~60)
  idleTimeoutMillis: 30000,  // Close idle connections after 30s
  connectionTimeoutMillis: 5000  // Wait max 5s for a connection
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
// Generate a random token on server start; embed in HTML for browser; require in API calls
const API_TOKEN = crypto.randomBytes(32).toString('hex');

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
      const conds = Object.entries(match).map(([k, v]) => {
        if (v === null || v === undefined) return `${escKey(k)} IS NULL`;
        if (typeof v === 'boolean') return `${escKey(k)} = ${v}`;
        if (typeof v === 'number') return `${escKey(k)} = ${v}`;
        return `${escKey(k)} = ${escVal(v, getColType(table, k))}`;
      });
      const sql = `UPDATE ${table} SET ${sets.join(',')} WHERE ${conds.join(' AND ')} RETURNING *`;
      const result = await pool.query(sql);
      sendJson(res, result.rows);
      break;
    }
    case 'delete': {
      const { table: rawTable, match } = params;
      const table = validateTable(rawTable);
      const conds = Object.entries(match).map(([k, v]) => {
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
      const sql = `DELETE FROM ${table} WHERE ${conds.join(' AND ')}`;
      await pool.query(sql);
      sendJson(res, { success: true });
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
      pool.query(sessionSql).catch(e => console.error('Session update failed:', e.message));
      // Return user without password, with session_id
      const { password: _, ...safeUser } = user;
      safeUser.session_id = sessionId;
      sendJson(res, safeUser);
      break;
    }
    default:
      sendJson(res, { error: 'Unknown route: ' + route }, 404);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
