# D12 高风险专项培训与实际作业门禁交接

- 正式任务：`D12｜高风险专项培训与实际作业门禁`
- 执行泳道：`Web/后端`
- 工作区：`E:\codex\safety-web`
- 分支：`track/web-backend`

## 业务范围与权威触发

D12 以“正式项目 + 当前人员实际作业”为爆破、电工、焊工专项门禁的唯一触发依据。持有证书、岗位名称或历史材料均不得自动触发实际作业。钻探只读取项目权威字段 `site_projects.includes_drilling`，覆盖项目全部 active 人员，不要求或接受虚构的个人钻探证。

- migration：v84 `training-admission-v84-special-work-requirements.sql` + R02 v85 `training-admission-v85-d12-r01-p1-fixes.sql`，连续接在 v1-v83 后，不回写 v84。
- 实际作业可多选爆破、电工、焊工；支持 enable/disable、active/inactive、取消、永久历史、操作者、变更时间、原因、幂等重试和并发串行化。
- 适用人员包括正式内部员工、项目经理、安全员、外协人员和无单位临时个人。
- `site_project_can_manage` 是维护实际作业和钻探属性的服务端权限边界；公司只读、本人自选和跨项目修改均拒绝。
- D12 原 TARGETED：47/47 PASS；R02 三项 P1 定向测试：12/12 PASS；均 `residual=0`。

## 证书、培训和考试链

爆破、电工、焊工使用当前人员的精确证书类型，并核验审核通过、未撤销和当前有效；不做模糊匹配，焊工证不能替代电工证。v84 将既有受控证书登记 RPC 扩展至项目内正式员工和临时个人，同时保留项目管理权限、private Storage 路径绑定、审核与撤销规则。内部/临时人员不得伪关联外协单位。

每个专项类型必须精确映射同 `special_type` 的专项培训计划，并使用已发布专项培训计划和已发布试卷所属考试计划。v85 在配置 RPC、表触发器和运行时查询三层拒绝 null/错类型映射；旧错误映射不自动修正，直接 fail closed。缺映射、培训计划未发布、缺已发布试卷、培训未完成、考试未通过均 fail closed。D12 只保存考试计划前置和消费考试结果，不实现 D13 考试引擎。

统一状态 RPC：

- `training_current_special_requirements(project_id, employee_id)`：本人或项目管理读取单人状态。
- `training_project_special_requirements(project_id)`：管理端读取项目 active 人员状态。
- `training_special_requirements_internal`：服务端内部统一计算证书、培训、考试和原因码。
- `training_set_member_special_work_types`：带行锁、原因、操作者和幂等的实际作业维护。
- `training_set_package_special_requirements`：原子替换专项培训/考试映射。

## 历史、RLS 与审计

`training_special_work_audit_logs` 按专项类型记录启用/取消、操作者、操作者角色、时间和原因。v85 新增不可因账号删除而丢失的 `operator_subject_id` UUID 快照：账号删除时实时 FK `operator_id` 可变为 null，但主体快照、角色、时间和原因保持不可变；普通用户不能篡改。取消当前专项只把对应 admission task 标记为 inactive，不删除既有 assignment、完成记录或历史。v85 同时撤销 `anon`/`authenticated` 对 7 张 D12 权威核心表的 `TRUNCATE` 权限；表权限、RLS、RPC 和 REST 负向链路均保持 fail closed，未关闭或放宽 RLS。

## Web 与机器契约

管理端可查看项目全员服务端状态、维护三类实际作业、维护项目钻探属性，并查看证书/培训/考试阻塞原因；员工端只消费本人当前项目的统一状态。培训包页分别配置四类专项的培训计划和考试计划。

机器契约：`docs/contracts/D12-special-work-requirements-v1.json`，供 D13、D18、D32、D33 消费。原因码和字段由服务端产生，客户端不得自行推断上岗资格。

## 验收与当前状态

- migration/manifest/hash：v1-v85，85/85 PASS；v85 SHA-256 `786AF3CB739F0AE7C6874B5C9A4E74E2189D5202ED3AA37798FF1269E34992BA`。
- R02 TARGETED：三项 P1 关闭测试 12/12 PASS（71.80 秒）；D07 任命权限 12/12 PASS（34.50 秒）；D08 专项人员/证照 23/23 PASS（35.61 秒）；D09 专项计划 10/10 PASS（69.31 秒）；全部 residual=0。旧 D07 大矩阵夹具仍使用不符合当前 D08 约束的外协申请数据，归入既有 P2-03 额外覆盖/测试夹具后移，不影响本轮聚焦权限回归证据。
- 测试基础设施修复：D08 回归不再向当前库重放 v72，而是先确认当前 v84 专项能力；D02 admin/entity 测试账号由同一组环境变量确定性重置密码并核对权威角色。定向验证为 schema/bootstrap 3/3、Auth 6/6（admin/entity 登录成功，错误密码仍拒绝），合计耗时 11.91 秒。
- R01：`FAIL — requires R02`。发现 P1-01 专项类型与培训计划类型未精确匹配、P1-02 `anon`/`authenticated` 持有核心表 `TRUNCATE`、P1-03 账号删除会使操作者实时 FK 丢失。
- R02：三个 P1 全部关闭。P1-01 由配置 RPC、数据库触发器和运行时查询共同执行精确 `special_type` 匹配；P1-02 撤销两类客户端角色对 7 张 D12 核心表的 `TRUNCATE`，实际查询 `grants=0`；P1-03 新增不可变 `operator_subject_id` UUID 快照，删除测试用户后仍保留。
- 必要 FINAL：PASS，总耗时 581.66 秒。migration/manifest/hash、Web/测试语法、contract JSON、D08 回归 23/23、D11 回归 29/29、D09 回归 10/10 + 10/10、D12 动态 59/59 和 diff-check 全部通过；各动态测试 residual=0，最后一组动态测试明确确认数据库保留 v85 修复对象。
- 当前 P0/P1：0/0；residual=0。
- P2-01：机器契约列有 `drilling_training_required`，服务端当前返回通用 `special_training_required`；后移。
- P2-02：机器契约测试深度仍可增强；后移。
- P2-03：重新 active、角色撤销即时拒绝、`temporary_individual` 完整负向链，以及旧 D07 大矩阵与当前 D08 约束的历史夹具兼容仍可增强；后移。
- 上述 P2 不阻塞 D12，未升级为 P1。
- 当前状态：`D12 = PASS / R01 COMPLETE / R02 COMPLETE / R03 COMPLETE`；P0=0，P1=0，migration=v85。本轮不开始 D13。

## 回滚和后续输入

v84 必须在 v1-v83 后应用，v85 必须紧随 v84；均不得回写。共享环境需要回退时新增向前 migration；不得删除实际作业审计、历史 assignment、培训完成或证书审核记录。

- D13：消费 `exam_plan_id`、专项要求和 fail-closed 原因码，实现考试引擎，不得重新推断实际作业。
- D18：汇总 D11 基础三级、D12 专项证书/培训/考试与后续签字、现场确认，形成唯一上岗资格结果。
- D32/D33：只按 D12 机器契约接入，不复制 Web 判断逻辑。
- 本交接不授权开始 D13，也未修改 `miniprogram/**`。
