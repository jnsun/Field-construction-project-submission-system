# 需求追踪矩阵

> 本矩阵从 P01 开始建立。后续任务按编号追加，不追溯改写已验收结论。

| 任务编号 | 原计划 | 任务名称 | 验收编号 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| P01 | T23-A | 小程序注册与合规资料并行准备 | P01-AC01 至 P01-AC04 | 已完成（资料初稿）；微信审核未开始 | [小程序注册与合规资料清单](miniprogram-registration-checklist.md) |
| D00 | — | 代码库只读盘点与现状清单 | D00-AC01 至 D00-AC04 | 已完成（静态盘点）；线上 Supabase 状态待专项核验 | [代码库盘点](00-codebase-inventory.md) |
| D01 | T01-T27 | 需求追踪矩阵与验收编号 | D01-AC01 至 D01-AC04；T01-AC01 至 T27-ACnn | 已完成（原计划已固化；双线泳道、前置门、契约、负责人、变更与合并字段已建立；业务实现状态仍待各任务回归） | [需求验收矩阵](01-requirement-traceability-matrix.md) |
| D02 | — | 安全开发基线、备份、测试环境与测试数据 | D02-AC01 至 D02-AC03 | 已完成（环境、匿名夹具、备份/清理基线、三工作树、文件所有权、交接和 C01 规则已建立；历史副本迁移与恢复完整性由 D03 验证） | [环境基线](02-local-test-environment.md)；[双线所有权](02-dual-track-ownership.md) |
| D03 | T24 | 数据库 v1-v16 升级与完整性验证 | D03-AC01 至 D03-AC04 | PASS（可重复 v0 匿名历史状态已真实重放至 v50；迁移账本、历史指纹、应用范围归档、首次/重复恢复、RLS/RPC/函数/触发器与 Storage 应用配置均通过；R01复查和R03交接已完成） | [数据库迁移验证](03-database-migration-verification.md)；[D03 交接](handoffs/D03-database-verification.md) |
| D04 | T25-A | 现有业务基线冒烟与端到端测试骨架 | D04-S01 至 D04-S12、D04-E2E-01 至 D04-E2E-04、D04-LIVE | PASS（静态入口 12/12、真实首页/认证 E2E 4/4、统计 API 12/12；可重复夹具清理残留为 0；部门与人员 API 的 403/42501 保留为既有业务基线；R01、R03 已完成，D05 已解锁但未开始） | [D04 基线报告](04-e2e-smoke-baseline.md)；[D04 交接](handoffs/D04-e2e-smoke-baseline.md) |
| D05 | T19、T26-A | 安全、隐私、RLS、导出与二维码基线审查 | D05-AC01 至 D05-AC19 | PASS（FINAL 6/6 PASS，R01 PASS / No findings，R03 已完成；P0=0、P1=0、P2=4、P3=1。v51/v52、角色/RLS、统计函数、私有桶、匿名签名 URL、敏感 RPC、秘密扫描及最小跨项目/跨经营实体边界均通过；四个 P2 和一个 P3 继续登记，四个 P2 仍阻塞完整业务试点。安全基线门 G0 已 PASS，D06 已解锁但未开始） | [D05 安全基线](05-security-baseline.md)；[D05 交接](handoffs/D05-security-baseline.md) |
| D06 | T01 | 正式项目台账回归与补缺 | D06 项目编号、经营实体、状态、申请边界和状态历史验收 | PASS（FINAL 五组全部通过，R01 PASS，R03 已完成；v53-v57 连续且校验和一致，测试数据残留为 0） | [D06 交接](handoffs/D06-project-ledger.md) |
| D07 | T02 | 项目角色与准入权限边界 | 项目经理/安全员授权、人数限制、撤权即时生效、跨项目/跨实体权限验收 | PASS（业务提交 `6ceb5a4ea3338fd812c774e5ae6cea18dd506bd0`；v58-v68 与 7 个专项测试已纳入该提交；本次仅补审计交接，未重跑或伪造 D07 测试） | [D07 交接](handoffs/D07-project-role-permissions.md) |
| D08 | T03 | 外协单位与人员档案闭环 | 外协单位/人员历史、安全身份、加入审核、项目作业、合同资质证照与文件权限 | PASS（迁移连续至 v73；necessary FINAL 与最终独立 R01 均 PASS，P0=0、P1=0；G1-master-data-api-v1 已冻结。R01-D08-09 保持 P2/deferred，R01-D08-10 由 R03 状态证据收口关闭） | [D08 交接](handoffs/D08-contractor-personnel-archive.md)；[G1 冻结契约](contracts/G1-master-data-api-v1.json) |
