# 修脚师考试刷题系统

## 项目概览
修脚师考试刷题系统 - 单文件HTML应用 + Node.js后端代理，支持管理员和学生两种角色。

## 技术栈
- 原生 HTML/CSS/JavaScript（无框架依赖）
- Node.js 后端代理（server.js）直连 PostgreSQL，绕过 PGRST schema cache 问题
- Supabase PostgreSQL 数据库
- 移动端优先设计（375px-414px），PC端居中显示（最大宽度480px）

## 项目结构
```
.
├── index.html              # 主应用（包含所有HTML/CSS/JS）
├── server.js               # Node.js 后端 API 代理
├── supabase-schema.sql     # Supabase 建表 SQL + RLS 策略 + 索引
├── .coze                   # 项目配置
└── AGENTS.md               # 本文件
```

## 构建与运行
- 开发环境：`coze dev`（默认端口5000，启动 server.js）
- 生产环境：`coze build && coze start`
- 服务运行在 5000 端口

## 后端 API（server.js）
6 个端点，均接受 POST JSON 请求（需 `X-API-Token` 头或 `?token=` URL参数鉴权，sendBeacon场景用URL参数）：
- `POST /api/login` - 登录验证（table/username/password，SHA256哈希校验+自动迁移明文）
- `POST /api/select` - 查询数据（支持 filter/eq/limit/offset/order/select/gte/gt/lte/lt，select支持数组和字符串）
- `POST /api/insert` - 插入数据（接受 rows 数组，密码自动SHA256哈希）
- `POST /api/update` - 更新数据（data + match，密码自动SHA256哈希）
- `POST /api/delete` - 删除数据（match 条件，支持数组值生成IN子句）
- `POST /api/count` - 统计行数

安全机制：
- Token鉴权：服务端生成64位随机Token注入HTML，API请求需携带`X-API-Token`头或`?token=`URL参数（sendBeacon用）
- SQL注入防护：`validateSelect`白名单校验（支持数组和字符串），`validateOrder`正则+信息schema白名单校验，列名`escKey`转义
- 密码哈希：SHA256+盐值（`sha256:`前缀），自动迁移明文密码
- 错误信息脱敏：不暴露内部SQL/表结构
- 连接池：max=20, idleTimeout=30s, connectTimeout=5s

特殊处理：
- `escVal` 函数处理 boolean/number/array/null/jsonb/string 类型
- `ARRAY_COLUMNS` 映射：questions.tags→text_array, exams.question_ids→bigint_array, questions.options→jsonb
- 前端 `dbSelect/dbInsert/dbUpdate/dbDelete/dbCount` 封装了所有 API 调用

## 数据库
使用 Supabase PostgreSQL，通过 `PGDATABASE_URL` 环境变量连接。

5 个数据表：
- `students` (UUID PK) - 学生信息（username/手机号, password/默认123456, nickname, cohort, level, status/active|disabled|expired, expires_at/默认一年, can_change_level/是否允许修改等级/默认关闭, xp/经验值, study_level/学习等级1-30, session_id）
- `questions` (bigint identity PK) - 题目（type, content, options, answer, analysis, tags, cohort, level）
- `records` - 答题记录（student_id, question_id, is_correct, user_answer, is_fav, exam_id, guest_name/快捷考试访客姓名）— 练习记录采用UPSERT策略（同一学生+题目只保留最新一条），考试记录每次INSERT
- `exams` (bigint identity PK) - 考试（title, cohort, question_ids, duration, start_time, end_time, level, is_quick/是否快捷考试, pass_rate/及格线百分比）
- `admins` (UUID PK) - 管理员账号（username, password, nickname, is_master/主管理员标识, created_at, session_id）

5 个级别：初级、中级、高级、技师、高级技师（LEVELS 常量）

RLS 策略：SELECT/INSERT/UPDATE 对所有角色开放，DELETE 仅限管理员操作（前端 requireAdmin 守卫）。

## 功能模块
### 管理员体系
- 主管理员（is_master=true）：默认账号 admin/admin888，拥有所有权限
  - 可修改自己的密码
  - 可创建/删除其他管理员，重置其他管理员密码
  - 独占"👑 管理员"Tab
- 其他管理员（is_master=false）：除不能管理其他管理员外，拥有学生/题库/考试/学情所有权限
- 所有管理员：设置Tab中修改密码
- 管理员6个Tab功能（学生/题库/考试/快考/学情/设置）：
  - **学生管理**：批量创建（手机号账号/默认密码123456）、重置密码为123456、禁用/启用账号、续期一年、删除、搜索过滤、批量操作（批量续期/禁用/启用/锁定等级/解锁等级）
  - **题库管理**：新增/编辑/删除/批量导入题目（带预览），支持单选/多选/判断三种题型，**按级别分类**，关键词搜索
  - **考试管理**：创建考试（手动选题/智能抽题）、**选择级别题库**、查看成绩（参与人数显示）、及格线显示、删除考试
  - **快捷考试**：创建扫码考试（无需注册账号）、生成二维码、复制链接、查看成绩排名（按正确率排序+及格线判定）、导出CSV、参与人数显示
  - **学情分析**：按班级查看学生学习数据，支持按日/周/月排名，日期选择+快捷跳转，活跃趋势图（近7日柱状图），连续学习天数统计，**导出CSV**
  - **设置**：显示设置（暗色模式/大字版）、修改密码、帮助文档、管理员管理（仅主管理员：添加/删除/重置密码）

### 快捷考试（访客模式）
- 访客通过扫描二维码进入（URL格式：`域名/#quick=examId`）
- 填写姓名+手机号（必填）即可参加考试
- 防作弊考试模式+页面切换检测（全屏已移除，适合手机竖屏答题）
- 考完显示及格/不及格+逐题详情（不跳转登录页）
- 同一手机号不可重复参加同一快捷考试
- 管理员可查看所有参与者成绩和排名

### 学生
- 登录：手机号+密码（默认123456）+级别选择，账号状态/有效期检查
- 刷题：全部/收藏/随机 三种模式，多选题确认提交机制，按当前级别过滤
- 模拟考试：底部导航独立Tab，学生自由设定考试规则（题型/题源/题量/时长/及格线），进入全屏考试模式，完成后显示及格/不及格+逐题详情
- 考试：参加考试（全屏+防作弊+页面切换检测+自动交卷）、查看成绩详情（环形图+逐题对错），仅显示当前级别考试
- 我的：个人信息、答题统计（数字动画）、当前级别显示、学习等级+XP进度条、修改密码
- **学习升级系统**：基于经验值(XP)的30级升级体系
  - XP获取：答对+10、答错+3、收藏+2、完成模拟考试+50、完成正式考试+100+逐题XP、每日登录+20
  - 30级8个称号：初学者(Lv1-3)、学徒(Lv4-6)、熟手(Lv7-9)、行家(Lv10-14)、高手(Lv15-19)、专家(Lv20-24)、大师(Lv25-29)、宗师(Lv30)
  - XP等级公式：`xpForLevel(n) = 50 * n * (n-1)`，Lv2=100, Lv5=1000, Lv10=4500, Lv20=19000, Lv30=43500
  - 答题时浮动"+N XP"提示，升级时弹出庆祝弹窗
  - XP延迟5秒批量写入数据库，页面离开/切后台时自动flush
  - 顶部栏显示学习等级徽章（🔰📖🏹🛡️⚔️🎓👑）

## 安全与性能
- 管理员权限守卫（requireAdmin）加在所有写入操作
- 考试防作弊：页面切换监控、退出/切换页面警告+自动交卷、禁用右键/选择（已移除全屏强制，支持竖屏答题）
- 交卷防重复：`_examSubmitting`标志位防止双击/重复提交，提交失败可重试
- 会话管理：24小时过期、<1小时警告、localStorage 持久化
- 前端缓存：30秒 TTL 内存缓存，写操作自动清除
- 加载状态+按钮防重复提交（debounce）
- 选项兼容 {key,value} 和 {label,text} 两种格式
- 快捷考试独立状态变量：`currentExamIsQuick`/`quickExamGuest`，不依赖 `examData`/`currentUser` 生命周期
- 快捷考试访客使用手机号作为 `student_id`，姓名存入 `records.guest_name`
- 分页组件：`paginateHtml(key, total, page)` + `pageSlice(arr, page)` + `goPage(key, page)`，每页10条


## 数据生命周期与性能
- **UPSERT去重**：练习答题采用UPSERT策略，同一学生+题目只保留最新一条记录（通过`_recordBufferMap`去重），考试记录每次INSERT（每次考试独立）
- **学情查询优化**：`loadLearningData`使用`gte/lt`日期范围过滤，不再加载全表；连续天数仅查60天窗口
- **数据库索引**：records表有created_at/student_id/question_id/exam_id索引+复合索引(idx_records_student_question, idx_records_student_exam)，exams表有level/is_quick/start_time索引
- **连接池**：max=20, idleTimeout=30s, connectTimeout=5s
- **缓存**：30秒TTL内存缓存，写操作自动清除；SWR(stale-while-revalidate)策略，过期缓存先返回后台刷新
- **建议**：每年归档一次过期学生数据到archive表；Supabase免费版500MB约存50万条records，Pro版($25/月)8GB

## 注意事项
- API鉴权：服务端生成随机Token注入HTML，API请求需携带`X-API-Token`头或`?token=`URL参数（sendBeacon场景）
- sendBeacon鉴权：beforeunload时使用`?token=`URL参数传递Token（sendBeacon无法设置自定义Header）
- 密码安全：服务端使用SHA256+盐值哈希存储（`sha256:`前缀），登录通过`/api/login`端点验证，自动迁移明文密码
- SQL注入防护：`validateSelect`参数白名单校验（支持数组和字符串），`validateOrder`参数正则+白名单校验，列名`escKey`转义
- 删除级联：删除题目自动清理关联records+更新考试question_ids，删除考试自动清理records
- 数据库索引：records表有student_id/exam_id/created_at/question_id/idx_records_student_question/idx_records_student_exam索引，exams表有level/is_quick/start_time索引，admins表有username索引
- 时间显示：`fmtLocal()`/`fmtLocalShort()`将UTC时间戳转为本地时间显示
- 所有 CSS/JS 内联在 index.html 中
- PGRST schema cache 问题已通过 Node.js 直连 PostgreSQL 绕过
- "发现学习记录"弹窗支持点击X/遮罩层关闭，不强制选择从头/继续
- 快捷考试独立状态变量：`currentExamIsQuick`/`quickExamGuest`，不依赖 `examData`/`currentUser` 生命周期
- 快捷考试访客使用手机号作为 `student_id`，姓名存入 `records.guest_name`
- XSS防护：所有用户输入内容（nickname/content等）均使用 `escHtml()` 转义后再插入HTML
- 管理员考试Tab过滤 `is_quick=false`，快捷考试Tab过滤 `is_quick=true`，学生考试Tab过滤 `is_quick=false`
- XP通过 `flushXp()` 延迟5秒批量写入，`flushXpSync()` 在 `beforeunload` 时使用 `sendBeacon` 保证数据不丢失
- `validateSelect` 同时支持字符串（`"col1,col2"`）和数组（`["col1","col2"]`）两种格式
- 帮助系统：首次登录自动弹出帮助信息，学生为简要使用指南，管理员为详细操作文档；可勾选"不再弹出"，通过顶栏📖帮助按钮重新查看
- 显示设置：登录页和⚙️设置中可切换暗色模式(🌙)和大字版(🔤)，设置持久化在localStorage
- 单设备登录：登录时服务端生成32位session_id写入DB，客户端每60秒+页面可见时校验，session_id不匹配则强制退出并提示"账号已在其他设备登录"
- 学生退出按钮在顶部标题栏右侧，不再在"我的"页面底部
- 学生管理卡片为单列紧凑布局，点击卡片打开编辑弹窗（含基本信息修改+重置密码/续期/禁用/删除等操作）
- `can_change_level`默认为false（关闭），管理员编辑学生时需显式勾选开启
