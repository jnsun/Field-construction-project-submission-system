# D07 项目角色与准入权限边界交接（PASS）

- 发起泳道：Web/后端
- 工作目录：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 业务提交：`6ceb5a4ea3338fd812c774e5ae6cea18dd506bd0`
- 需求/验收：T02；项目经理、安全员授权范围、人数限制、撤权即时生效和跨项目边界
- 最终结论：D07 已按既有验收结论标记 `PASS`；本文件仅补齐审计交接，不重做 D07，不把 D08-5 的静态核验记作 D07 测试
- 接口契约：已纳入冻结的 `G1-master-data-api-v1`；D08 FINAL 与最终独立 R01 均已 PASS

## 业务与权限交接

- 项目角色仅允许 `project_manager`、`safety_officer`；每个项目最多两名有效项目经理，安全员不设同等人数上限。
- `site_project_set_roles` 是角色授权和撤销的受控入口。主责经营实体管理员只能在服务端允许的项目及账号范围内维护角色，客户端不能通过直接写表扩大权限。
- 授权边界由 v58/v59 校验被授权人与授权人，v60 强制项目经理人数上限，v61 留存角色相关操作审计。
- v62-v67 收紧项目读取、经营实体管理读取、公司级读取、RPC EXECUTE 和项目写权限；跨项目及跨经营实体请求由数据库权限/RLS/RPC 拒绝。
- 撤权不依赖会话缓存：受保护操作每次读取 `site_project_roles.active`，撤权后新请求立即失效。
- v68 保留项目状态、准入重算和申请附件上传边界，并保持暂停、待关闭和关闭项目不能继续开放申请或刷新邀请码。

## 迁移与测试证据

- 连续迁移：`training-admission-v58-project-role-assignee-boundary.sql` 至 `training-admission-v68-recompute-and-join-upload-boundary.sql`。
- D07 业务提交包含以下实际专项测试：`d07-role-assignee-boundary.js`、`d07-role-assigner-boundary.js`、`d07-project-manager-limit.js`、`d07-role-revocation-immediate.js`、`d07-cross-project-boundary.js`、`d07-role-permission-matrix.js`、`d07-company-read-management-split.js`。
- D07 的 PASS、R01/R03 和提交结论沿用已完成阶段证据；D08-5 没有重新运行这些测试，也没有伪造新的计数或耗时。

## 文件、安全与回滚

- D07 业务提交未修改 `miniprogram/**`；本交接不包含账号、密码、令牌、数据库连接串或真实个人数据。
- 若尚未应用迁移，可回退对应业务提交；若 v58-v68 已进入共享迁移账本，不得改写历史迁移，只能用后续连续迁移纠正。
- C01 状态：无。本交接补齐后，D07 审计记录与仓库实际 PASS 提交一致。
