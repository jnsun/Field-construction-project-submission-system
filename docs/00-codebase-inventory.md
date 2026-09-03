# D00：代码库只读盘点与现状清单

盘点日期：2026-09-03

盘点工作树：`E:\codex\safety-web` / `track/web-backend`

基线提交：`20b4034`（D02 双线所有权基线）；D03 的后续验证证据见 `docs/03-database-migration-verification.md`。

本文件是当前检查点的静态事实基线，不替代 Supabase 平台、Storage、微信公众平台或生产环境的现场验收。D00 仅更新文档，不修改业务代码、SQL 迁移、RLS 或部署配置。

## 1. 目录和技术栈

```text
project-reporting/
├── index.html                         静态 Web/H5 入口
├── css/                               页面样式
├── js/                                42 个原生 JavaScript 文件
│   ├── config.js                      运行时 Supabase 配置读取
│   └── modules/{report,qualification,training,people,stats}/
├── vendor/                            本地 Supabase、PDF、Excel、二维码库
├── sql/                               90 个手工 SQL 与兼容/加固脚本
├── tests/                             静态审计、D03/D04/D05 和人工测试入口
├── tools/                             本地启动、备份、恢复和课件生成工具
├── deployment/                        自托管 Supabase/Nginx 部署材料
├── .github/workflows/pages.yml        GitHub Pages 部署
├── .env.example                       本机测试变量名称示例
├── README.md                          原月报系统说明
└── HANDOFF.md                         既有培训模块交接说明
```

| 层次 | 实际技术与入口 | 当前结论 |
| --- | --- | --- |
| 前端/Web/H5 | 原生 HTML、CSS、JavaScript；入口 `index.html` | 无 React、Vue、TypeScript 或打包器；同一站点承担桌面与手机浏览器界面。 |
| 后端 | Supabase Auth、PostgREST、PostgreSQL RPC、Storage | 未发现仓库内 Node/Python API、Edge Function 或独立后端服务。 |
| 数据库 | `sql/` 手工脚本；`training-admission-v1-v16.manifest.json`、`training-admission-v17-v49.manifest.json` | v1-v49 有受校验清单和验证工具；完整 SQL 集合仍没有统一增量迁移器。 |
| 认证 | `js/auth.js`、Supabase `signInWithPassword` | 当前为邮箱/手机号映射密码登录；不是微信登录或短信 OTP。 |
| 文件存储 | Supabase Storage | 证照、课程、签字等文件路径与策略由 SQL/RPC 管理；测试库已核验桶为私有。 |
| PDF/二维码/Excel | `vendor/pdf.min.js`、`jspdf.umd.min.js`、`qrcode-generator.js`、`xlsx.full.min.js` | 本地库用于课件、报表、凭证与导入导出，不依赖外部二维码服务。 |
| 定时任务 | 管理端 RPC、部署脚本 | 未发现 `pg_cron`、GitHub Actions 定时工作流或已验收的每日提醒调度。 |
| 小程序 | 当前仓库没有 `miniprogram/` | 小程序工作树为 `E:\codex\safety-mini`；Web/后端线不得修改其目录。 |

## 2. 依赖、配置、部署和测试

- 未发现 `package.json`、锁文件、Docker Compose 或项目内依赖安装命令；第三方浏览器库以 `vendor/` 本地文件提供。
- `.env.example` 仅列出 `SAFETY_*` 变量名称和占位值；`.gitignore` 忽略 `.env*`、备份及本机 `js/config.runtime.js`。
- `js/config.js` 只读取部署生成的运行时配置；GitHub Pages 工作流从 Actions Secrets 生成 `js/config.runtime.js`。真实值不在仓库中。
- `deployment/` 包含腾讯云自托管 Supabase/Nginx 的脚本与说明；GitHub Pages 工作流只负责静态部署，尚未运行自动化测试。
- 可重复的当前检查入口：

```powershell
node tests/audit-handlers.js
node tests/verify-d03-migration-files.js
$env:SAFETY_ENV = 'inspection'; node tests/e2e/d04-smoke.js
node tests/e2e/d05-security-baseline.js
```

浏览器 E2E 仍依赖本机 Chrome 调试端口和 Playwright 环境；D04 实时 API 测试只允许在隔离测试库且 `SAFETY_ENV=test` 时运行。

## 3. 数据库和迁移范围

1. `schema.sql` 是月报基础表、触发器、视图和基础 RLS 的起点。
2. 培训底座包含组织、账号、在线学习、题库考试和人员中心脚本；准入主链为 `training-admission-v1.sql` 至 `v47.sql`。
3. D03 manifest 固化 v1-v16 的顺序、SHA-256 校验和和空库 bootstrap 文件；`tests/verify-d03-migration-files.js` 验证它们。
4. v48 修复项目删除审计触发器的历史外键冲突；v49 收紧高权限函数默认授权、固定搜索路径并锁定签字记录。
5. D03 已完成匿名 v17 前副本的 v17-v49 迁移、账本幂等与应用范围恢复验证；v1-v16 匿名历史副本重放及托管 Supabase 的全自动恢复仍未验收。

## 4. 功能与需求定位

T01-T27 的唯一验收编号、角色、正常/异常路径、测试与试点门以 [D01 需求追踪矩阵](01-requirement-traceability-matrix.md) 为准。D00 不重复定义业务规则。

| 功能范围 | Web/H5 定位 | 数据库/RPC 范围 | 当前测试证据 |
| --- | --- | --- | --- |
| 月度项目报送与组织账号 | `js/modules/report/`、`js/auth.js`、`js/modules/people/` | `project_reports`、`profiles`、`departments`、人员 RPC | `verify-dept-fix.js`、`verify-people.js`；实时基线仍有缺口。 |
| 培训、课程、考试、签字 | `js/modules/training/`、`tools/course-generator.html` | `training_*`、`exam_*`、Storage 与相关 RPC | `audit-handlers.js`、人工测试页；完整 E2E 未验收。 |
| 项目准入、外协、资格、二维码 | `admission-*.js`、`contractors.js`、`projects.js` | `site_*`、`contractor_*`、`training_admission_*` | D04 静态 12 项；D05 负向 API 5 项。 |
| 固定报表、统计、提醒 | `admission-reports.js`、`stats.js`、`admission-operations.js` | 报表/统计/提醒 RPC | `verify-stats.js` 当前未通过完整实时基线。 |

## 5. 当前 Git 与双线状态

| 工作树 | 分支 | 状态 | 所有权 |
| --- | --- | --- | --- |
| `E:\codex\safety-web` | `track/web-backend` | D02 基线为 `20b4034`；D03 取证改动待独立提交；任务包文档可保持未跟踪 | 数据库迁移、RLS、服务端规则、共享契约、Web/H5、部署。 |
| `E:\codex\safety-mini` | `track/miniprogram` | D02 当前基线为 `4014821` | 小程序客户端及 `miniprogram/**`。 |
| `E:\codex\safety-integration` | `integration/dual-track` | D02 当前基线为 `f6c7745`，仅接收已验收提交 | 契约合并、联合测试和发布。 |
| `E:\codex\safety\project-reporting` | `training-module` | 不属于本工作树的未提交材料仍保留 | 不得在未审查前混入双线分支。 |

`docs/02-dual-track-ownership.md`、`docs/handoffs/` 和 C01 变更申请目录已由 D02 建立。当前没有冻结 API 契约，因此小程序仍只可消费 Mock 与匿名测试数据。

## 6. 风险清单与建议顺序

| 编号 | 优先级 | 风险 | 影响 | 后续任务 |
| --- | --- | --- | --- | --- |
| D00-R01 | 已解决 | D01 矩阵已包含执行泳道、前置门、契约版本、跨线负责人、变更单和合并状态 | 以矩阵追踪接口变更 | D01 |
| D00-R02 | 已解决 | D02 已建立文件所有权、正式交接目录和 C01 机制 | 小程序仍不得消费未冻结接口 | D02 |
| D00-R03 | P1 | D03 已完成 v17-v49 匿名副本、对象/数据指纹与应用范围恢复验证；v1-v16 匿名历史副本及 Supabase 全量恢复仍缺证据 | 迁移不能视为完整通过 | D03 |
| D00-R04 | P1 | D04 没有版本化机器可读 API 契约、类型和 Mock | 小程序不能安全消费真实接口 | D04 |
| D00-R05 | P1 | D05 仍要求轮换历史暴露的浏览器密钥，并验证 v17-v47 与完整角色矩阵 | G0 不得放行 | D05 |
| D00-R06 | P2 | Pages CI 未运行静态、数据库或权限测试 | 发布可能绕过回归 | 后续 CI/发布任务 |
| D00-R07 | P2 | 现场签字、导出、二维码重放/限流与各角色 RLS 尚未完整验收 | 资格与个人信息保护不足 | T19、T26 |
| D00-R08 | P2 | 未验收自动提醒调度和微信回调服务 | 不能声称每日提醒或小程序消息已可用 | D23、D28-BE |

建议顺序：继续关闭 D03 的匿名历史副本与托管恢复缺口，再按 D04、D05 的未完成证据逐项关闭。G0 未通过前，小程序只能使用 Mock 与匿名测试数据。

## 7. D00 验收记录

| 验收编号 | 验收点 | 状态 | 证据 |
| --- | --- | --- | --- |
| D00-AC01 | 目录、技术栈、入口和命令已按当前检查点盘点 | 通过 | 第 1、2 节 |
| D00-AC02 | SQL、Storage、部署、测试与环境示例已核对 | 通过 | 第 2、3 节 |
| D00-AC03 | T01-T27 的权威定位已指向 D01 矩阵 | 通过 | 第 4 节 |
| D00-AC04 | Git、工作树、生成物边界和风险已登记 | 通过 | 第 5、6 节 |

## 8. 本任务未实施事项

- 不修改数据库、RLS、Storage、部署配置或小程序目录。
- 不轮换平台密钥、不执行生产 SQL、不创建测试数据。
- 不把工作树创建、资料准备或静态检查误记为 G0 通过、微信审核通过或小程序可接入真实数据。
