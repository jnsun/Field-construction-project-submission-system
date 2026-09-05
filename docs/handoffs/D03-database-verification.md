# D03 数据库验证交接

- 任务与泳道：D03，共享基础；状态：`PASS`，D04 前置已满足。
- 需求/验收：T24、D03-AC01 至 D03-AC04。
- Web/后端：`E:\codex\safety-web`，`track/web-backend`。
- 数据库：仅 `SAFETY_ENV=test`、`D03_TEST_ONLY` 和 D02 匿名夹具标记的 Supabase 测试项目；未操作生产库。

## FINAL 运行证据

1. TARGETED：`targeted-20260904231643/short-path-20260904231655-c575b8ed/summary.json` 状态为 `passed`；v1-v50 迁移账本恰好 50 条，源库和恢复库均成功清理。
2. FINAL：`DisposableReplay-20260904234033-c16fc959/result.json` 状态为 `passed`，总时长 1,987.883 秒；源库和恢复库均成功清理，临时数据库残留为 0。
3. 可重复 v0 匿名历史状态经 v1-v16 后，继续执行 v17-v50；迁移账本为 50 条，重复迁移已验证，19 个历史业务数据指纹一致。
4. FINAL 应用范围归档为 597,338 字节，SHA-256 为 `8266AE1D8AA8B60729764098FAAF4BB66E9AF9FAAED8913FEEE911803E6BE5A7`；878 条目录项中 `auth`、`storage` 和其他 Supabase 平台对象均为 0。
5. 两次无人干预恢复均通过：534 个结构对象、19 个数据指纹、22 个 RLS 表、53 条策略、12 个函数、13 个触发器、51 个索引、133 条约束；3 个私有应用桶和 22 条 Storage 应用策略一致。
6. 注册触发器 `auth.users.on_auth_user_created` 在首次和重复恢复后均存在、启用且只有一个，指向 `public.handle_new_user()`；匿名用户探针能够自动建立 `profiles` 记录并回滚。
7. `notification-settings-rpc-20260904231645/result.json` 已验证 `training_admission_notification_settings` 启用 RLS、无 anon/authenticated 直表读写，以及公司级 RPC 的正负权限、范围参数和输入校验。
8. 最终受限 R01 复查为 `PASS`，未发现阻止 D03 通过的 P0/P1 问题；D03 日志秘密扫描为 0，且未访问生产环境。

## 边界与限制

- D03 负责 `public` 应用数据/结构，以及由版本控制 SQL 重建的 3 个私有桶和 22 条 Storage 应用策略。
- D03 不覆盖 `auth`、Storage 平台内部对象、`storage.objects` 元数据或真实文件字节；INF02 的 Storage 文件字节灾备仍为独立后续任务，不阻塞 D04。
- 完整角色穿透、导出、二维码、签字和业务 API 攻击面仍属于 D05。小程序继续仅使用 Mock 和匿名测试数据。

## R03 交接结论

- R01 已通过，R03 交接已完成，D03 正式标记为 `PASS`。
- T24 数据库升级与完整性验证门已通过，D04 前置已满足；本交接不代表 D04 已执行。
