# Vercel + Supabase 部署指南

本指南帮助您将修脚师考试刷题系统部署到 Vercel 平台，配合 Supabase 数据库。

---

## 一、前置准备

### 1. 注册账号

| 平台 | 用途 | 注册地址 |
|-----|------|---------|
| **Vercel** | 前端托管 + Serverless API | [vercel.com](https://vercel.com) |
| **Supabase** | PostgreSQL 数据库 | [supabase.com](https://supabase.com) |
| **GitHub** | 代码托管 | [github.com](https://github.com) |

### 2. 获取 Supabase 数据库连接字符串

1. 登录 Supabase Dashboard
2. 选择您的项目（或创建新项目）
3. 进入 **Settings** → **Database**
4. 找到 **Connection string** → 选择 **URI** 格式
5. 复制连接字符串，格式类似：
   ```
   postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```

---

## 二、部署步骤

### 方法一：通过 Vercel Dashboard（推荐新手）

#### Step 1: 上传代码到 GitHub

```bash
# 初始化 Git 仓库（如果还没有）
git init

# 添加所有文件
git add .

# 提交
git commit -m "Initial commit"

# 添加远程仓库
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git

# 推送
git push -u origin main
```

#### Step 2: 在 Vercel 导入项目

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 **Add New** → **Project**
3. 选择 **Import Git Repository**
4. 授权 GitHub 并选择您的仓库
5. 点击 **Import**

#### Step 3: 配置环境变量

在 Vercel 项目设置中添加环境变量：

| 变量名 | 值 | 说明 |
|-------|-----|-----|
| `PGDATABASE_URL` | `postgresql://...` | Supabase 数据库连接字符串 |

**操作路径**：Project Settings → Environment Variables → Add

#### Step 4: 部署

点击 **Deploy** 按钮，等待部署完成。

---

### 方法二：通过 Vercel CLI（推荐开发者）

#### Step 1: 安装 Vercel CLI

```bash
npm install -g vercel
```

#### Step 2: 登录 Vercel

```bash
vercel login
```

#### Step 3: 配置环境变量

创建 `.env` 文件（不要提交到 Git）：

```bash
# 复制示例文件
cp .env.example .env

# 编辑 .env 文件，填入真实的数据库连接字符串
```

#### Step 4: 本地测试

```bash
# 安装依赖
pnpm install

# 启动开发服务器
vercel dev
```

访问 http://localhost:3000 测试功能。

#### Step 5: 部署到生产环境

```bash
# 部署到生产环境
vercel --prod
```

---

## 三、数据库初始化

### 方式一：使用 Supabase SQL Editor

1. 登录 Supabase Dashboard
2. 进入 **SQL Editor**
3. 复制 `supabase-schema.sql` 文件内容
4. 粘贴并执行

### 方式二：通过 API 初始化

部署完成后，系统会自动创建必要的表结构（首次访问时）。

---

## 四、项目结构

```
.
├── api/
│   └── [[...path]].ts      # 统一 API 路由（Serverless Function）
├── lib/
│   └── db.ts               # 数据库连接模块
├── public/
│   └── index.html          # 前端静态页面
├── vercel.json             # Vercel 配置文件
├── package.json            # 项目依赖
├── tsconfig.json           # TypeScript 配置
└── .env.example            # 环境变量示例
```

---

## 五、环境变量说明

| 变量名 | 必填 | 说明 |
|-------|-----|------|
| `PGDATABASE_URL` | ✅ | Supabase PostgreSQL 连接字符串 |
| `DATABASE_URL` | ⚪ | 备用数据库连接字符串 |
| `API_TOKEN` | ⚪ | API 访问令牌（默认已内置） |
| `SUPER_ADMIN_HASH` | ⚪ | 超级管理员密码哈希 |
| `EMAIL_USER` | ⚪ | 邮件发送账号 |
| `EMAIL_PASS` | ⚪ | 邮件授权码 |
| `BACKUP_EMAIL` | ⚪ | 备份接收邮箱 |

---

## 六、功能限制说明

由于 Vercel 是 Serverless 环境，以下功能有所限制：

| 功能 | 状态 | 说明 |
|-----|------|-----|
| 核心功能 | ✅ 完全支持 | 登录、刷题、考试、管理 |
| 定时备份 | ⚠️ 需手动 | Serverless 不支持定时任务 |
| 邮件发送 | ⚠️ 需配置 | 需配置邮件环境变量 |
| WebSocket | ❌ 不支持 | Serverless 不支持长连接 |

**解决方案**：
- 数据备份：通过管理端手动导出
- 定时任务：可使用 [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)（付费功能）

---

## 七、常见问题

### Q1: 数据库连接失败

**检查项**：
1. 确认 `PGDATABASE_URL` 格式正确
2. 确认 Supabase 项目未暂停
3. 确认 IP 白名单设置（Supabase 默认允许所有）

### Q2: API 返回 500 错误

**排查步骤**：
1. 查看 Vercel 函数日志：Project → Functions → Logs
2. 检查数据库连接是否正常
3. 确认 SQL 语句语法正确

### Q3: 页面加载慢

**优化建议**：
1. HTML 文件已启用 Gzip 压缩
2. 可考虑使用 CDN 加速静态资源
3. 检查数据库查询性能

### Q4: 如何更新代码

```bash
# 修改代码后
git add .
git commit -m "Update code"
git push

# Vercel 会自动触发重新部署
```

---

## 八、技术支持

如有问题，请联系系统管理员。

---

**部署完成后**：
- 管理员账号：`admin` / `admin888`
- 学生默认密码：`123456`
- 建议首次登录后立即修改密码
