# D02 共享基线交接

- 任务与泳道：D02，共享基础
- 需求/验收：D02-AC01 至 D02-AC03
- Web/后端：`E:\codex\safety-web`，`track/web-backend`
- 小程序：`E:\codex\safety-mini`，`track/miniprogram`
- 集成：`E:\codex\safety-integration`，`integration/dual-track`
- 契约版本：未冻结；D04 完成前仅允许 Mock 和匿名测试数据。

## 已交付

1. 三工作树和三条长期分支已建立，文件所有权见 [D02 所有权基线](../02-dual-track-ownership.md)。
2. 测试环境使用匿名 `D02-TEST` 夹具；备份、恢复和受控清理步骤见 [本地测试环境](../02-local-test-environment.md)。
3. 小程序发现服务端缺口时使用 C01；不得改数据库、RLS、Web/H5 或复制服务端规则。

## 给小程序线的输入

- 可读取 D02 所有权与 C01 文档；只在 `miniprogram/**` 开发。
- 当前没有冻结 API 契约、生成类型或正式 Mock，不能接入真实人员、培训、资格或文件数据。
- 需要服务端变化时创建 C01 申请；使用匿名 Mock 或隐藏未解锁功能作为临时处理。

## 回滚与前置

- 本任务仅新增治理文档和静态验证，无数据库、RLS、部署或业务代码变化；回滚可单独还原本任务提交。
- D03 可开始验证 v1-v16 迁移；D04/D05 的既有缺口仍独立存在，G0 未放行。
