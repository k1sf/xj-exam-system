# 修脚师考试刷题系统 - 微信云开发版本

## 项目结构

```
xj-exam-system/
├── index.html              # 前端主文件（需修改后使用）
├── cloud-api.js            # 云函数 API 封装
├── cloud-migration-patch.js # 迁移补丁说明
├── cloudfunctions/         # 云函数目录
│   ├── common/
│   │   └── utils.js        # 公共工具函数
│   ├── login/              # 登录云函数
│   │   ├── index.js
│   │   └── package.json
│   ├── select/             # 查询云函数
│   │   ├── index.js
│   │   └── package.json
│   ├── insert/             # 插入云函数
│   │   ├── index.js
│   │   └── package.json
│   ├── update/             # 更新云函数
│   │   ├── index.js
│   │   └── package.json
│   ├── delete/             # 删除云函数
│   │   ├── index.js
│   │   └── package.json
│   └── count/              # 统计云函数
│       ├── index.js
│       └── package.json
├── cloudbaserc.json        # 云开发配置
├── DEPLOY-CLOUD.md         # 详细部署指南
└── README.md               # 本文件
```

## 快速部署（5 分钟）

### 1. 创建云开发环境
1. 访问 https://cloud.weixin.qq.com/
2. 新建环境（选择按量付费，有免费额度）
3. 记住环境 ID

### 2. 创建数据库集合
在云开发控制台 → 数据库，创建 9 个集合：
- students, questions, records, exams, admins
- enroll_configs, enrollments, homeworks, homework_records

### 3. 部署云函数
```bash
# 安装云开发 CLI
npm install -g @cloudbase/cli

# 登录
tcb login

# 部署云函数
tcb fn deploy login --envId 您的环境ID
tcb fn deploy select --envId 您的环境ID
tcb fn deploy insert --envId 您的环境ID
tcb fn deploy update --envId 您的环境ID
tcb fn deploy delete --envId 您的环境ID
tcb fn deploy count --envId 您的环境ID
```

### 4. 修改前端配置
编辑 `index.html`：
1. 替换 Supabase SDK 为云开发 SDK（第 1215 行）
2. 修改环境配置为您的云开发环境 ID（第 1362 行）
3. 添加 `<script src="cloud-api.js"></script>`

### 5. 部署前端
上传 `index.html` 和 `cloud-api.js` 到：
- 云开发「静态网站托管」
- 或您自己的服务器

### 6. 初始化管理员
在云开发控制台 → 数据库 → admins 集合，插入：
```json
{
  "username": "admin",
  "password": "sha256:计算后的哈希值",
  "nickname": "主管理员",
  "is_master": true,
  "created_at": "2025-01-18T00:00:00.000Z"
}
```

## 与原架构对比

| 项目 | 原 Vercel 架构 | 微信云开发架构 |
|------|---------------|---------------|
| 前端 | Vercel CDN | 云开发静态托管 |
| 后端 | Vercel Serverless | 云函数 |
| 数据库 | Supabase (海外) | 云数据库 (国内) |
| 延迟 | 500-2000ms | **50-200ms** |
| 费用 | Vercel 免费 + Supabase 免费 | **免费额度够用** |

## API 对应关系

| 原后端 API | 云函数 | 说明 |
|-----------|--------|------|
| POST /api/login | login | 登录验证 |
| POST /api/select | select | 查询数据 |
| POST /api/insert | insert | 插入数据 |
| POST /api/update | update | 更新数据 |
| POST /api/delete | delete | 删除数据 |
| POST /api/count | count | 统计数量 |

## 前端调用方式

```javascript
// 初始化
await CloudAPI.init('您的环境ID');

// 登录
const user = await CloudAPI.login('students', '手机号', '密码');

// 查询
const students = await CloudAPI.select('students', { 
  eq: { status: 'active' },
  limit: 20 
});

// 插入
await CloudAPI.insert('questions', { 
  type: '单选', 
  content: '题目内容' 
});

// 更新
await CloudAPI.update('students', 
  { nickname: '新昵称' }, 
  { id: 'xxx' }
);

// 删除
await CloudAPI.delete('records', { id: 'xxx' });

// 统计
const count = await CloudAPI.count('students', { 
  eq: { level: '初级' } 
});
```

## 详细文档

请查看 [DEPLOY-CLOUD.md](./DEPLOY-CLOUD.md) 获取完整的部署指南。

## 数据迁移

从 Supabase 迁移数据：
1. 导出 Supabase 数据为 JSON
2. 在云开发控制台导入到对应集合
3. 或使用云函数批量插入

## 注意事项

1. **环境 ID**：务必修改前端配置中的环境 ID
2. **权限规则**：开发阶段可设为全部开放，生产环境需要配置权限
3. **索引**：在数据库中创建索引提高查询性能
4. **密码**：需要使用 SHA256 哈希存储

## 技术支持

如有问题，请查看：
- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
- [云函数开发指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions.html)
