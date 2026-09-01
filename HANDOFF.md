# 项目跨对话交接文档

> 用途：当对话上下文过长需要另开新对话时，本文件帮助智能体（与人类）快速恢复本项目的背景、约定与待办，无需重述历史。
> 最近更新：2026-09-01（training-module 分支，最新 commit `b734ddf`；工作区已迁至 E 盘）

---

## 〇、当前状态速览

- **工作区根**：`E:\OneDrive\WorkBuddy\` → 实际为 `E:\OneDrive\工作目录\2026\WORKBUDDY\`（已从 C 盘迁出；C 盘旧目录 `C:\Users\sjn\WorkBuddy\workbuddynewweb` 待用户手动删除）
- **当前开发主线**：培训教育模块（`training-module` 分支，仅 GitHub Pages 测试；服务器 main 尚未合入）
- **最新完成**：HTML 课件体系（生成器双模式 + 宿主接线 + 预分节识别，e2e 25/25 + 运行时 10/10）
- **用户侧待执行 SQL**：`sql/training-html-course.sql`（HTML 课件类型放开，**仍未执行**）、`sql/certificate-management.sql`（更早遗留）

---

## 一、项目概览

- **项目名**：施工项目月报管理系统（`project-reporting`）
- **技术栈**：Supabase + 原生 HTML/CSS/JS（无框架、无构建步骤）
- **入口**：`index.html`；加载顺序 `config.js → utils.js → auth.js → report/* → qualification/* → qualification.js → 各模块 → registry → account → dashboard → app`
- **全局对象**：`App`（路由/登录）、`Auth`（认证/角色）、`Utils`（工具）、`AccountSettings`、`sb`（Supabase 客户端，由 config.js 创建）
- **资质证照模块目录**：`js/modules/qualification/`
  - `qualification.js`：模块入口，按角色分发
  - `admin.js`（`CertAdmin`，管理员视图：全公司台账 + 写操作 + 类型/设置）
  - `certs.js`（`Certs`，公司只读视图：仅本公司台账查看）
  - `import.js`（`CertImport`，Excel 批量导入）
- **样式**：主表 `css/style.css` + 模块专属 `css/qualification-module.css`（仅放证照模块专用类）
- **SQL**：`sql/certificate-management.sql`（证照表 + `certificate_trainings` 表 + RLS + 索引，幂等，**需手动在 Supabase 执行**）

---

## 一、培训教育模块（当前开发主线，training-module 分支）

- **前端**：`js/modules/training/`（training / employees / plans / records / exams / courses / questions / papers / mine）+ `css/training-module.css`（弹窗/胶囊作用域样式，勿用透明弹窗）
- **SQL 执行顺序（仅云 Supabase exwsuwhqqpsqekzkmdol，用户手动执行）**：department-tree.sql（已跑）→ department-entity-permissions.sql → **account-rpc-v2.sql（最后，唯一权威版）** → training-management.sql + training-fix-v13.sql → training-online-v2.sql → training-content-library.sql → exam-module.sql → **training-html-course.sql（待跑）**
- **业务流程（用户锁定）**：管理员按层级发任务（圈人严格按 targets 部门树）→ 员工自己账号在线学习 → 在线考试自动判分 → 错题本 → 手写签字 → 归档
- **HTML 课件体系**（2026-09-01 完成，commit 7845deb → 6213813 → b734ddf）：
  - 生成器 `tools/course-generator.html` 双页签：Markdown→课件 / **增强已有 HTML**（注入门控/计时/心跳，用户样式零改动）
  - 增强模式三种结构识别：并列标题切节 / **预分节结构**（每个 h2 各包在 `<section>` 容器，豆包等 AI 生成 HTML 常见）/ 整页兜底（读到底+驻留≤10 分钟）
  - 运行时：节门控（滚到底+驻留 360字/分钟 8~90s）、失焦暂停计时、20s 心跳→`training_course_heartbeat`、postMessage 握手断点恢复（`source: 'tr-courseware'/'tr-host'`）
  - 单独打开降级 localStorage 本地模式；使用指引 `docs/html-courseware-guide.md`
  - 测试：`tests/e2e/test-html-inject.js`（25 项，含真实地震手册 8 节用例）、`test-courseware-runtime.js`（10 项）；跑法：同一 bash 命令内「启动 headless Chrome(CDP 9333) → node 测试 → taskkill」（Chrome 后台启动会秒退）
- **判分口径（用户锁定）**：多选全对才得分；案例分析=材料+子题均分；超时 120s 宽限；补考 3 次含首考
- **账号**：培训自助注册（training_staff_register，手机号+身份证后6位）与报送账号共用 profiles；手机号全局唯一 → 升级用账号管理「编辑」
- **暂不做（用户决策）**：视频/音频课件、离线缓存、学习中弹窗校验、摄像头监考、小程序（待注册跑通）

---

## 二、资质证照模块权限模型

- `qualification.js` 入口：`Auth.isAdmin() ? CertAdmin.render(app) : Certs.render(app)`
- **管理员**：登记 / 编辑 / 删除 / 换证 / 附件上传删除 / 证照类型字典维护 / 系统设置（预警天数）
- **公司账号（reporter）**：仅查看本公司证照与附件，无写入口（与 `certificate_trainings` 的 RLS「写仅管理员」一致）
- **三级角色**：部门账号（报送）→ 普通管理员 → 超级管理员（`Auth.isSuperAdmin()` 额外可管理管理员账号）

---

## 三、关键代码约定（资质证照模块）

### 1. 培训规则引擎（`js/utils.js`）

`trainingRequirement(category, certType, sub1)` 返回 `'none' | 'annual' | 'period2' | null`：

| 证照类型 | 返回值 | 含义 |
|---|---|---|
| 公司证照（`category==='company'`） | `'none'` | 无需年培 |
| 特种作业人员资格证 | `'none'` | 无需年培，到期前换证 |
| 安全生产考核合格证书 | `'none'` | 无需年培，到期前换证 |
| 注册安全工程师 | `'period2'` | 有效期内需培训 **2 次** |
| 爆破作业人员许可证 | `'annual'` | 每年培，**取证当年豁免**，到期前换证 |
| 非煤矿山安全管理人员证书 | `'annual'` | 每年培，取证当年豁免，到期前**培训 6 天并换证** |
| 其他个人证照 | `'annual'` | 每年培，取证当年豁免 |

- `certTrainingInfo(cert, trainings)`：动态判定 `'已培训' | '待培训' | '无需培训'`（**统计卡片与台账过滤必须统一用此函数**，避免口径不一致）
  - `annual`：取证当年（`issue_date`/`valid_from` 年 == 当前年）→「无需培训」；否则沿用存储状态，未明确「已培训」视为「待培训」
  - `period2`：按 `valid_from~valid_until` 窗口统计培训次数，`>=2` 记为「已培训」
- `reCertRequirement(certType)`：非煤矿山 →「到期前需培训 6 天并换证」，其余 →「到期前换证」
- `initTrainingStatusByRule()`：按规则批量初始化存储的 `training_status`（annual 取证当年置「无需培训」，其余空/误填置「待培训」，已「已培训」保留）

### 2. 统计卡片配色语义（`css/qualification-module.css`，固定 hex）

| modifier | 颜色 | 含义 |
|---|---|---|
| `.total` | 靛紫 `#4f46e5`（浅紫底） | 总计 |
| `.success` | 翠绿 `#22c55e` | 有效 / 本年度已培训 |
| `.warning` | 琥珀 `#f59e0b` | 临期 |
| `.danger` | 红 `#ef4444` | 过期 |
| `.info` | 蓝 `#3b82f6` | 本年度未培训 |

- 公司资质 **4 卡**：资质总计 / 有效资质 / 临期资质 / 过期资质
- 个人证照 **6 卡**：证照总计 / 有效证照 / 临期证照 / 过期证照 / 本年度已培训 / 本年度未培训
- 卡片可点击：`applyQuickFilter('cat|kind')` 联动大类选项卡与状态下拉并高亮当前卡片
- 布局：`.cert-stats-block`（`grid 1fr 1fr` 并排两大板块）；公司 4 卡 2 列、个人 6 卡 3 列；窄屏（<720px）回退上下排列

### 3. 导航与布局约定

- **返回上级菜单**：左上角无边框文字按钮 `.btn-back`（灰色、hover 变主色），调用 `App.openDashboard()`
- **顶部布局**：`<h1>`「资质证照管理」由 `.header-center` 绝对定位居中；`.header-left` 仅保留无框「← 返回上级菜单」；`.header-right` 仅保留角色/公司/只读徽章 + 用户信息 + 账户设置 + 退出登录（紧凑排列，gap 10px）
- **筛选区**：`.cert-filters` 内三个 `.filter-group`（公司 / 类型 / 状态），**标签与下拉框并排单行**；标签文字不带冒号（如「公司」而非「公司：」）
- **工具下拉按钮**：文字仅写「工具」，**单箭头由 CSS 伪元素 `.dropdown-toggle::after` 生成**——不要把 `▾` 写进按钮文字（否则会出现两个箭头）
- **回到顶部**：`.back-to-top` 固定右下，由 `Utils.bindBackToTop(btnId)` 绑定（滚动 >320px 显现，平滑回顶，单次绑定）；使用 `↑` 字符
- **行内操作**：管理员为单个「操作 ▾」下拉（编辑 / 换证 / 删除，已无「查看」项）；台账「类型」列可点击（`cert-cell-link`）查看证照详情——**「证照名称」列与「备注」列已从台账隐藏**，原 `cert-name-link` 已弃用。
- **培训列头**名为「培训情况」；编辑表单标签为「培训状态」

### 4. 字段与显示约定

- `cert_category`：`'company' | 'personal'`；`Utils.categoryLabel` 返回 `'公司' | '个人'`（台账大类列、详情、CSV 统一简称）
- 公司简称 `Utils.shortCompany`：`物化院有限公司 → 物化院`、`六勘院有限公司 → 六勘院`（台账公司列、公司筛选、详情、CSV 统一）
- 「个人证书」已全部改为「个人证照」（证书 → 证照）

---

## 四、历史里程碑（2026-08-27 资质证照优化 commit 链，详情见 `.workbuddy/memory/2026-08-27.md`）

资质证照模块自整合进 `project-reporting` 后，今日连续迭代，完整链路：

```
f6138db  整合 qualification 模块进 project-reporting（复用 Auth/Utils/App）
b5d0ff3  修复下拉菜单布局错位 + 确认权限隔离
2a921d2  缩短筛选下拉宽度、优化顶部布局
9b59ca8  header/toolbar 单行 + 取消台账纵向滚动条
9409422  大类选项卡与筛选工具栏拆成两行
9b6f894  同上（JS 结构）
e26e3db  统计分板块（公司资质/个人证照）+ 返回上级菜单 + 工具栏字号统一
411c434  统计卡片并排（2列/3列）可点击筛选台账
72ec171  卡片改紧凑胶囊（后撤销）
03a6ba5  行内图标按钮 + 0计数卡片筛选修复 + 个人证书→个人证照 + 颜色调整
5827bbe  卡片恢复块级大小 + 行内操作合并为单下拉按钮
69a975f  统一统计卡片配色（固定 hex，左右板块一致）
9a121b2  培训规则落地 + 名称简称 + 导航/回到顶部
998f64f  修复「本年度未培训」点击筛选不符（动态判定口径统一）
729198e  修正培训规则与换证要求（爆破/非煤矿山改为 annual + 取证当年豁免）
e66569f  顶部导航/工具按钮/筛选区再优化（最新）
```

每次改动的详细 diff 说明见 **`.workbuddy/memory/2026-08-27.md`**（每日工作日志，按日期归档）。

---

## 五、待办与风险（2026-09-01）

**用户侧必须手动做：**
1. **执行 `sql/training-html-course.sql`**（云 Supabase）——执行后课件管理才能上传 HTML 类型课件；执行后可用已产出的《运城市地震安全手册（增强版）》实测上传+联机学习
2. 顺手补跑更早遗留的 `sql/certificate-management.sql`
3. 删除 C 盘旧目录 `C:\Users\sjn\WorkBuddy\workbuddynewweb`（AI 三条删除路径均被环境安全钩子拦截，需手动删）

**下一步候选：**
- HTML 课件联机端到端验证（跑完 SQL 后：生成器做课件 → 上传 → 卫红学账号实测学时/断点/完成标记）
- 培训模块整体测试通过后合入 main → 部署腾讯云服务器（服务器自建库需补跑整条 SQL 链）
- 可选：题库 Excel 批量导入；统计概览接入在线考试数据；注册安全工程师拆独立统计卡片

**已知风险/约定：**
- vendor/ 绝不能进 .gitignore（曾致线上 xlsx 404）；新加前端库确认 `git ls-files vendor/`
- Storage key 不含中文：上传 key 一律 `时间戳_随机.ext`
- 本地分支名不用 `/`（后台进程会干扰带斜杠的 refs）；.git 异常先怀疑此问题
- 本地 tracking ref 可能卡旧值（假 ahead）→ 判断远端真实状态用 `git ls-remote`

---

## 六、新对话恢复指南（给用户的话术模板）

开始新对话时，第一句话建议直接说：

> 请先读取 `E:\OneDrive\工作目录\2026\WORKBUDDY\project-reporting\HANDOFF.md` 与 `.workbuddy/memory/` 下最新日志（当前 `2026-09-01.md`），恢复培训教育模块的工作背景与代码约定，然后继续帮我 **[模块名 / 具体需求]**。

智能体会据此恢复：项目结构、培训模块业务流程与判分口径、HTML 课件体系、账号与角色模型、部门修复补丁状态、commit 链与待办，无需你重述历史。

---

## 七、注意事项

1. **当前模型不支持读图**：UI 优化需求请用**文字描述**期望效果或当前问题，不要依赖截图。
2. **改动校验**：所有 JS 改动后必须 `node --check` 通过；注意对象方法内"先引用后声明的 const"（TDZ）`node --check` 查不出，运行时才炸。
3. **提交规范**：语义化 commit message；培训模块推 `training-module` 分支。
4. **环境**：Node 用托管版本 `C:\Users\sjn\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`；含空格路径加引号。
5. **工作流**：AI 开发 → push GitHub Pages 测试 → 测试通过后部署腾讯云服务器正式环境（ubuntu@140.143.247.55，服务器访问 GitHub 经常卡死，配置改动用 sed/nano/scp）。
