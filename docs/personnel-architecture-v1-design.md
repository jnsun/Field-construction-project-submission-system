# 人员与组织中心 · 架构设计 v1

> 状态：P1 已实施（待用户执行 sql/personnel-center-v1.sql 后跑 tests/e2e/verify-people.js 回归）
> 实施偏差说明：特种作业标记未新增 is_special 列——training_employees.emp_type='special' 已承担，直接复用
> 2026-09-01 与用户三轮问答确认的需求边界，见文末「决策记录」

## 一、问题：现在有三个管人的地方、两套人员数据

| 现有入口 | 管的东西 | 数据表 |
|---|---|---|
| 报送模块 → 账号管理 | 登录账号（角色/层级/报送权/部门） | `profiles` |
| 培训教育 → 员工档案 | 员工档案（姓名/工号/岗位工种/身份证/手机号/入场日期） | `training_employees` |
| 报送模块 → 部门管理 | 组织树 | `departments` |

痛点：
1. 同一个人可能在两张表各存一份，手机号靠唯一索引缝合（王伟重复手机号问题的病根）；
2. 培训管档案、报送管账号，将来考核/特种作业管理还得再各管一遍；
3. 证照、培训记录挂人没有统一的人本视图，查一个人要跑三个模块。

## 二、目标架构（一句话）

> **一个中心（人员与组织）、一张权威表（员工表）、账号是档案的可选附属、各业务模块只引用不管人。**

```
                    ┌────────────────────────────┐
                    │   人员与组织中心（新模块）    │
                    │  组织架构 / 员工台账(+账号)   │
                    │  360 视图 / 我的档案(员工端)  │
                    └──────────┬─────────────────┘
                               │ 唯一入口（增删改）
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  departments(组织树)    training_employees     profiles(登录)
                        （权威员工表，加字段）   （瘦身为纯登录表
        ▲                      ▲                新增 employee_id 弱关联）
        │                      │
  ┌─────┴─────┬─────────┬─────┴──────┬─────────────┐
  │ 培训教育   │ 资质证照 │  统计分析   │ 未来：考核等  │
  └───────────┴─────────┴────────────┴─────────────┘
        各模块只按 employee_id 只读引用，不再有管人页面
```

## 三、数据层设计（sql/personnel-center-v1.sql）

### 3.1 权威员工表 = training_employees 改造（不改表名，避免大迁移）

证照（certificates）、培训（assignments 等）已挂在它上面，保留表名只加字段：

```sql
ALTER TABLE public.training_employees
  ADD COLUMN IF NOT EXISTS job_grade   TEXT,     -- 岗级/职务
  ADD COLUMN IF NOT EXISTS is_special  BOOLEAN NOT NULL DEFAULT false, -- 特种作业人员标记
  ADD COLUMN IF NOT EXISTS photo_path  TEXT;     -- 照片 Storage key（avatars bucket）
```

- 特种作业的**证件明细不在此表**（复用证照模块 certificates，中心只展示标记+持证汇总）；
- 手机号即登录标识，沿用现有全局唯一策略（`idx_profiles_phone` 同源校验）。

### 3.2 profiles 瘦身为纯登录表

```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.training_employees(id);
```

- **账号 ↔ 档案 = N:0..1**：有 employee_id 的账号是"员工开通了登录"；NULL 的账号是**纯管理账号**（超管、公司领导查数账号），在人员中心单独分组展示；
- 存量数据缝合：一次性 UPDATE 按 `profiles.phone = training_employees.phone` 自动挂接（SQL 内完成，幂等）；
- 现有 RPC（create_dept_user / update / delete、resolve_login_identifier、培训自助注册）**全部保留复用**，只在前端换入口；create/update 增加可选 p_employee_id 参数版（新 RPC，不破坏旧签名）。

### 3.3 员工自助（改手机号/照片，直接生效+留痕）

```sql
CREATE TABLE IF NOT EXISTS public.personnel_change_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  field TEXT NOT NULL,             -- phone | photo | ...(预留)
  old_value TEXT, new_value TEXT,
  changed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

RPC：
- `employee_self_profile()` —— 返回本人档案 + 账号状态 + 持证汇总 + 培训汇总（360 自视图，SECURITY DEFINER 限定本人）；
- `employee_self_update(p_field, p_value)` —— 仅放行 `phone` / `photo_path` 两个字段；phone 走全局唯一校验；其余字段一律拒绝；
- 其余字段（姓名/身份证/部门/岗位/岗级/特种作业标记）**只有管理员可改**（沿用三级树管辖校验，风格同 stats 模块）。

### 3.4 Storage

新增 `avatars` bucket（员工照片），路径 `时间戳_随机.ext`（沿用既有 Storage key 规范，原文件名存业务字段）。

## 四、前端设计（新模块 id=people「人员与组织」）

仅九宫格一个入口，**替代**三个旧入口（旧页签删除，不做只读过渡）。

### 页签 1：组织架构
- 左侧部门树（公司根→经营实体→内设机构/项目部，沿用现有层级规则：内设机构叶子不可建子部门）；
- 树节点操作：公司级可增/改/停用部门；实体级只读自己子树；
- 节点面板显示：部门类型、人数、负责人（预留）。

### 页签 2：员工台账（含账号管理）
- 胶囊筛选：在职/离职 · 部门（本管辖树）· 有无账号 · 特种作业；
- 表格列：姓名 / 工号 / 部门 / 岗位工种 / 岗级 / 手机号 / 账号状态徽章（未开通·员工·管理）/ 特种作业标记 / 操作；
- 行操作：**编辑档案** ｜ **开通/管理登录**（弹窗复用 create_dept_user 语义：手机号+初始密码+角色+层级+报送权，员工/管理角色与 can_report 开关沿用人事中心统一逻辑）｜ **360 视图**；
- 「新增员工」= 建档案；账号开通是第二步动作（也可勾选"同时开通登录"一步完成）；
- 纯管理账号区块：无 employee_id 的 profiles 单独列表（新增/编辑沿用现有账号 RPC）。

### 360 视图（点员工打开）
- 基本信息 + 账号状态卡；
- 持证列表（实时查 certificates，90 天内到期标红，点击跳证照模块）；
- 培训汇总（任务完成/考试/学时，实时查询，不落副本）；
- 变更日志（personnel_change_logs）。

### 员工端「我的档案」
- registry 对 `employee` 角色渲染受限版：只读自己档案 + 自助改手机号/照片；
- 培训自助注册保留（注册即建档，现有 training_staff_register 不动）。

## 五、旧入口清理（与人员中心同批上线）

| 位置 | 动作 |
|---|---|
| 报送模块（Admin，含实体模式）→「账号管理」「部门管理」页签 | **删除**（RPC 保留，前端入口移至人员中心） |
| 培训教育 →「员工档案」页签 | **删除**（培训计划圈人/证照选人等只读引用不受影响） |
| registry | 新增 people 模块；admin 见完整中心，employee 见「我的档案」 |

## 六、权限矩阵（沿用三级树，不再发明新规则）

| 操作 | 公司级 | 实体/部门级 | 项目级 | 员工 |
|---|---|---|---|---|
| 部门树增删改 | ✅ | ❌（只读子树） | ❌ | ❌ |
| 本管辖树员工增删改/账号开通 | ✅ 全公司 | ✅ 子树 | 只读 | ❌ |
| 纯管理账号维护 | ✅ | ❌ | ❌ | ❌ |
| 查看任意 360 视图 | ✅ | ✅（子树） | ✅（子树） | ❌ |
| 查自己档案 / 改手机号照片 | — | — | — | ✅ |

## 七、实施分期

- **P1（本批）**：personnel-center-v1.sql（加字段+缝合迁移+自助 RPC）→ 人员中心前端（组织架构+员工台账+账号）→ 旧入口删除 → 回归脚本 verify-people.js
- **P2**：360 视图完善（培训/证照聚合）+ 员工端我的档案 + 变更日志展示
- **P3（远期，不承诺）**：特种作业到期预警（复用证照到期日）、项目部用工变更申请流

## 八、风险与兼容

1. **schema.sql 与线上库不同步**（role CHECK 还写着 reporter）：本设计只出增量 SQL，不重写 schema.sql；以 personnel-center-v1.sql 为准；
2. **缝合迁移的边界**：手机号匹配不上的 profiles 保持 NULL（成纯管理账号），**绝不**自动建档案——由管理员在人员中心人工认领；
3. **同手机号唯一**：员工改手机号走 RPC 唯一校验，撞号时提示占用人（复用 mapRpcError 的 idx_profiles_phone 翻译）；
4. 培训双通道（user_id 快照 + employee_id 实时绑定）不受影响，账号开通后培训记录自动续上（这正是 employee_id 关联的红利）。

## 九、决策记录（2026-09-01 用户确认）

1. 权威员工表：**改造 training_employees**（不新建表、不迁数据）；
2. 页面归属：**九宫格独立「人员与组织」模块**；
3. 账号关系：**账号是档案的可选开通**（1:0..1），允许无档案纯管理账号；
4. 新增字段：特种作业标记（证件复用证照模块）、岗级/职务、人员照片；
5. 权限：**沿用现有三级树**；
6. 自助：保留注册、可查自己档案、可改手机号+照片（直接生效+留痕）；
7. 旧入口：**删干净只留中心**；
8. 360 视图：**要做**。
