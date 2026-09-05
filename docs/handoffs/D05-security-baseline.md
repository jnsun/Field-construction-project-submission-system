# D05 安全基线交接（PASS）

- 发起泳道：Web/后端
- 工作目录：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 验收时 HEAD：`1ab08dbfdae7c6cd69f20ce07d8094cd601e0135`（本轮改动未提交）
- 需求/验收：T19、T26-A；D05-AC01 至 D05-AC19
- 最终结论：`PASS`；D05 状态 `PASS`
- 风险计数：P0=0、P1=0、P2=4、P3=1

## 文件与接口边界

- `miniprogram/**` 未修改；`docs/plans/**` 未处理。
- 未新增第二套 API 或迁移清单，C01 状态为无。
- Web 仍复用现有 Supabase REST、Storage 和 RPC 契约；本轮新增的是验收脚本，不是业务接口。
- legacy API Key 迁移属于正式上线前部署事项，不属于 D05 P1；本轮未轮换密钥、未修改 JWT Signing Keys。

## 数据库变化

- v51 为 `profiles`、`departments`、`training_employees` 补充 authenticated 最小表级权限，RLS 保持开启。
- v52 撤销 10 个 `stats_*` 函数的 PUBLIC/anon EXECUTE，仅向 authenticated 暴露 8 个 Web 外部 RPC。
- 最终验收确认 v51、v52 权威清单哈希及隔离测试库实际状态通过。

## 最终验收记录

首次 FINAL 的历史结果保留如下：

- 入口：`node tests/e2e/run-d05-final-acceptance.js`
- 总耗时：内部 19.405 秒；外层 19.571 秒。
- 当时结果：5 个套件中 4 个通过、1 个失败。
- 通过：断言自测 6/6；现有角色/RLS 负向 API 8/8；统计函数权限 8/8；秘密扫描 0 项；私有桶、Storage RLS、匿名签名 URL、匿名导出/二维码/邀请码函数边界通过。
- 失败套件：D05 final security areas，13 项通过、3 项失败。
- 失败 1 是验收器误报：`rls_auto_enable()` 固定 `search_path=pg_catalog`，不是不安全路径。
- 失败 2 是夹具缺口：4 个测试项目全部属于同一经营实体，没有实体管理员范围外项目，也没有项目经理/安全员第二项目账号。
- 失败 3 是验收器范围假设错误：`departments` 目录按既有设计允许 authenticated 全读；业务数据隔离应以人员/项目 RLS 判断，现有跨实体人员读取已被过滤。
- 按当时约束未立即重跑完整验收，首次结论保持 FAIL。

随后按授权定向修复上述三项验收阻塞：定向测试 9/9 通过，临时夹具清理残留为 0。修正后的 FINAL 内部耗时 35.271 秒、外层 35.374 秒，6 个套件全部通过：

- 断言自测、角色/RLS 负向 API、统计函数权限、跨范围阻塞回归、最终安全区域、秘密扫描均 PASS。
- 合法项目范围访问成功，跨项目访问被过滤或拒绝，跨经营实体导出被 403/42501 拒绝。
- v51/v52、SECURITY DEFINER、私有文件、匿名 RPC、浏览器服务端秘密边界均通过；测试数据残留为 0。
- 当前结论为 D05 FINAL `PASS`，D05 状态为 `PASS`。

## 未完成风险与试点门

1. P2：导出字段与角色矩阵未完整验收；阻塞试点；后续 T19。
2. P2：最小跨项目/跨经营实体边界已通过，但员工、项目经理、安全员、外协完整负向 RLS 矩阵仍未完成；阻塞试点；后续 T26。
3. P2：二维码/邀请码过期、撤销、项目状态即时失效和限流未做攻击型 E2E；阻塞试点；后续 T16/T26。
4. P2：Storage 上传、读取、签名 URL、撤销未做完整角色矩阵；阻塞试点；后续 T10/T19。
5. P3：当前未使用服务端 Cookie；未来引入时需补 Cookie 安全属性测试；不阻塞试点。

## 环境、安全与回滚

- 仅使用 `SAFETY_ENV`、`SAFETY_SUPABASE_URL`、`SAFETY_SUPABASE_ANON_KEY`、`SAFETY_TEST_DB_URL` 及匿名测试账号变量名；本文不记录任何值。
- 共享隔离门禁和 D02 夹具标记均通过，未访问生产环境。
- 本轮没有生产发布；仅在隔离测试库写入最小临时夹具，并在 `finally` 清理且确认残留为 0，无需生产回滚。

## R03 最终签收

- FINAL 6/6 PASS；R01 PASS / No findings；R03 已完成。
- P0=0、P1=0、P2=4、P3=1；四个 P2 与一个 P3 保留并已登记。
- v51/v52、RLS、跨项目/跨经营实体隔离、SECURITY DEFINER、`stats_*` 权限、Storage/签名 URL、二维码/邀请码及秘密扫描结果均已纳入最终证据。
- legacy API Key 迁移保持为正式上线前部署事项，不属于 D05 P1；未修改 JWT Signing Keys。
- 未访问生产环境，未修改 `miniprogram/**`。

## 下一任务前置

D05=`PASS`，安全基线门 G0=`PASS`，D06 已解锁但本轮未开始。
