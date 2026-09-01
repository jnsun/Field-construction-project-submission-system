# 统计分析模块 v1 设计文档

> 最近更新：2026-09-01 · 分支 training-module · 状态：**v1 已实现（SQL + 前端 + 验证脚本），待用户执行 SQL**
> 依赖现状：培训模块 SQL 链已跑通（training_assignments / exam_attempts / training_signatures 均可用）；
> **certificate-management.sql 仍未执行** → 持证率指标已按 §8 降级实现（cert_enabled=false 显示"未启用"）。

---

## 一、目标与范围

面向三级管理员（公司 / 经营实体 dept / 项目部 project）的培训与证照统计分析：

1. **分级数据看板**——各级管理员仅见管辖范围内数据，支持逐级穿透；
2. **五项核心指标**——培训完成率、考试通过率、人均学习时长、持证率、逾期未学人数；
3. **报表导出**——培训记录（含手写签字）一键导出 A4 PDF；
4. **预警机制**——单位完成率低于阈值、个人逾期未学自动预警并分发至对应管理员。

明确不做（v1）：视频课件统计、小程序端看板、短信/微信推送、跨年对比报表。

---

## 二、权限模型与数据穿透

### 2.1 复用现有权限设施（不新造轮子）

| 设施 | 来源 | 用途 |
|---|---|---|
| `training_visible_dept_ids()` | training-management.sql:93 | 返回当前管理员管辖部门集合（本部门+递归下级），SECURITY DEFINER |
| `training_can_write()` | training-management.sql:106 | 判定管理员身份 |
| `profiles.admin_level / is_super_admin` | account-rpc-v2.sql | company / dept / project 三级 |
| `departments.parent_id / dept_type` | department-tree.sql | 组织树穿透 |

### 2.2 穿透规则

- **统一入口 RPC** `stats_overview(p_dept uuid DEFAULT NULL, p_from date, p_to date)`：
  - `p_dept IS NULL` → 汇总「管辖范围内全部」并**按下级部门分组**返回明细行；
  - `p_dept = 某部门` → 聚合该部门内部数据并按其下级再分组（即穿透一层）；
  - **服务端强制校验**：`p_dept NOT IN (SELECT training_visible_dept_ids())` 直接 RAISE 403，前端绕不过；
- 前端穿透交互：部门行点击 → 以该 dept_id 重新拉取 → 面包屑（公司 ▸ 经营实体 ▸ 项目部）逐级返回；
- project 级管理员无下级 → 只见本部门汇总 + 个人明细，穿透按钮自动隐藏。

### 2.3 三条 RLS 铁律沿用（department-fix-v1 已验证）

跨表策略包 SECURITY DEFINER 函数防递归；`IN (SELECT…)` 必须处理 NULL；admin_level 未配置兜底公司级。所有统计 RPC 一律 SECURITY DEFINER + 入口处自检管辖集合，**不依赖裸表 RLS 做聚合**（性能和正确性都更好）。

---

## 三、五项指标口径（数据源全部为现有表）

| 指标 | 定义（分子/分母） | 数据源 |
|---|---|---|
| 培训完成率 | `status='completed'` 的任务数 / 全部下发任务数（按 任务×员工 维度） | `training_assignments.status`（pending/learning/completed/overdue） |
| 考试通过率 | `exam_status='passed'` 的任务数 / 有考试要求的任务数（`exam_mode<>'none'`）；细分「首考通过率」用 `exam_attempts` 按 attempt_no=1 | `training_assignments.exam_status`、`exam_attempts.result` |
| 人均学习时长 | `sum(effective_sec)` / 去重参训人数（有学习记录的员工） | `training_study_logs.effective_sec`（心跳有效时长，失焦已剔除） |
| 持证率 | 有效持证人数 / 部门应持证基准数；有效 = `valid_until >= today OR is_long_term`，按 `holder_id_no` 去重 | `certificates`（**表未建，见 §8 降级**）+ 新表 `stats_cert_targets` |
| 逾期未学人数 | `(deadline < today AND status <> 'completed')` 或 `status='overdue'` 的去重员工数 | `training_assignments` × `training_plans.deadline` |

**口径要点**：

- 任务分母按 **employee_id 维度**统计（双通道：user_id 是发布快照、employee_id 实时绑定，按 employee_id 才不漏发布后开通账号的人）；
- 持证率分母 v1 采用「部门基准数」：新表 `stats_cert_targets(department_id UNIQUE, target_count int)` 由公司级管理员在统计页维护；未配置的部门该指标显示"—"而非 0，避免误读；
- 所有人数统计以 `training_employees` 为人员主档（profiles 只是账号）。

---

## 四、SQL 设计（新文件 `sql/statistics-module.sql`，单文件幂等）

```
-- 1) 阈值配置（公司级一行）
CREATE TABLE stats_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id=1),
  completion_threshold  numeric NOT NULL DEFAULT 80,   -- 完成率预警阈值 %
  overdue_grace_days    int    NOT NULL DEFAULT 7,     -- 逾期宽限天数
  updated_by uuid, updated_at timestamptz DEFAULT now()
);
INSERT stats_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2) 持证率基准
CREATE TABLE stats_cert_targets (
  department_id uuid PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
  target_count  int  NOT NULL CHECK (target_count >= 0),
  updated_by uuid, updated_at timestamptz DEFAULT now()
);

-- 3) 预警信箱（懒计算落库，见 §7）
CREATE TABLE stats_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type   text NOT NULL CHECK (alert_type IN ('unit_completion','person_overdue')),
  department_id uuid,                -- 单位预警归属部门
  employee_id  uuid,                 -- 个人预警对象（可为空）
  plan_id      uuid,
  payload      jsonb NOT NULL,       -- 快照：名称、完成率、逾期天数等
  target_role  text NOT NULL,        -- 分发层级：company / dept
  target_dept  uuid,                 -- 分发管理员的管辖根
  dedup_key    text NOT NULL,        -- 防重复：type:dept:plan:周期
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX ON stats_alerts(dedup_key);

-- 4) RPC（全部 SECURITY DEFINER + search_path 锁定 + 管辖校验）
stats_overview(p_dept uuid, p_from date, p_to date)      → json  五指标 + 下级分组明细
stats_overdue_list(p_dept uuid, p_limit int)             → table 逾期个人名单
stats_alert_sync()                                       → void  懒计算预警并落库（去重）
stats_alert_inbox()                                      → json  当前管理员应收预警 + 未读数
stats_alert_ack(p_ids uuid[])                            → void  标记已读
stats_export_records(p_plan uuid, p_dept uuid)           → json  PDF 导出数据源（§6）
stats_set_cert_target(p_dept uuid, p_count int)          → void  仅公司级
```

要点：所有 RPC 入口先 `IF p_dept IS NOT NULL AND NOT p_dept = ANY(ARRAY(SELECT training_visible_dept_ids())) THEN RAISE` ;聚合 SQL 用 `department_id = ANY(...)` 走现有索引（idx_tr_asg_emp / idx_tr_asg_state）。

---

## 五、前端设计（新顶层模块 `js/modules/stats/stats.js` + `css/stats-module.css`）

- **注册**：registry.js 新增「统计分析」顶层模块（复用 notice.js 的占位模式直接替换实现）；
- **页签（cat-tab）**：`数据看板` / `逾期名单` / `预警中心` / `报表导出`；
- **数据看板**：
  - 顶部胶囊筛选（时间窗：本月/本季/本年/全部 + 部门面包屑）；
  - 五张指标卡（沿用 training.js 统计概览的 `cert-stat-card` 风格）；
  - 下级部门分组表：紧凑表格、单行省略、固定列宽（用户 UI 约定），列 = 部门 / 完成率 / 通过率 / 人均时长 / 持证率 / 逾期人数 / 操作（穿透▸）；
  - **图表 v1 用纯 CSS 横条**（完成率条形，无图表库——vendor/ 无 chart.js，按「vendor 不可轻易新增」的项目铁律，v1 不引库，够用且零风险）；
  - 表格下方「指标口径说明」折叠区（安监检查时可解释数据来源）。
- **逾期名单**：员工 / 部门 / 任务 / 截止日 / 逾期天数，支持按部门胶囊筛选、xlsx 导出（SheetJS 已在 vendor）。
- **预警中心**：信箱列表（未读红点徽标 + 一键全部已读），阈值设置入口（仅公司级可见）。

---

## 六、报表导出：A4 PDF（含手写签字）

**方案：浏览器打印法**（hidden iframe + `@page A4` 打印视图 + `window.print()`，用户选「另存为 PDF」）。否决 jsPDF：中文字体需内嵌 5MB+ 字体文件、排版能力差，与项目「vendor 最小化」冲突。

- **导出粒度三选一**：按计划 / 按部门 / 按人；
- **每条培训记录占 A4 一页**，版式：
  ```
  ┌ 页眉：单位名称 · XX公司培训记录 · 编号（plan-emp 短哈希）
  │ 基本信息：姓名/部门/岗位/任务名称/学习区间
  │ 学习记录表：开始时间/完成时间/有效学时/考试次数/成绩
  │ 判定：完成状态 + 考试结果 + 归档时间
  │ 签字区：手写签字图（storage 签名 URL 拉取 → 转 base64 内嵌，高约 30mm）
  │ 页脚：生成时间 / 生成人 / 第 N 页
  └ @page { size: A4; margin: 18mm 15mm }  页眉页脚 fixed 定位多页复用
  ```
- 数据源 RPC `stats_export_records`：只返回当前管理员管辖范围内的记录；签字图前端经 Storage 签名 URL 拉取后转 base64（打印视图必须离线内嵌，不能热链）；
- 签字缺失的记录打印「员工未签字」占位框并在导出前提示数量；
- 同步提供 xlsx 明细导出（复用 SheetJS），PDF 满足检查、xlsx 满足二次加工。

---

## 七、预警机制（v1：懒计算 + 站内信箱）

**推送载体决策**：无 pg_cron 先例、notice.js 为空壳 → v1 用**懒计算 + 预警信箱**，不引入定时任务：

1. 管理员打开统计模块或培训模块时，前端调用 `stats_alert_sync()`：
   - **单位预警**：某部门完成率 < `completion_threshold`（阈值来自 stats_settings，公司级可改）→ 生成 `unit_completion` 预警；
   - **个人预警**：`deadline < today - overdue_grace_days` 且未完成 → 每人每任务生成 `person_overdue`；
   - `dedup_key = type:dept:plan:年月` 去重 → 同一问题每管理员**每月只推一次**，不轰炸；
2. **分发规则**：预警归属部门的「最小管辖管理员」——项目部级问题发给该项目 admin + 其上级实体 dept admin + 公司级；实体级问题发给实体 admin + 公司级。实现：`target_dept = 预警部门的管理链祖先`，`stats_alert_inbox()` 按 `training_visible_dept_ids()` 交集收取；
3. **触达**：统计模块红点徽标 + 看板顶部预警横幅 + 预警中心列表；培训模块页签旁同样挂未读徽标；
4. **升级路径**：notice.js 正式建成后把信箱接入站内通知；自托管服务器后续可加 pg_cron 每日凌晨跑 `stats_alert_sync()`（留好幂等，切换零成本）。

---

## 八、降级与依赖风险

| 风险 | 处置 |
|---|---|
| `certificate-management.sql` 未执行，certificates 表不存在 | `stats_overview` 内 `to_regclass('public.certificates')` 判空 → 持证率返回 `null`，前端显示「证照模块未启用」并附执行提示，**不报错不拖垮其他指标** |
| 服务器自托管库还没跑培训 SQL 链 | 统计模块与培训模块同批合 main 部署时补跑，SQL 全幂等 |
| 任务分母口径（双通道） | 一律按 employee_id 维度聚合，发布后开通账号的人不漏 |
| 手写签字缺失 | 导出前统计空签字数量并强提示，页内打印占位框 |
| 性能：公司级全量聚合 | 全部走 RPC 服务端聚合（单次 json 返回），前端不做全量拉取；现有 4 个索引覆盖查询路径，必要时补 `(department_id, status)` 复合索引 |

---

## 九、实施顺序（每步可独立验收）

1. **SQL** `sql/statistics-module.sql`：settings / cert_targets / alerts 表 + 7 个 RPC + 验证段 → 用户 Supabase 控制台执行；
2. **看板** `js/modules/stats/` + registry 注册 + CSS：指标卡、穿透表、逾期名单；
3. **导出**：报表导出页签（A4 打印视图 + xlsx）；
4. **预警**：预警中心 + sync/inbox RPC 前端接线 + 徽标；
5. e2e：`tests/e2e/test-stats.js`（三级账号各验一遍数据隔离：公司级见全量、dept 级见子树、project 级仅本部；越权穿透必须 403）。

**验收口径**：dept 级管理员穿透到非管辖部门必须服务端拒绝；五个指标手工抽样对得上（拿卫红学账号的真实学习记录核对）；导出的 PDF 在浏览器打印预览里 A4 排版无溢出、签字图清晰。
