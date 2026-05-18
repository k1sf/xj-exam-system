/**
 * 微信云开发 - 数据库初始化指南
 * 
 * 云数据库是文档型数据库（MongoDB 风格），与 PostgreSQL 不同：
 * - 不需要预先定义表结构
 * - 集合（Collection）相当于表
 * - 文档（Document）相当于行
 * - 字段可以动态添加
 * 
 * 请在微信云开发控制台创建以下集合：
 */

-- ============================================
-- 第一步：创建集合（在云开发控制台 -> 数据库）
-- ============================================

1. students - 学生表
2. questions - 题目表
3. records - 答题记录表
4. exams - 考试表
5. admins - 管理员表
6. enroll_configs - 报名配置表
7. enrollments - 报名记录表
8. homeworks - 作业配置表
9. homework_records - 作业记录表

-- ============================================
-- 第二步：创建索引（提高查询性能）
-- ============================================

在云开发控制台 -> 数据库 -> 对应集合 -> 索引管理，添加以下索引：

students 集合:
  - username (升序, 唯一)
  - cohort (升序)
  - level (升序)
  - status (升序)
  - created_at (降序)

questions 集合:
  - level (升序)
  - type (升序)
  - cohort (升序)

records 集合:
  - student_id (升序)
  - question_id (升序)
  - exam_id (升序)
  - created_at (降序)
  - 复合索引: student_id + question_id

exams 集合:
  - level (升序)
  - is_quick (升序)
  - start_time (降序)

admins 集合:
  - username (升序, 唯一)

enrollments 集合:
  - config_id (升序)
  - phone (升序)
  - status (升序)
  - 复合索引: config_id + phone

-- ============================================
-- 第三步：设置数据库权限规则
-- ============================================

在云开发控制台 -> 数据库 -> 对应集合 -> 权限设置：

推荐设置：自定义安全规则

所有集合的规则（允许已登录用户读写）：
{
  "read": true,
  "write": "doc._openid == auth.openid"
}

或者简化为（开发阶段）：
{
  "read": true,
  "write": true
}

生产环境建议使用更严格的权限规则。

-- ============================================
-- 第四步：初始化管理员账号
-- ============================================

在 admins 集合中插入初始管理员：

{
  "username": "admin",
  "password": "sha256:xxx",  // 需要计算哈希值
  "nickname": "主管理员",
  "is_master": true,
  "created_at": "2025-01-18T00:00:00.000Z"
}

或者在前端使用"初始化管理员"功能创建。

-- ============================================
-- 数据迁移说明
-- ============================================

从 Supabase PostgreSQL 迁移数据到云数据库：

1. 导出 Supabase 数据为 JSON 格式
   - 可以使用 Supabase 控制台的导出功能
   - 或者通过 API 查询所有数据

2. 转换数据格式
   - PostgreSQL 的 id 字段改为 _id
   - 时间格式保持 ISO 8601
   - 数组字段保持数组格式

3. 导入到云数据库
   - 使用云开发控制台的导入功能
   - 或者通过云函数批量插入

4. 数据类型对照：
   PostgreSQL          云数据库
   ---------          ---------
   bigint             number
   text               string
   boolean            boolean
   timestamp          string (ISO 8601)
   jsonb              object
   text[]             array<string>
   bigint[]           array<number>
