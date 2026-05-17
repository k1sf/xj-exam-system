# Git 提交节点地图

> 新对话中只需说："请读取 COMMIT_MAP.md 文件"

---

## 🔑 关键节点（记住这几个就行）

| 想回退到 | Hash | 命令 |
|---------|------|------|
| **当前最新** | `6873060` | `git checkout 6873060` |
| **GitHub Pages 完整版** | `6873060` | `git checkout 6873060` |
| **GitHub Pages 核心版** | `f169cc1` | `git checkout f169cc1` |
| **Vercel 版本（有后端）** | `b1a57b4` | `git checkout b1a57b4` |
| **本对话开始** | `e467fc0` | `git checkout e467fc0` |

---

## 📋 最近 30 个提交

| # | Hash | 日期 | 说明 |
|---|------|------|------|
| 1 | `6873060` | 2026-05-17 | fix: 完成所有API调用替换为Supabase |
| 2 | `d1f9771` | 2026-05-17 | fix: 修复更多API调用使用Supabase |
| 3 | `afd4993` | 2026-05-17 | fix: 修复更多API调用使用Supabase |
| 4 | `f169cc1` | 2026-05-17 | feat: 重新实现GitHub Pages架构（核心功能） |
| 5 | `b1a57b4` | 2026-05-16 | ⚠️ Vercel 版本（最后一个有后端的版本） |
| 6 | `77c4f37` | 2026-05-16 | fix: 添加缺失的 @vercel/node 依赖 |
| 7 | `85b54e2` | 2026-05-16 | docs: 部署完成，指导用户访问网站 |
| 8 | `04685e0` | 2026-05-16 | docs: 部署成功！指导用户进入控制台查看网站地址 |
| 9 | `1d275a4` | 2026-05-16 | docs: 确认选择了正确的仓库 |
| 10 | `59bfd51` | 2026-05-16 | docs: 发现导入了错误的仓库 |
| 11 | `e303a86` | 2026-05-16 | docs: 指导用户从 GitHub 返回 Vercel |
| 12 | `8d42574` | 2026-05-16 | docs: 指导用户在 Vercel 配置页面设置环境变量 |
| 13 | `f5f2557` | 2026-05-16 | docs: 指导用户重新点击 Continue with GitHub |
| 14 | `26a7c1c` | 2026-05-16 | docs: 确认 GitHub 仓库创建成功 |
| 15 | `d9c1a9d` | 2026-05-16 | docs: 指导用户点击 Install 按钮安装 GitHub 应用 |
| 16 | `6107b1a` | 2026-05-16 | docs: 指导用户点击 Continue with GitHub 授权 |
| 17 | `fb55cd5` | 2026-05-16 | docs: 继续指导用户找到个人设置页面绑定 GitHub |
| 18 | `0270c78` | 2026-05-16 | docs: 指导用户从团队设置切换到个人设置 |
| 19 | `e467fc0` | 2026-05-16 | ⚠️ 本对话开始点 |
| 20 | `d7e18b7` | 2026-05-16 | feat: 创建独立部署仓库 xj-exam-system |

---

## 🔄 回退方法

### 方式 1：查看历史版本（不修改）
```bash
git checkout <hash>
# 查看完后返回最新：git checkout main
```

### 方式 2：永久回退
```bash
git reset --hard <hash>
git push -f origin main
```

### 方式 3：创建分支保留版本
```bash
git checkout -b branch-name <hash>
```

---

## 📦 备份分支

当前项目有以下备份分支：
- `backup-github-pages-version` - 第一次 GitHub Pages 改造版本（有问题）

---

## 🏷️ 分界点说明

| 分界点 | 说明 |
|--------|------|
| `6873060` | **GitHub Pages 完整版** - 所有功能都使用 Supabase |
| `f169cc1` | **GitHub Pages 核心版** - 只有核心功能 |
| `b1a57b4` | **Vercel 版本** - 有后端 API，需要 Vercel 部署 |
| `e467fc0` | **本对话开始** - 之前是上一个对话的内容 |
