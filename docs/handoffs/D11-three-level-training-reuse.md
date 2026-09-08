# D11 三级安全教育培训包与一次性基础事实交接

## 最终业务范围

D11 将三级安全教育定义为正式内部员工在一段正式用工关系中的一次性入职基础教育事实，而不是年度任务或每次项目准入任务。换项目、项目重启、内部调动、跨经营实体和跨年度均不自动重做三级教育。项目入场教育、风险教育、专项培训和法规变化学习分别留给 D12-D18/D17。

- migration：v81、v82 保留历史兼容和考试安全修复；v83 `training-admission-v83-employee-three-level-foundation.sql` 落实最终语义。
- v83 TARGETED：29/29 PASS，覆盖附件要求的 30 项语义，residual=0。
- 正式人员分类不使用 `created_at`、profile 创建时间、项目首次出现或前端布尔值推断。
- 新员工判定来源为服务端正式 employment relation、唯一 `employment_relation_id`、hire/start date 和不可改审计；离职后新建关系才按重新入职处理。
- 当前 P0/P1：0/0。

## 权威人员与状态

`training_three_level_profiles` 保存当前可审计用工关系和三级分类：

- `formal_internal`：可进入 `new_hire`、`legacy_evidence_review`、`legacy_supplement`、`legacy_verified`、`completed` 或 `legacy_supplement_completed`。
- `contractor`、`temporary_individual`、`visitor`：员工三级教育不适用，不生成 company/entity/third 记录。
- 重新入职由受控分类 RPC 生成新的 `employment_relation_id`；旧关系记录不覆盖。
- 存量正式员工无可信证据时 fail closed 为 `legacy_evidence_review`，migration 不批量伪造完成。

只有授权管理员可以调用 `training_set_three_level_classification`。普通员工无表写权限，不能把自己标记为 completed、verified 或 not_applicable。所有分类变化进入不可改审计表。

## 老员工历史与补训

`training_confirm_legacy_three_level` 仅允许授权管理员确认可信历史，强制记录 evidence source、evidence date、reviewer、reviewed_at，可选 reference/notes；证据和审计不可修改或删除。

无完整证据的老员工进入 `legacy_supplement`，使用当前正式计划完成一次真实补训。完成时间、计划/课件版本、计划学时、D09 服务端有效学时均真实保存，最终状态为 `legacy_supplement_completed`，不伪造成原入职日期完成。

## 三级结构和历史

`training_three_level_records` 按当前 `employment_relation_id` 保存 company、entity、third 三条基础记录，并保留计划、课件、版本、计划/要求/有效学时和完成时间。

第三级必须显式选择：

- `basic_project`：绑定责任经营实体，`site_project_id/source_project_id` 为 NULL，适用于暂无实际项目；不代表完成未来项目入场教育。
- `actual_project`：必须绑定存在且有权限的正式项目；source project 永久只作为入职三级历史证据。

完成的记录不可修改或删除。计划上的 `third_level_mode` 在形成历史后不可更改。

## 项目准入与考试

v83 的项目 admission 只读取人员基础三级状态，不再为每个项目生成 company reused、entity reused、project required 行。已完成正式员工在项目变化、实体变化或跨年后仍满足基础三级前置。

外协、无单位临时个人和访客不会因 `missing_company/entity/third` 被错误判断；其中外协和临时个人返回 `three_level_not_applicable_use_project_admission_path`，且 D11 不把“不适用”伪装为全部上岗准入完成。访客继续 `visitor_safety_briefing_required`。

v82 的综合考试安全边界继续保留：综合考试 assignment 未绑定 admission 或发生歧义时 fail closed；正式内部员工未完成基础三级时考试前置拒绝；D09 有效学时、heartbeat、版本历史、Storage 和 RLS 不放宽。

## Web 与机器契约

管理端和员工端显示新员工、历史待确认、历史已确认、补训待完成、补训已完成和不适用项目准入路径。第三级明确显示“基本项目级”或“具体项目级 + 来源项目”。Web 只消费服务端总体状态。

机器契约：`docs/contracts/D11-three-level-training-v1.json`。

## 非阻塞后续项

- P2-01：重大课程或制度变化何时必须完整重训，未来需结合正式法规/制度形成可配置细化标准。
- P2-02：公司领导当前仍兼容精确岗位文字，后续应迁移到正式人员类别。
- P2-03：可继续增加浏览器 DOM 和更多历史导入边界覆盖。

FINAL runner 的复合退出码问题已关闭：`tools/run-d11-final.ps1` 不再使用 PowerShell 自动变量 `$Args` 作为自定义参数，并逐命令验证退出码，前序失败不能被后续成功覆盖。

## 验收结论

- migration/manifest/hash：v1-v83，83/83 PASS。
- D11 最终规则 TARGETED：29/29 PASS。
- D09 直接相关 regression：20/20 PASS，覆盖 effective hours、heartbeat、history/version、plan/course immutability、RLS 和 Storage 边界。
- D11 FINAL：PASS，总耗时 267.19 秒。
- residual：0；P0/P1：0/0；R01 缺陷已由 R02 和最终规则修正关闭。

## 下一任务输入

- D12：实现“项目 + 人员实际作业”触发的爆破、电工、焊工专项，以及 `includes_drilling=true` 时项目全部 active personnel 的钻探专项培训门禁；钻探不得要求虚构个人证照。
- D13：考试按正式内部员工、外协和 `temporary_individual` 的不同准入路径消费服务端培训前置。
- D17：按法规/制度要求配置年度或周期再培训，并处理法规/制度变化内容以及停工复工、岗位/工艺/设备变化等事件复训；不得实现成所有老员工每年重做三级教育。
- D18：统一汇总基础三级教育、周期/变化/事件培训、项目入场教育、专项培训/考试、签字、证照和现场确认，输出唯一上岗资格结果。
- D31：小程序项目申请兼容 contractor 和 `temporary_individual`，但 D11 未修改 `miniprogram/**`。
- 人员/准入后续任务：完善 `temporary_individual` 的责任经营实体、当前项目、接收/审核责任人和可审计用工/进场依据。

## 部署与回滚

v83 必须在 v1-v82 后连续应用，不回写旧 migration，不删除 v81/v82 历史。v83 对存量无证据人员只建立待审核分类，不确认完成。共享环境回滚必须新增向前 migration；不得删除三级完成记录、历史证据、审计或解除 RLS。
