# D08 外协单位与人员档案闭环交接（PASS）

- 发起泳道：Web/后端
- 工作目录：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 开发基线 HEAD：`198c36c4c22a2584223027d8a3c34d11c0f34bd0`
- 需求/验收：T03；外协单位、人员、关系、申请、证照与附件全生命周期档案
- 当前结论：D08 necessary FINAL 与最终独立 R01 均为 `PASS`，P0=0、P1=0；本交接随 D08 R03 独立提交生效，D08 状态为 `PASS`
- 接口契约：[G1-master-data-api-v1](../contracts/G1-master-data-api-v1.json)，状态为 `PASS / FROZEN`

## 迁移与核心对象

- v69：`contractor_company_versions` 不可变版本；外协单位创建、修改、审核 RPC；直接 UPDATE/DELETE 边界收紧。
- v70：`training_employee_versions`、`site_project_member_assignment_history`；身份证密文与私有 HMAC 匹配；人员创建/修改、完整身份读取、单位关系修改和重新审核 RPC/RLS。
- v71：复用 `project_join_applications`，补 `project_join_application_events`、审核路径、申请周期、活动申请唯一索引、行锁和 advisory lock；首次/同实体跨项目/跨实体由服务端判定。
- v72：`contractor_contract_versions`、`contractor_document_versions`；合同、资质和证照受控创建/审核/撤销；项目成员 `special_work_types` 历史；项目 `includes_drilling`；Storage 业务记录绑定读取和归档文件防覆盖/删除。
- v73：撤销普通客户端对 `site_project_members` 的直接 INSERT/UPDATE/DELETE，正式审核 RPC 仍可建立成员关系。
- 部署时必须按 v69、v70、v71、v72、v73 顺序应用；任何版本进入共享迁移账本后不得改写，只能新增连续迁移。

## 数据、隐私与权限

- 外协单位当前表继续供业务读取，旧版本永久保存在 `contractor_company_versions`。客户端创建、修改和审核统一走受控 RPC；普通客户端不能直接覆盖或删除主数据。
- `training_employees.id_number` 不再保存明文。身份证使用 Vault 内服务端密钥进行 AES-256 对称加密，并用同一私密密钥生成 HMAC-SHA-256 匹配标识；密文、私有 HMAC 和 Vault 信息不向普通客户端返回。
- 完整身份证仅由 `training_employee_identity_get`、`training_join_application_identity` 在公司级或明确经营实体维护权限下返回；项目经理或安全员身份本身不授予全文读取权。
- 人员关键字段、工种和所属单位改变形成不可变快照/关系历史，并触发既有 `training_personnel_reapproval_requests`；重复同值修改返回 `changed=false`，不会无限生成重复历史或复审任务。
- RLS、列级授权、受控 RPC 和固定 `search_path` 的 `SECURITY DEFINER` 共同执行跨项目、跨实体和撤权边界；未关闭 RLS，未扩大 authenticated 表写权限。

## 加入申请与幂等

- `site_project_apply` 只接受有效、未撤销、未过期且项目为 `active` 的邀请码；暂停、待关闭和关闭项目不能发起新申请。
- 无既有安全身份为 `first_project/pending_project_review`；同经营实体跨项目为 `same_entity_cross_project/pending_entity_review`；跨经营实体为 `cross_entity/pending_entity_review`。客户端不参与路径判断。
- 同项目的私有身份活动申请和同账号活动申请分别有唯一索引；申请 RPC 以全局身份、项目身份和项目申请人 advisory lock 串行化。相同申请重试返回原 application ID。
- 审核锁定申请行并重新检查当前权限；同动作重复审核返回 `changed=false`。安全身份匹配优先复用现有人员；项目成员以项目+人员唯一关系防止重复创建，原项目和原经营实体历史不被覆盖。

## 作业、证照与钻探纠偏

- 人员持证与项目实际安排彻底分离。项目成员 `special_work_types` 默认空，仅允许显式选择 `爆破`、`电工`、`焊工`，支持多选和取消并留历史；持有证书不会自动启用作业。
- 证照门禁只检查本项目已启用的人员级作业。未启用时返回 `not_required`，已有过期证照也不阻断普通岗位；启用后才区分 `valid/missing/pending/expired/revoked`。
- 钻探不是人员证照类型。项目级权威字段是 `site_projects.includes_drilling`；`training_project_drilling_training_scope` 为 D12 返回项目全体当前成员的钻探专项培训范围输入，不检查“钻探证”。

## 合同、资质、证照与 Storage

- 合同、资质和个人特种作业证保留当前元数据与不可变版本；创建、审核、撤销/终止走受控 RPC，历史表禁止普通 UPDATE/DELETE。
- 个人 `certificate_type` 仅允许 `爆破`、`电工`、`焊工`，并记录审核状态、有效期和业务绑定的 Storage 路径。
- `certificates` 桶保持私有。读取必须同时通过当前业务记录和项目/实体权限；跨项目、跨实体或撤权后拒绝。已归档业务文件不能由普通客户端覆盖或删除。
- Web 通过 Storage `createSignedUrl` 申请 300 秒签名 URL；交接和契约不包含真实 URL、密钥或文件内容。

## Web、FINAL 与审查证据

- 直接相关页面已切换到外协单位、人员、加入审核、合同/资质/证照和项目作业受控 RPC，并展示服务端状态、审核路径及最小身份信息。
- D08 necessary FINAL：migration PASS；D08-1 17/17、D08-2A 19/19、D08-3 27/27、D08-4 36/36、特殊作业/钻探 19/19，测试残留为 0。
- 最新 G1 contract TARGETED：23/23 PASS。最终独立 R01：PASS；R01-D08-01～08 全部 CLOSED，P0=0、P1=0。
- R01 登记的两个 P2：R01-D08-09（`employee_self_profile` 仍查询已清空的旧身份证字段）保持 `P2 / deferred`，交后续人员档案回归任务；R01-D08-10（状态证据停留 PARTIAL）由本 R03 文档收口关闭。

## 跨线输入、回滚与后续边界

- D12：只消费 `includes_drilling` 和 `training_project_drilling_training_scope` 生成钻探项目全员专项培训；人员证照门禁只消费显式 `special_work_types`。
- D30：微信身份绑定必须走服务端安全身份机制；不得取得或提交私有 HMAC，不得把姓名+手机号当权威唯一身份。
- D31：必须调用 G1 的申请/审核 RPC，服务端决定审核路径，重复扫码/弱网重试依赖数据库幂等；小程序不得直接写业务表。
- C01 状态：无。未修改 `miniprogram/**`。
- 若迁移尚未应用，可撤回未提交 D08 文件；若已应用到共享环境，不得删除历史表、档案或改写迁移，应以新迁移向前修正。
- G1 后续消费者为 D12、D30-BE、经后端契约接入的 D30-MP 和 D31；修改冻结契约必须保持向后兼容，或显式升级契约版本。
- 本交接不授权开始 D09、D12、D30 或 D31；下一步仅为完成本次 R03 提交与安全同步。
