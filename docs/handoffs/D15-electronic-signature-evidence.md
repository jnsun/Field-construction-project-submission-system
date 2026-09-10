# D15 电子签字与永久证据链交接

## 基本信息

- 阶段：`D15｜电子签字与永久证据链`
- 泳道：Web/后端；数据库、RLS、RPC、权限、状态机、Storage 绑定和 machine contract 是唯一权威来源
- 前置：D11、D13；D14 已取消，不再是前置
- migration：v98-v106
- 当前状态：`D15 = PASS / R01-R03 COMPLETE`
- 正式审查：R01 发现 8 个 P1；R02-1、R02-2A、R02-2B 已全部关闭；R03 由本提交完成

## 治理决定

D14 已标记为 `CANCELLED / REMOVED FROM SCOPE`。随机确认题、防代学 confirmation challenge 不开发，不标记为 PASS；后续对应依赖为 `NOT APPLICABLE / REMOVED`。

D15 的签字是系统内部电子手写签字和业务证据，不宣称自动具有任何特定法律意义上的高级或合格电子签名效力。

## 权威数据与流程

- `training_signature_policies`、`training_signature_policy_versions`、`training_signature_policy_nodes` 保存公司管理员配置的受控策略、版本、节点和生效日期。
- 仅允许员工阶段确认、员工最终确认、所属组织负责人确认、项目经理或安全员确认四类节点；不支持自由脚本或 BPMN。
- policy version 生命周期为 draft、published、retired；published 不可原地修改。future V2 生效前 V1 继续有效，已有 V1 requirement 不被 V2 改写。公司管理员仅通过受控 RPC 配置策略。
- 服务端依据人员、稳定主体、用工关系或 admission、D11 Requirement Snapshot、当前 policy/version 及项目/组织上下文幂等创建 `training_signature_requirements`，并冻结节点、顺序、签字人角色和作用域。策略不能取消必需培训或精确 D13 考试硬前置，签字也不替代培训或考试事实。
- 正式签署使用 `prepare → 私有 Storage 上传 → submit`。prepare 返回短时 challenge、服务端证据摘要和不可预测的新对象路径；submit 再验证人员、角色、scope、前置、digest、nonce 和文件绑定。
- `training_signature_results` 保存唯一正式结果。数据库禁止改写或删除正式签字；重大变化通过 `training_signature_supersede_cycle` 保留旧结果并建立完整新周期。

## 权限与 ANY_OF

- 员工只能签自己的 employee requirement。
- organization responsible 的权威模型是 `stable subject + organization_unit + organization_responsible + 有效期`，统一支持 internal department、logistics center、operating entity 和 other internal unit；撤销后新请求立即失去签字权。company admin 不自动成为组织签字人，legacy entity_admin 仅桥接自己的 operating entity。
- 项目经理或安全员按 D07 当前项目角色签署；`ANY_OF` 由一条 requirement 表达，首位合法签字人完成后不再生成第二份完成事实。
- company read 不自动获得签字权。requirement/result 查询按本人、组织、项目或公司管理读取权限裁剪。

## 证据摘要和身份

服务端使用 PostgreSQL JSONB canonical representation 和 SHA-256 生成摘要，绑定人员稳定主体、用工关系或 admission、D11 snapshot、方案/培训包发布版本、完成事实、精确 D13 authoritative attempt/result、requirement、policy/version、签字人稳定主体/角色/scope/display、权威文件验证事实和唯一服务端 `signed_at`。同一个 `signed_at` 原子写入 canonical evidence、digest 和 signed result；客户端设备时间不能控制正式时间，也不能提交分数、完成状态、版本、角色或 digest 内容。

签字永久保存稳定 subject、最小 display、角色和 scope 快照；登录账号 disable/close 或以后删除登录身份，不影响历史签字身份。

## Storage 与隐私

- 路径：`training-admission/signature-evidence/{requirement}/{challenge}/{uuid}.{png|jpg|jpeg}`，一次签署一个新对象，禁止覆盖。
- `supabase/functions/d15-validate-signature/` 从私有 Storage 受控读取文件，执行超时和最大 2 MiB 限制、PNG/JPEG magic bytes、实际 decode、宽高、字节数及 SHA-256 校验；不信任客户端 MIME、metadata 或 user_metadata，SVG/HTML/XML/伪造头拒绝。
- 权威验证事实写入不可变 `training_signature_file_validations`；普通客户端不能创建或篡改 validation。
- 普通客户端无签字对象 UPDATE/DELETE 权限；读取必须先通过业务记录权限，再生成短时 signed URL。
- 普通 requirement/history 响应不返回完整身份证或原始图片；D22 必须消费本契约的受控文件访问。
- v102 已撤销 authenticated 对旧表 `training_signatures`、`training_admission_signatures` 的直接写权限，以及旧 RPC `training_submit_signature(UUID,TEXT,TEXT)`、`training_admission_sign(UUID,UUID,TEXT,TEXT,TEXT,TEXT)` 的执行权限。

## Web

培训中心新增“电子签字”入口，支持服务端摘要展示、Canvas 手写、提交前清空、受控 PNG 上传、正式提交、已签只读、历史和管理确认。公司管理员可查看策略、创建/编辑 draft、配置受控节点、发布、新建版本和 retire。页面不自行判断签字完成或 signer 权限。

## Machine contract

稳定契约：`docs/contracts/D15-electronic-signature-evidence-v1.json`。覆盖 policy/version、requirement、prepare/upload/submit/result、digest、signer identity、ANY_OF、supersede、幂等、权限、原因码和文件访问，供 D16、D17、D18、D21、D22 和 G2 使用。

## Supersede 与不可变历史

权威 source event 触发重签时，服务端按当前 authoritative Snapshot/policy 重建完整 required node set，并关联 previous/new cycle；旧 result、签字图片、digest、policy/version、signer、`signed_at` 和审计永久保留。同一 source event 幂等，并发只生成一个 successor；普通员工不能任意触发 supersede。账号 disable、freeze 或 close 不改变历史 signer stable identity。

## 验收证据

- migration verifier：106/106 PASS；D15 dynamic：66/66 PASS；R02-1：7/7 PASS。
- R02-2A 短连接专项：Organization 10/10、Supersede 12/12 PASS；R02-2B 与真实图片 decode 7/7 PASS。
- Contract 23/23、Web 11/11、Edge Function Deno/type check、signed_at canonical digest、Storage/privacy/old RPC 全部 PASS。
- D09 history/package 11/11、Storage 15/15；D11 foundation 29/29、reuse 29/29；D13 authoritative exams 41/41；D07 permission matrix 14/14，全部 PASS。
- 全部 fixture residual=0；测试进程 residual=0；active/non-idle test query=0；`git diff --check` PASS。
- R01 的 8 个 P1 已全部关闭；最终 P0=0、P1=0。

## 后移项

- P2：幂等键进一步限定到 requirement 的增强。
- P2：Web Requirement 初始化错误不应全部显示为“没有签字要求”。
- 两项均不阻塞 D15，不在 R03 修改产品代码。

## 后续边界

- D15 只确认既有权威事实，不完成培训、不修改 D11、不修改 D13 成绩/结果，也不计算 D18 上岗资格。
- D16/D17 后续如产生新周期，应调用 supersede/new requirement 机制，不能覆盖旧签字。
- 未修改 `miniprogram/**`；小程序只能在 G2 后消费 machine contract。
- 未开始 D16；下一任务必须由总控单独下达。
