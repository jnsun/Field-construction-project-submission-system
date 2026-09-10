# D13 综合准入考试与专项考试交接

## 基本信息

- 阶段：`D13｜综合准入考试与专项考试`
- 泳道：Web/后端（数据库、migration、RLS、Auth、RPC、权限、状态机和 machine contract 的唯一权威来源）
- 工作区：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 最终 migration：v97
- 最终状态：`D13 = PASS / R01 COMPLETE / R02 COMPLETE / R03 COMPLETE`

## D13 核心考试能力

服务端通过 `training_exam_start/get/submit/report_switch` 统一发卷、计时、评分和固化结果。每次 attempt 固化 admission、项目、人员、考试类型、专项类型、exam plan、题目与选项顺序、内部正确答案、规则版本、开始/截止/提交时间、分数和结果。正确答案不下发；客户端不能指定得分、结果、次数或终态。

服务端强制 attempt 次数上限、并发开始保护和幂等提交。到达服务端截止时间即超时，已提交或超时的终态结果不可覆盖。支持正式员工综合准入考试、独立的项目入场考试和专项考试；D13 只记录考试事实，最终上岗资格仍由 D18 汇总。

## 配置驱动三级教育（S3-A～S3-D）

三级教育使用统一组织机构、scheme/version、applicability rule、服务端 resolver、不可变 Requirement Snapshot 和 explain/simulator。公司管理员可通过后台配置不同部门或组织的三级教育方案、培训包、方案版本、适用范围和生效时间，不需要为每个部门重新修改代码。

S3-D 已完成 D11 production cutover：新产生的正式员工三级教育 requirement 由服务端按当前权威组织归属和已发布方案生成快照。D13 仅消费 D11 返回的 authoritative prerequisite，不自行解析组织、方案、阶段或培训包。

## 三级教育关键规则

- 正式员工在一段权威 `employment_relation` 内只完成一次基础三级教育；换项目、跨年度或内部组织变化不重做。重新入职建立新的 employment relation 后重新生成 requirement。
- 第二级统一为“所属组织级教育”，不固定为经营实体级。
- 第三级支持 `department_position`、`logistics_position`、`entity_position`、`basic_project`、`actual_project`；其中 `actual_project` 必须绑定权威实际项目。
- `project_induction` 独立于基础三级教育，不能合并或替代三级教育。
- contractor、`temporary_individual`、visitor 不进入 employee three-level；外协和临时个人走项目准入，访客走安全告知。

## Requirement Snapshot 规则

- 正式 snapshot 只能由服务端权威流程产生，普通客户端不能指定 scheme、package 或 `as_of` 冻结事实。
- 已生成的 V1 snapshot 不被未来 V2 改写；未来新员工可按生效规则使用 V2。
- 已发布培训包内容不可原地增删改；变化必须创建新版本，历史 snapshot 继续引用原版本。
- explain/simulator 只做预览和解释，不创建正式 snapshot。

## D12 / D13 专项考试规则

爆破、电工、焊工只由 `project + person actual special work` 触发，持证本身不触发。钻探由项目级 drilling requirement 触发，不要求个人“钻探证”；钻探培训始终 required，考试是否 required 由权威参数控制。

专项考试完成事实按 `admission + project + person + special_type + exam plan` 精确隔离。项目 A 的 PASS 不能满足项目 B，不同专项类型和不同计划的结果也不能互相替代。

## 参数、账号与隐私规则

系统参数采用 stable parameter/version、effective date、服务端审批和永久审计。需要审批的版本执行 maker-checker；未来版本在生效日前不影响当前有效值。考试配置范围为题数 10–100、时长 10–120 分钟、及格线 60–100、次数 1–10；新参数不改写历史试卷和 attempt 快照。

普通业务账号管理不再物理删除稳定主体，使用 `disable`、`freeze`、`restore`、`close`，并保留历史业务事实和审计。普通台账、CSV、打印和普通导出默认脱敏；完整资料专用导出留给 D22 独立实现。

## R01 / R02 收口

- R01：`FAIL — requires R02`，发现 P0=0、P1=10。
- R02-1：关闭旧物理删除旁路、project-person authorization、raw snapshot generator、entity scope 和 exam context authorization；26/26 PASS。
- R02-2：关闭 published package immutable、参数未来生效行为、权威参数审批、专项考试项目隔离和 scheme version chronology；25/25 PASS。
- R01 原 P1 已关闭 10/10。
- FINAL 后 P1-11 数据库约束漂移由前向 migration v97 纠偏并关闭。
- D12 regression fixture 已按 v96 后权威考试和参数审批模型兼容，blocker 已关闭；它是旧测试夹具问题，不是产品 P1。
- 当前 P0=0、P1=0。

## 最终验收证据

- migration verifier：97/97 PASS。
- V1.1 compatibility：31/31 PASS。
- D11 foundation：29/29 PASS；D11 reuse：29/29 PASS。
- S3-A：41/41 PASS；S3-B：44/44 PASS。
- S3-C TARGETED：11/11 PASS；S3-C Web smoke：42/42 PASS。
- S3-D：42/42 PASS。
- R02-1：26/26 PASS；R02-2：25/25 PASS。
- D12：62/62 PASS。
- D13 authoritative exams：41/41 PASS。
- Contract：6/6 PASS。
- `residual=0`；`process residual=0`；active/non-idle psql query=0。
- R02 后必要 FINAL 的已通过项目、D12 focused 修复后的 62/62 和 D13 FINAL remainder 41/41 共同组成完整验收证据链。

## 保留边界与后移项

- 未修改 `miniprogram/**`，未实现 D18 资格汇总，未开始 D14。
- parameter audit 后台查询体验增强、contract 测试进一步增强仍作为非阻塞 P2/P3 后移；本次 R03 不声称已完成。
- v1-v96 不回写；后续数据库变化继续新增 migration。
