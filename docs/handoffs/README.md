# 跨线交接目录

本目录保存已验收任务的不可变交接记录。它不是业务代码、数据库迁移或 API 契约的替代品。

## 文件规则

- 使用 `<任务编号>-<简短主题>.md`，例如 `D02-shared-baseline.md`。
- 每份记录必须写明：发起泳道、工作树、分支、HEAD、需求/验收编号、文件所有权检查、接口/契约版本、数据库变化、测试、环境变量名称、回滚、C01 状态和下一任务前置。
- 发布后不得覆盖历史记录；更正或后续结论另建新文件并链接旧记录。
- 交接不得包含真实密码、Cookie、AppSecret、访问令牌、数据库连接串、身份证号或真实测试资料。

## 写入边界

Web/后端、小程序和集成线只能创建自己发起的交接文件，不应并发编辑同一文件。跨线接口缺口不在本目录讨论，必须按 [C01 模板](../changes/C01-template.md) 在 `docs/contracts/change-requests/` 创建申请文件。

## 当前交接

- [D02 共享基线](D02-shared-baseline.md)
- [D03 数据库验证](D03-database-verification.md)
- [D04 冒烟与 E2E 基线](D04-e2e-smoke-baseline.md)
- [D05 安全基线（PASS）](D05-security-baseline.md)
- [D06 正式项目台账（PASS）](D06-project-ledger.md)
- [D07 项目角色与准入权限边界（PASS）](D07-project-role-permissions.md)
- [D08 外协单位与人员档案闭环（PASS）](D08-contractor-personnel-archive.md)
- [G1 主数据 API v1（PASS / FROZEN）](G1-master-data-api-v1.md)
