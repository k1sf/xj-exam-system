// 数据库连接模块 - Vercel Serverless Functions 专用
import { Pool } from 'pg';

// 全局变量缓存连接池，避免每次请求都创建新连接
declare global {
  // eslint-disable-next-line no-var
  var pgPool: Pool | undefined;
}

function createPool(): Pool {
  let dbUrl = process.env.PGDATABASE_URL || process.env.DATABASE_URL || '';
  
  // 确保只有一个 sslmode
  dbUrl = dbUrl.replace(/sslmode=[^&]+&?/g, '');
  // 移除 channel_binding
  dbUrl = dbUrl.replace(/channel_binding=[^&]+&?/g, '');
  // 确保有 ?
  if (!dbUrl.includes('?')) {
    dbUrl += '?';
  }
  // 移除末尾的 ? 如果有的话
  dbUrl = dbUrl.replace(/\?$/, '');
  // 添加必要参数
  dbUrl += '?uselibpqcompat=true&sslmode=require';
  
  return new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 10,                    // Vercel Serverless 建议较小的连接池
    min: 2,                     // 最小保持2个连接
    idleTimeoutMillis: 30000,   // 空闲连接保持30秒
    connectionTimeoutMillis: 5000, // 连接超时5秒
    statement_timeout: 15000,   // 单条SQL超时15秒
    query_timeout: 20000        // 查询超时20秒
  });
}

// 使用全局变量缓存连接池
export const pool = global.pgPool || createPool();

if (process.env.NODE_ENV !== 'production') {
  global.pgPool = pool;
}

pool.on('error', (err) => {
  console.error('Unexpected pg pool error:', err.message);
});

// 表白名单
export const ALLOWED_TABLES = [
  'students', 'questions', 'records', 'exams', 'admins',
  'enroll_configs', 'enrollments', 'notifications', 'operation_logs',
  'wrong_question_mastery', 'wrong_training_sessions', 'system_settings',
  'homework_config'
];

export function validateTable(table: string): string {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error('Invalid table: ' + table);
  }
  return table;
}

// 列名转义
export function escKey(k: string): string {
  return `"${k.replace(/"/g, '""')}"`;
}

// 值转义
export function escVal(v: any, colType?: string | null): string {
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

// 数组列映射
export const ARRAY_COLUMNS: Record<string, Record<string, string>> = {
  'questions': { 'tags': 'text_array', 'options': 'jsonb' },
  'exams': { 'question_ids': 'bigint_array' },
  'enroll_configs': { 'levels': 'text_array' }
};

export function getColType(table: string, col: string): string | null {
  return (ARRAY_COLUMNS[table] && ARRAY_COLUMNS[table][col]) || null;
}

// select 字段白名单校验
export function validateSelect(selInput: any): string {
  if (!selInput || selInput === '*') return '*';
  const selStr = Array.isArray(selInput) ? selInput.join(',') : String(selInput);
  const parts = selStr.split(',').map(s => s.trim()).filter(Boolean);
  const safe = parts.every(p => /^[a-zA-Z_]\w*$/.test(p));
  if (!safe) throw new Error('Invalid select fields');
  return parts.map(p => `"${p}"`).join(',');
}

// order 字段白名单校验
export function validateOrder(order: any): string {
  if (!order) return '';
  const orders = Array.isArray(order) && Array.isArray(order[0]) ? order : [order];
  const safeOrders = orders.map((o: any) => {
    if (!Array.isArray(o) || o.length < 1) throw new Error('Invalid order format');
    const col = String(o[0]);
    if (!/^[a-zA-Z_]\w*$/.test(col)) throw new Error('Invalid order column');
    const dir = o[1] === false ? 'DESC' : 'ASC';
    return `"${col}" ${dir}`;
  });
  return ' ORDER BY ' + safeOrders.join(', ');
}

// 密码哈希
import crypto from 'crypto';

export function hashPassword(pwd: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(pwd + '_pedicure_salt_2026').digest('hex');
}

export function verifyPassword(input: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith('sha256:')) {
    return stored === hashPassword(input);
  }
  return input === stored;
}

export function needsUpgrade(stored: string): boolean {
  return stored && !stored.startsWith('sha256:');
}
