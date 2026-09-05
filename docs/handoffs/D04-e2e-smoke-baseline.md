# D04 冒烟与 E2E 基线交接

- 任务与泳道：D04，Web/后端；状态：`PASS`，D05 已解锁但未开始。
- 需求/验收：T25-A、D04-S01 至 D04-S12、D04-E2E-01 至 D04-E2E-04、D04-LIVE。
- 工作树与分支：`E:\codex\safety-web`，`track/web-backend`；起始 HEAD 为 D03 提交 `1038cb3`。
- 文件所有权：只包含 D04 测试、必要的既有测试脚本小修、基线文档和追踪状态；未修改 `miniprogram/**`，未纳入 `docs/plans/` 或未跟踪的 `AGENTS.md`。
- 接口/契约：D04 不冻结应用 API 契约；当前可用、失败和未完全到达的接口继续标记为 `draft`。
- 数据库：未修改业务 SQL、迁移、RLS 或统计 RPC。统计夹具只用于已确认的隔离测试数据库，执行后自动清理。

## 最终证据

1. 静态入口冒烟 PASS，12/12。
2. 最小真实首页/认证 E2E PASS，4/4：主页 HTTP 200、登录 HTTP 200、当前用户 HTTP 200 且身份匹配、退出 HTTP 204。
3. 统计 API 基线 PASS，12/12。`run-d04-stats-with-fixture.js` 自动复用 D02 匿名部门和人员、创建一个 `[D04-TEST]` 计划及两个跨部门任务、运行 `verify-stats.js`，并在 `finally` 中清理。
4. 清理断言为 `registry|plan|assignments|alerts|reads|targets=0|0|0|0|0|0`，本轮测试数据残留为 0。
5. 部门 API 基线仍为 3/7，人员 API 基线仍因 `profiles`、`departments`、`training_employees` 的 HTTP 403 / `42501` 失败。这两组结果如实保留为既有业务基线问题，未伪装为通过；D04 不负责修复。
6. R01 最终复查 PASS，No findings；两个 P1 均已闭环。
7. 全程未访问生产环境，日志和提交不包含密码、令牌、数据库连接串或真实个人数据。

## 运行边界与回滚

- 真实测试同时要求 `SAFETY_ENV=test`、API/数据库项目匹配，以及测试库存在 `D02-TEST-20260903` 标记；任一条件不满足即在认证请求前拒绝。
- 本机只配置变量名：`SAFETY_ENV`、`SAFETY_SUPABASE_URL`、`SAFETY_TEST_DB_URL`、`SAFETY_SUPABASE_ANON_KEY`、`SAFETY_TEST_ADMIN_EMAIL`、`SAFETY_TEST_ADMIN_PASSWORD`、`SAFETY_TEST_ENTITY_EMAIL`、`SAFETY_TEST_ENTITY_PASSWORD`。交接不记录变量值。
- 如需撤销 D04，应使用普通 Git revert 撤销 D04 提交；不得删除 D02 共享夹具或回退 D03 数据库基线。
- C01 状态：无新增跨线接口变更请求。

## R03 结论

- R01 已通过，R03 范围和提交前检查已完成，D04 正式标记为 `PASS`。
- D05 前置已满足并解锁；本交接不代表 D05 已开始。
