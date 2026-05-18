# 微信云开发部署指南

## 您的云开发环境 ID
```
xj-exam-d8gh1ynujedfe558e
```

---

## 第一步：创建数据库集合

1. 访问云开发控制台：https://console.cloud.tencent.com/tcb/database
2. 选择您的环境 `xj-exam-d8gh1ynujedfe558e`
3. 点击「集合名称」→「添加集合」
4. 依次创建以下 9 个集合：

| 集合名称 | 说明 |
|---------|------|
| students | 学生信息 |
| questions | 题目 |
| records | 答题记录 |
| exams | 考试 |
| admins | 管理员 |
| enroll_configs | 报名配置 |
| enrollments | 报名记录 |
| homeworks | 作业配置 |
| homework_records | 作业记录 |

---

## 第二步：创建云函数

### 方法一：控制台上传（推荐）

1. 访问云函数页面：https://console.cloud.tencent.com/tcb/scf
2. 选择您的环境
3. 点击「新建云函数」
4. 填写信息：
   - 函数名称：`login`
   - 运行环境：Node.js 16
   - 提交方法：本地上传文件夹
5. 选择 `cloudfunctions/login` 文件夹上传
6. 点击「完成」

重复以上步骤，依次创建以下云函数：
- `login` - cloudfunctions/login
- `select` - cloudfunctions/select
- `insert` - cloudfunctions/insert
- `update` - cloudfunctions/update
- `delete` - cloudfunctions/delete
- `count` - cloudfunctions/count

### 方法二：CLI 部署（需要 API Key）

如果您有腾讯云 API Key (SecretId 和 SecretKey)，可以使用 CLI 部署：

```bash
# 登录
tcb login --apiKeyId 您的SecretId --apiKey 您的SecretKey

# 部署云函数
cd /workspace/projects
tcb fn deploy login --envId xj-exam-d8gh1ynujedfe558e
tcb fn deploy select --envId xj-exam-d8gh1ynujedfe558e
tcb fn deploy insert --envId xj-exam-d8gh1ynujedfe558e
tcb fn deploy update --envId xj-exam-d8gh1ynujedfe558e
tcb fn deploy delete --envId xj-exam-d8gh1ynujedfe558e
tcb fn deploy count --envId xj-exam-d8gh1ynujedfe558e
```

---

## 第三步：配置安全规则

### 数据库权限
1. 访问：https://console.cloud.tencent.com/tcb/database/rules
2. 对每个集合设置权限规则：

```json
{
  "read": true,
  "write": true
}
```

### 云函数访问权限
1. 访问：https://console.cloud.tencent.com/tcb/env/setting
2. 找到「安全配置」→「访问授权」
3. 开启「未登录用户访问云函数」

---

## 第四步：部署前端页面

### 方法一：云开发静态托管

1. 访问静态托管页面：https://console.cloud.tencent.com/tcb/hosting
2. 点击「上传文件」
3. 上传以下文件：
   - `index.html`
   - `cloud-sdk.js`（如果有）

### 方法二：使用现有服务器

1. 将 `index.html` 上传到您的服务器
2. 确保通过 HTTPS 访问

### 方法三：Vercel 部署

1. 推送代码到 GitHub
2. 在 Vercel 导入项目
3. 部署即可

---

## 第五步：初始化管理员账号

部署完成后，首次访问系统时需要创建管理员账号。

在数据库 `admins` 集合中插入一条记录：

```json
{
  "username": "admin",
  "password": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "nickname": "主管理员",
  "is_master": true,
  "created_at": "2025-01-19T00:00:00.000Z"
}
```

默认密码是 `123456`（SHA256 哈希后存储）

---

## 常见问题

### Q: 云函数调用失败
检查：
1. 云函数是否已部署
2. 安全规则是否开启
3. 环境ID是否正确

### Q: 数据库操作失败
检查：
1. 集合是否已创建
2. 权限规则是否正确

### Q: 前端无法连接
检查：
1. 环境 ID 是否正确
2. 是否开启未登录访问

---

## 访问地址

部署完成后，您的访问地址为：
- 云开发静态托管：`https://xj-exam-d8gh1ynujedfe558e.tcloudbaseapp.com`
- 或您自己的域名
