# 资质证照管理模块 — 跨对话交接文档

> 用途：当对话上下文过长需要另开新对话时，本文件帮助智能体（与人类）快速恢复本项目的背景、约定与待办，无需重述历史。
> 最近更新：2026-08-27（对应最新 commit `e66569f`）

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

## 二、权限模型

- `qualification.js` 入口：`Auth.isAdmin() ? CertAdmin.render(app) : Certs.render(app)`
- **管理员**：登记 / 编辑 / 删除 / 换证 / 附件上传删除 / 证照类型字典维护 / 系统设置（预警天数）
- **公司账号（reporter）**：仅查看本公司证照与附件，无写入口（与 `certificate_trainings` 的 RLS「写仅管理员」一致）
- **三级角色**：部门账号（报送）→ 普通管理员 → 超级管理员（`Auth.isSuperAdmin()` 额外可管理管理员账号）

---

## 三、关键代码约定

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
- **顶部 `.header-right`**：`<h1>` 标题 + 角色/公司/只读徽章 + 用户信息 + 账户设置 + 退出登录（紧凑排列，gap 10px）
- **筛选区**：`.cert-filters` 内三个 `.filter-group`（公司 / 类型 / 状态），**标签置顶、下拉框占满**；标签文字不带冒号（如「公司」而非「公司：」）
- **工具下拉按钮**：文字仅写「工具」，**单箭头由 CSS 伪元素 `.dropdown-toggle::after` 生成**——不要把 `▾` 写进按钮文字（否则会出现两个箭头）
- **回到顶部**：`.back-to-top` 固定右下，由 `Utils.bindBackToTop(btnId)` 绑定（滚动 >320px 显现，平滑回顶，单次绑定）；使用 `↑` 字符
- **行内操作**：管理员为单个「操作 ▾」下拉（编辑 / 换证 / 删除，已无「查看」项）；**证照名称列可点击** `cert-name-link` 查看详情
- **培训列头**名为「培训情况」；编辑表单标签为「培训状态」

### 4. 字段与显示约定

- `cert_category`：`'company' | 'personal'`；`Utils.categoryLabel` 返回 `'公司' | '个人'`（台账大类列、详情、CSV 统一简称）
- 公司简称 `Utils.shortCompany`：`物化院有限公司 → 物化院`、`六勘院有限公司 → 六勘院`（台账公司列、公司筛选、详情、CSV 统一）
- 「个人证书」已全部改为「个人证照」（证书 → 证照）

---

## 四、今日（2026-08-27）优化里程碑（commit 链）

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

## 五、待办与风险

- **必须手动执行**：`sql/certificate-management.sql` 需在 Supabase 控制台执行后，证照表 / RLS / Storage 桶才生效（前端已做表不存在的降级提示）。
- **可选增强**（曾列为候选，未实现）：
  - 注册安全工程师「达标 / 未达标」拆为独立统计卡片
  - 回到顶部按钮换成图标
- **已知限制**：`annual` 类型跨年依赖存储的 `training_status`；若要严格按自然年清零重计，需更大改造（用户已知悉）。
- **import.js 缺口**：批量导入暂不含培训状态 / 培训记录，需在详情页单独维护；CSV 导出仍含证照编号（全量导出）。

---

## 六、新对话恢复指南（给用户的话术模板）

开始新对话时，第一句话建议直接说：

> 请先读取 `C:\Users\sjn\WorkBuddy\workbuddynewweb\.workbuddy\memory\2026-08-27.md`、`project-reporting/HANDOFF.md` 与本项目的 `MEMORY.md`，恢复资质证照模块的工作背景与代码约定，然后继续帮我优化 **[模块名 / 具体需求]**。

智能体会据此恢复：项目结构、权限模型、培训规则引擎、统计卡片配色、导航布局约定、今日 commit 链与待办，无需你重述历史。

---

## 七、注意事项

1. **当前模型不支持读图**：UI 优化需求请用**文字描述**期望效果或当前问题（如「返回按钮放左上角、无边框、其余靠右」），不要依赖截图——截图内容需文字转述。
2. **改动校验**：所有 JS 改动后必须 `node --check` 通过；CSS 类命名集中在 `css/qualification-module.css`，避免散落到主表。
3. **提交规范**：语义化 commit message，完成后 `git push origin main`。
4. **环境**：Node 优先用托管版本 `C:\Users\sjn\.workbuddy\binaries\node\versions\22.22.2\node.exe`；PowerShell 命令需加引号处理含空格路径。
