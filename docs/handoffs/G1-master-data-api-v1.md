# G1 主数据 API v1 契约交接（PASS / FROZEN）

- 发起泳道：Web/后端
- 工作目录：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 开发基线 HEAD：`198c36c4c22a2584223027d8a3c34d11c0f34bd0`
- 覆盖范围：D06 项目台账、D07 项目角色权限、D08 外协单位与人员档案
- 机器契约：[G1-master-data-api-v1.json](../contracts/G1-master-data-api-v1.json)
- 当前状态：`PASS / FROZEN`；D08 necessary FINAL 与最终独立 R01 均为 PASS

## 契约边界

- 单一权威源为上述 JSON 契约，直接对应现有 PostgREST 表读取、数据库 RPC、RLS 和 Storage policy；仓库此前没有 OpenAPI、generated types 或 Mock 管线，本轮没有新建平行生成体系。
- 契约冻结项目状态、项目实体、项目角色、外协单位、人员脱敏/受控身份、人员单位关系、加入申请状态机、项目成员实际作业、项目级钻探、合同/资质/证照历史和文件访问。
- 当前数据库没有独立域错误码字段。契约按真实实现记录 HTTP/SQLSTATE、原始数据库消息和状态字段；`project_paused` 与 `project_closed` 通过 `site_projects.status` 区分，申请拒绝消息当前相同。
- 重复申请返回原 application ID；重复同动作审核在重新校验权限后返回 `changed=false`；私有身份 HMAC、活动申请唯一索引、行锁/advisory lock 和项目+人员唯一关系共同保证幂等。
- 默认接口不得返回身份证全文、密文、私有 HMAC、Vault 信息、service role 或 Storage 内部秘密。完整身份只能走契约标注的敏感 RPC，项目角色本身不授予该权限。

## 后续任务消费规则

- D12 读取 `site_projects.includes_drilling` 和 `training_project_drilling_training_scope`。钻探覆盖项目所有当前成员，不存在“钻探证”；爆破/电工/焊工只检查项目成员显式启用项。
- D30-BE 只能使用服务端受控身份绑定；D30-MP 经后端契约接入，不得获取/提交私有 HMAC，不得以姓名+手机号作为唯一身份依据。
- D31 调用 `site_project_apply` 与 `site_project_review_application`，不在客户端判断首次、同实体或跨实体；扫码重试依赖服务端幂等，不直接写表。
- 后续修改 G1 必须向后兼容，或显式升级契约版本。

## 敏感资料导出后续规则

- 普通页面、报表、CSV 和打印永远脱敏；安全员永远只能批量取得脱敏资料。
- 项目经理、经营实体管理员和公司安全生产部的普通报表同样脱敏。后续 D22 可另建受审计的完整资料批量导出通道，并分别限制在本人管理项目、本经营实体或公司级授权范围。
- D22 专用通道必须与普通报表分离，并由服务端重新鉴权，记录导出用途和审计，使用短时文件/下载权限；D08 不实现该能力。

## 测试、发布与回滚

- D08 necessary FINAL：migration、D08-1、D08-2A、D08-3、D08-4、特殊作业/钻探与 G1 均 PASS；最新 G1 TARGETED 为 23/23 PASS，测试残留为 0。
- 最终独立 R01 为 PASS，P0=0、P1=0；R01-D08-01～08 全部 CLOSED。契约随 D08 R03 独立提交正式冻结。
- R01-D08-09 保持 P2/deferred；R01-D08-10 由本 R03 状态证据收口关闭。
- 契约本身无数据库回滚动作。若实现发生向前迁移，更新契约前必须先以新的连续迁移修正实际接口，不得让契约描述错误行为。
- 环境变量只记录现有测试变量名称，不记录值：`SAFETY_ENV`、`SAFETY_SUPABASE_URL`、`SAFETY_TEST_DB_URL`、`SAFETY_SUPABASE_ANON_KEY`。
- C01 状态：无；未修改 `miniprogram/**`。
