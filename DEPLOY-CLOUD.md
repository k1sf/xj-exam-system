# 微信云开发部署指南

## 一、创建云开发环境

1. 访问 [微信云开发控制台](https://cloud.weixin.qq.com/)
2. 使用微信扫码登录
3. 点击「新建环境」
4. 选择「按量付费」（有免费额度）
5. 填写环境名称，如 `xj-exam`
6. 记住环境 ID（类似 `xj-exam-xxx`）

## 二、创建数据库集合

在云开发控制台 → 数据库，创建以下集合：

| 集合名称 | 说明 |
|---------|------|
| students | 学生表 |
| questions | 题目表 |
| records | 答题记录表 |
| exams | 考试表 |
| admins | 管理员表 |
| enroll_configs | 报名配置表 |
| enrollments | 报名记录表 |
| homeworks | 作业配置表 |
| homework_records | 作业记录表 |

## 三、部署云函数

### 方法一：使用云开发控制台

1. 进入「云函数」页面
2. 点击「新建云函数」
3. 依次创建 6 个云函数：
   - login
   - select
   - insert
   - update
   - delete
   - count
4. 每个云函数选择 Node.js 16.13 运行时
5. 将 `cloudfunctions/函数名/index.js` 的代码复制到在线编辑器
6. 保存并部署

### 方法二：使用云开发 CLI（推荐）

1. 安装云开发 CLI：
   ```bash
   npm install -g @cloudbase/cli
   ```

2. 登录：
   ```bash
   tcb login
   ```

3. 部署所有云函数：
   ```bash
   cd /workspace/projects
   tcb fn deploy login --envId 您的环境ID
   tcb fn deploy select --envId 您的环境ID
   tcb fn deploy insert --envId 您的环境ID
   tcb fn deploy update --envId 您的环境ID
   tcb fn deploy delete --envId 您的环境ID
   tcb fn deploy count --envId 您的环境ID
   ```

## 四、配置前端

### 1. 修改 index.html

在 `<head>` 中添加云开发 SDK：

```html
<script src="https://imgcache.qq.com/qcloud/cloudbase-js-sdk/1.7.1/cloudbase.full.js"></script>
```

### 2. 初始化云开发

在 JavaScript 中添加初始化代码：

```javascript
// 初始化云开发
const ENV_ID = '您的云开发环境ID';

async function initApp() {
  await CloudAPI.init(ENV_ID);
  console.log('云开发初始化成功');
}

// 页面加载时初始化
initApp();
```

### 3. 替换 Supabase 调用

| 原来（Supabase） | 现在（云函数） |
|-----------------|---------------|
| `supabase.from('students').select()` | `dbSelect('students')` |
| `supabase.from('students').insert()` | `dbInsert('students', data)` |
| `supabase.from('students').update()` | `dbUpdate('students', data, match)` |
| `supabase.from('students').delete()` | `dbDelete('students', match)` |

## 五、部署静态网站

### 方法一：云开发静态网站托管

1. 进入「静态网站托管」页面
2. 上传 `index.html` 和 `cloud-api.js` 文件
3. 访问域名：`https://您的环境ID.tcloudbaseapp.com`

### 方法二：自定义域名

1. 在「静态网站托管」→「域名管理」添加自定义域名
2. 按提示完成域名解析
3. 配置 HTTPS 证书

## 六、数据迁移

从 Supabase 迁移数据到云数据库：

### 1. 导出 Supabase 数据

```javascript
// 在浏览器控制台执行
const tables = ['students', 'questions', 'records', 'exams', 'admins'];
for (const table of tables) {
  const data = await dbSelect(table, { limit: 1000 });
  console.log(`${table}:`, JSON.stringify(data));
}
```

### 2. 转换并导入

将导出的 JSON 数据通过云开发控制台导入到对应集合。

## 七、安全配置

### 1. 数据库权限规则

在「数据库」→「权限设置」中配置：

```json
{
  "read": true,
  "write": "auth != null"
}
```

### 2. 云函数权限

在「云函数」→「访问设置」中：
- 开启「允许未登录访问」（网页端需要）
- 或配置「HTTP 访问服务」+ 自定义鉴权

## 八、测试验证

1. 访问部署的前端页面
2. 测试登录功能（管理员: admin/admin888）
3. 测试题库管理
4. 测试学生答题

## 九、监控与日志

- 在「云函数」→「日志」查看调用日志
- 在「云函数」→「监控」查看调用统计
- 在「数据库」→「监控」查看读写统计

## 十、费用说明

### 免费额度（每月）

| 资源 | 免费额度 |
|------|---------|
| 数据库读 | 5 万次 |
| 数据库写 | 3 万次 |
| 云函数调用 | 4 万次 |
| 云函数资源使用量 | 4 万 GBs |
| 静态托管流量 | 1 GB |

### 预估费用

| 用户规模 | 月费用 |
|---------|-------|
| < 50 学生 | 免费 |
| 50-200 学生 | ¥10-30 |
| 200-500 学生 | ¥30-50 |

## 十一、常见问题

### Q: 网页端如何调用云函数？

A: 网页端需要先匿名登录：
```javascript
await app.auth().anonymousAuthProvider().signIn();
```

### Q: 如何绑定自定义域名？

A: 在「静态网站托管」→「域名管理」添加域名，完成 DNS 解析。

### Q: 数据库查询慢怎么办？

A: 1) 添加索引 2) 减少返回字段 3) 分页查询

---

## 快速开始脚本

将以下代码保存为 `init-cloud.js`，修改 ENV_ID 后执行：

```javascript
// 初始化脚本
const ENV_ID = '您的环境ID';

// 1. 初始化云开发
await CloudAPI.init(ENV_ID);

// 2. 创建管理员
await dbInsert('admins', {
  username: 'admin',
  password: 'admin888',
  nickname: '主管理员',
  is_master: true
});

// 3. 创建测试学生
await dbInsert('students', {
  username: '13800138000',
  password: '123456',
  nickname: '测试学生',
  level: '初级',
  status: 'active'
});

console.log('初始化完成！');
```
