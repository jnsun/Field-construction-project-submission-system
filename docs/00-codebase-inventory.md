# D00：代码库只读盘点与现状清单

> 盘点日期：2026-09-03
>
> 盘点范围：`training-module` 分支的工作区内容。除本文和需求追踪矩阵外，本任务不改动业务代码、SQL 迁移或部署配置。
> 结论性质：代码库静态盘点，不替代对已部署 Supabase 实例、Storage 桶、RLS 实际启用状态或微信平台后台的现场核验。

## 一、目录与技术栈

```text
project-reporting/
├── index.html                         静态网页入口
├── css/                               5 个业务样式文件
├── js/                                41 个原生 JavaScript 文件
│   └── modules/{report,qualification,training,people,stats}/
├── vendor/                            随站点发布的 Supabase、PDF、Excel、二维码库
├── sql/                               80 个手工执行的 SQL 文件
├── tests/                             静态审计、浏览器 E2E 和人工测试页
├── tools/course-generator.html        HTML 课件生成器入口
├── deployment/                        腾讯云自托管 Supabase/Nginx 脚本与说明
├── .github/workflows/pages.yml        GitHub Pages 工作流
├── deploy.sh / deploy.bat             静态文件部署脚本
├── README.md                          月报系统初始化与使用说明
└── HANDOFF.md                         培训模块交接、迁移顺序和已知风险
```

| 层次 | 实际技术与入口 | 结论 |
| --- | --- | --- |
| 前端 | 原生 HTML/CSS/JavaScript；[index.html](../index.html) 以传统 `<script>` 顺序加载全局模块 | 没有 React、Vue、TypeScript 或打包器 |
| 后端 | 未发现仓库内自建 API、Node/Python 服务、Supabase Edge Function 或后端目录 | 业务服务由 Supabase Auth、PostgREST、RPC 承担 |
| 数据库 | PostgreSQL/Supabase；[sql/](../sql/) 中的手工 SQL 脚本 | 无 `supabase/migrations/`、迁移清单或自动迁移器 |
| 认证 | [js/auth.js](../js/auth.js) 调用 Supabase `signInWithPassword`；支持邮箱和“手机号转内部登录别名 + 密码” | 不是微信登录，也没有短信 OTP 集成 |
| 文件存储 | Supabase Storage：`certificates`、`training-courses`；前端以短时签名 URL 访问 | 相关定义位于证照、在线培训及准入补丁 SQL |
| PDF / 二维码 | `vendor/pdf.min.js`、`vendor/jspdf.umd.min.js`、`vendor/qrcode-generator.js` | 用于课件/PDF预览、报表和二维码核验 |
| Excel | `vendor/xlsx.full.min.js` | 用于员工/业务数据导入导出 |
| 定时任务 | 未发现 `pg_cron`、GitHub Actions 定时工作流或服务器 cron 配置 | 培训提醒目前由管理端 RPC 手动生成，不会自动在每日 9 点执行 |
| H5 | 同一套静态网页可在手机浏览器打开；未发现独立 H5 工程目录 | 需后续按小程序/H5 适配任务处理 |
| 小程序 | 未发现 `miniprogram/`、微信 SDK、AppID 配置或回调服务 | P01 仅完成资料准备，未开始接入 |

### 版本、依赖与命令

- 未发现 `package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、Docker Compose、Supabase CLI 配置或环境变量示例文件。
- 第三方库均以 `vendor/` 本地压缩文件直接引用；仓库没有可核验的统一依赖版本清单，因此不将库版本臆测为事实。
- 仓库未提供 `start`、`build`、`lint`、类型检查或自动迁移命令。静态站点可由 GitHub Pages 发布，或按 [deployment/README-DEPLOYMENT.md](../deployment/README-DEPLOYMENT.md) 部署到 Nginx。
- 已有测试命令：`node tests/audit-handlers.js`。浏览器端脚本还依赖本机 Chrome 调试端口 `127.0.0.1:9333` 及本机 Playwright 路径，详见第五节。

## 二、已实现功能定位

| 功能 | 前端页面/入口 | 数据表或 Storage | RPC / 权限与策略 | 现有测试/证据 |
| --- | --- | --- | --- | --- |
| 月度野外项目报送 | `js/modules/report/{reporter,admin}.js` | `project_reports`、`project_types`、`report_fields`、`department_month_status` | `schema.sql`、`form-config.sql`、`project-status.sql` 等 RLS/RPC | `README.md`；未发现专用自动化 E2E |
| 组织、账号、手机号登录 | `js/auth.js`、`js/account.js`、`js/modules/people/people.js` | `departments`、`profiles`、`training_employees`、`personnel_change_logs` | `account-rpc-v2.sql`、`personnel-center-v1.sql`、`phone-password-login-v3.sql` | `tests/e2e/verify-dept-fix.js`、`verify-people.js` |
| 资质证照 | `js/modules/qualification*.js` | `certificate_types`、`certificates`、`certificate_files`、`certificate_trainings`、`certificates` 桶 | `certificate-management.sql`：RLS、Storage 策略、管理 RPC | 未发现独立自动化回归脚本 |
| 培训计划、员工、记录 | `js/modules/training/{training,plans,records,employees}.js` | `training_plans`、`training_records`、`training_participants`、`training_exams` | `training-management.sql`、`training-fix-v13.sql` | `tests/training-test.html`、`docs/training-test-report-20260831.md` |
| 课程库、在线学习、断点 | `js/modules/training/{courses,mine}.js` | `training_courses`、`training_library`、`training_assignments`、`training_course_progress`、`training-courses` 桶 | `training-online-v2.sql`、`training-content-library.sql` | `tests/training-test.html`、`tests/e2e/test-courseware-runtime.js` |
| HTML 课件生成 | `tools/course-generator.html` | 生成后上传 `training-courses` 桶 | `training-html-course.sql` 放开 HTML 课程类型 | `tests/e2e/build-sample-course.js`、`test-html-inject.js` |
| 题库、试卷、考试、签字 | `js/modules/training/{questions,papers,exams,mine}.js` | `exam_questions`、`exam_papers`、`exam_attempts`、`exam_wrong_book`、`training_signatures` | `exam-module.sql`、`exam-fix-v1.sql` 的 SECURITY DEFINER RPC 与 RLS | `tests/training-test.html`、`tests/audit-handlers.js` |
| 项目准入、三级教育、外协 | `js/modules/training/admission-*.js`、`contractors.js`、`projects.js` | `site_projects`、`site_project_members`、`contractor_*`、`training_admissions`、`training_admission_*`、`project_join_*` | `training-admission-v1.sql` 至 `v47.sql` | `tests/audit-handlers.js`；未发现完整准入 E2E |
| 项目二维码核验、临时通行、访客 | `admission-verify.js`、`admission-visitors.js` | `training_temporary_access`、`training_visitor_safety_notices`、`training_verification_logs` | 准入 `v5`、`v11`、`v14`、`v32` 等 RPC/策略 | 静态审计；未发现核验 E2E |
| 固定报表、统计与预警 | `admission-reports.js`、`js/modules/stats/stats.js` | `stats_settings`、`stats_cert_targets`、`stats_alerts`、`stats_alert_reads` | `statistics-module.sql`、准入报表 RPC | `tests/e2e/verify-stats.js` |

## 三、SQL 迁移范围与顺序风险

### 3.1 范围

- [sql/schema.sql](../sql/schema.sql) 是月报基础表、触发器、视图和基础 RLS 的起点。
- 培训底座的交接文档声明顺序为：部门树/权限和账号补丁后，`training-management.sql` → `training-fix-v13.sql` → `training-online-v2.sql` → `training-content-library.sql` → `exam-module.sql` → `training-html-course.sql`。
- 准入模块有 [training-admission-v1.sql](../sql/training-admission-v1.sql) 至 `training-admission-v47.sql` 共 47 个连续编号脚本；部分脚本会替换同名函数或策略。
- 证照、人员中心、统计等模块各有独立 SQL；迁移后端文档还要求补跑 `certificate-management.sql` 以创建桶记录与 Storage 策略。

### 3.2 事实与风险

1. 没有自动迁移器、数据库版本表、校验哈希或“已执行记录”。`sql/` 仅按文件名存放，文件系统排序会把 `v10` 排在 `v2` 前，不能作为执行顺序。
2. 80 个 SQL 文件大多带有 `IF NOT EXISTS`、`DROP ... IF EXISTS` 或 `CREATE OR REPLACE`，但并非可据此确认任意顺序均安全；函数签名、返回类型和策略替换仍有顺序依赖。
3. 部署文档是“云端导出后还原到自托管库”的迁移方案，不等同于开发环境的一键增量升级方案。
4. 线上已执行到什么版本只能通过 Supabase SQL Editor/数据库对象核验，仓库本身无法证明。

## 四、T01-T27 原计划定位

仓库未保存 T01-T27 的原计划定义或验收说明，全文检索也没有发现可可靠对应的任务代码；`_t_summary_compact.js` 中的 T10-T22 是旧月报表格断言标签，不能当作本计划任务。为避免猜测，下表仅记录可定位事实。

| 原计划编号 | 页面/接口 | 表/函数/策略 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| T01 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T02 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T03 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T04 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T05 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T06 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T07 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T08 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T09 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T10 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T11 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T12 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T13 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T14 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T15 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T16 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T17 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T18 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T19 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T20 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T21 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T22 | 未发现 | 未发现 | `_t_summary_compact.js` 有无关旧断言标签 | 不可靠，未映射 |
| T23 | [P01 清单](miniprogram-registration-checklist.md) | 无代码实现 | 无需代码测试 | 仅定位到 T23-A 资料准备；T23-B 未开始 |
| T24 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T25 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T26 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |
| T27 | 未发现 | 未发现 | 未发现 | 未发现原计划定义 |

## 五、测试与发布现状

| 类别 | 实际入口 | 可执行性 | 说明 |
| --- | --- | --- | --- |
| 静态代码审计 | `node tests/audit-handlers.js` | 可执行 | 检查 JS 语法、HTML 引用、内联事件和前端 RPC 是否在 SQL 中定义；运行机须将 Node 放入 PATH |
| 人工培训测试 | `tests/training-test.html` | 手工 | 列出培训模块用例及 SQL 前置条件 |
| HTML 课件单测 | `tests/e2e/build-sample-course.js` | 可执行但会写生成样本 | 不应作为只读盘点的本轮命令 |
| 浏览器 E2E | `tests/e2e/test-html-inject.js`、`test-courseware-runtime.js` | 当前受限 | 依赖 Chrome 调试端口 `127.0.0.1:9333` 与绝对路径 Playwright 依赖 |
| 远程数据库回归 | `verify-dept-fix.js`、`verify-people.js`、`verify-stats.js` | 当前不执行 | 需要测试账号/环境变量；部分脚本另有内联配置风险，不能用于无隔离的生产验证 |
| CI/CD | `.github/workflows/pages.yml` | 存在 | `training-module` 推送后部署 GitHub Pages；未发现 CI 测试步骤 |
| 正式部署 | `deployment/`、`deploy.sh` | 存在 | 腾讯云 Ubuntu、自托管 Supabase、Nginx；脚本默认限制非 main 分支部署 |

## 六、Git、生成物与配置风险

### 6.1 工作区状态（盘点时）

- 当前分支：`training-module`。
- 已有未提交改动：`docs/training-test-report-20260831.md`、3 个 E2E 验证脚本，以及多份未跟踪的 E2E HTML/PDF/XLSX/PNG/调试脚本和两份培训设计文档。
- 本轮不修改、暂存或回退上述文件；它们不应被自动混入 D00 提交。
- 发现大文件：`vendor/pdf.worker.min.js`、`vendor/xlsx.full.min.js`，以及未跟踪的 `tests/e2e/.enhanced-pre.html`。前两者为发布时必需的供应商文件；后者应在后续清理生成物任务中决定是否保留。

### 6.2 秘密与配置风险（只列路径，不记录值）

1. [js/config.js](../js/config.js) 存在直接写入前端的 Supabase 配置字面量。
2. `tests/e2e/cleanup-e6-testdata.js`、`verify-dept-fix.js`、`verify-people.js`、`verify-stats.js` 存在内联远程 Supabase 配置或回退配置。
3. 未发现 `.env.example`、`.env.sample` 或集中配置说明；`.gitignore` 也没有忽略 `.env*`。
4. 未发现仓库内 `SERVICE_ROLE_KEY` 的直接字面量；部署脚本会在服务器侧生成密钥，真实值不在本盘点文档中。

## 七、风险清单与建议执行顺序

| 编号 | 风险 | 证据 | 影响 | 建议后续任务 |
| --- | --- | --- | --- | --- |
| D00-R01 | 前端和测试脚本存在内联 Supabase 配置 | 第六节路径 | 配置轮换、环境隔离和误用生产库风险 | 先做配置与密钥治理；轮换受影响凭据后移除内联值 |
| D00-R02 | 无受版本控制的迁移执行器 | 80 个 SQL 文件、无 migrations/manifest | 新环境易漏跑或乱序，函数/RLS 可能不一致 | 建立迁移清单、执行记录和验证脚本，再进行新库部署 |
| D00-R03 | `training_admission_notification_settings` 在 SQL 中未发现显式 RLS 声明 | `training-admission-v15.sql`、v26/v27 | 需核验线上是否因控制台选项已启用；新库可能暴露或阻断访问 | RLS 专项审查：核验表状态、策略、授权角色并补可重复迁移 |
| D00-R04 | 大量 SECURITY DEFINER RPC | 70 个 SQL 文件包含声明 | 函数权限边界或 `search_path` 不一致会扩大影响面 | 对准入、人员、账号、考试 RPC 做权限矩阵和匿名/已登录角色回归 |
| D00-R05 | 自动化测试不在 CI 中运行 | Pages 工作流未发现测试步骤 | 发布可能绕过语法、RPC 和关键流程回归 | 先将静态审计加入 CI；再建立隔离 Supabase E2E 环境 |
| D00-R06 | 浏览器 E2E 依赖开发机绝对路径和调试端口 | `tests/e2e/*.js` | 可移植性差，难以稳定复现 | 后续测试基建任务改为项目内依赖和统一启动命令 |
| D00-R07 | 未发现小程序工程、回调服务或定时调度 | 第一节 | P01 之后无法直接上线微信登录、订阅消息或每日提醒 | 先完成域名/主体审核，再单独实施小程序接入与调度服务 |
| D00-R08 | Node 未进入系统 PATH，静态审计会产生 41 个“找不到 node”的假失败 | 本轮首次审计结果 | 本地测试结果不稳定，容易误判为语法问题 | 固化项目运行时或在测试启动脚本中显式设置 PATH |

建议顺序：先处置 D00-R01 至 R03（配置、迁移、RLS 基线），再处理 D00-R05 至 R06（可重复测试）；之后才进入微信接入、H5/小程序适配及自动提醒任务。这样不会把生产数据、身份资料和上岗资格建立在无法复现的配置上。

## 八、D00 验收记录

| 验收编号 | 验收点 | 状态 | 证据 |
| --- | --- | --- | --- |
| D00-AC01 | 目录、技术栈、入口与启动/测试命令已盘点 | 通过 | 第一、第五节 |
| D00-AC02 | SQL、Storage、部署、CI/CD 和环境变量示例情况已核对 | 通过 | 第一、三、六节 |
| D00-AC03 | T01-T27 已逐项定位；没有定义的任务明确标记未发现 | 通过 | 第四节 |
| D00-AC04 | Git 状态、生成物、配置风险和执行建议已登记 | 通过 | 第六、七节 |

## 九、未在本任务实施的后续事项

- 不修改或轮换任何配置值、密钥、RLS、Storage 策略或 SQL。
- 不执行生产数据库 SQL、远程回归脚本或文件删除。
- 不将 P01 的小程序资料准备误记为微信审核、微信登录或小程序开发完成。
