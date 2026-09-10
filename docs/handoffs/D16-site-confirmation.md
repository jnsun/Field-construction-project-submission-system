# D16｜现场确认、照片、定位与复工重确认

## 阶段状态

- 当前状态：`CANDIDATE / R03 COMPLETE / READY FOR COMMIT`
- 工作区：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 基线 HEAD：`e92499ac727cc58df75c4a715f77075b165fd90e`
- migration：v108
- R01：发现 P1=2，均已在 R02 关闭
- 必要 FINAL：PASS，证据完整
- commit / push：未执行
- P0=0，P1=0；remaining deferred product P2=5；P3=0

## 最终实现范围

- 建立项目 + 人员 + 精确 admission 的服务端权威现场确认 requirement、cycle、result 和永久审计历史。
- 当前项目经理或安全员按 `ANY_OF` 确认；提交时重新校验当前角色、项目、人员、membership 和 admission 绑定。
- 硬前置权威消费 D11、D12、D13 和 D15；D16 调用 D15 ensure 自动物化适用签字 requirement，但不写培训、考试、专项或签字完成事实。
- 现场照片必传，使用 private Storage、PNG/JPEG 真实字节解码、SHA-256、尺寸和对象版本绑定；历史正式照片不可覆盖或删除。
- `confirmed_at` 由服务端产生；定位可随确认提交，失败时进入 pending，并允许一次不可变补传。
- 项目暂停/关闭或成员 inactive 会使当前确认失效；项目复工或成员重新激活创建新周期，普通离返场且无权威失效事件时保留当前确认。
- 支持 source event supersede、幂等重试、并发唯一结果、不可变历史、隐私/RLS、Web 权威工作台和 machine contract。

## Migration 与契约

- v107：`sql/training-admission-v107-site-confirmation-evidence.sql`
  - SHA-256：`986C6D051566217330838165427C27D756D5335DDEB4141EE7220F666B7595D9`
  - D16 基础数据模型、RPC、RLS、Storage、状态机和审计。
- v108：`sql/training-admission-v108-d16-r01-p1-fixes.sql`
  - SHA-256：`75924C1269B7B634E62355DE266E5FABFC78F8E35A855DBF8BEBD66A120716F1`
  - 仅关闭 R01 的旧写旁路和 D15 requirement 未物化两个 P1。
- migration manifest：v1-v108 连续，`108/108 PASS`；v1-v106 未回写。
- machine contract：`docs/contracts/D16-site-confirmation-v1.json`，状态保持 `candidate`，与 v108 一致。

## R01 → R02 闭环

### P1-01｜旧现场确认写旁路

- 原问题：authenticated 可调用 `training_confirm_site(uuid,text,numeric,numeric,text,text)` 绕过 D16 新流程。
- 最终结果：authenticated/anon EXECUTE 均为 DENIED；项目经理也不能调用旧 RPC；旧 Web 已切换到 D16 工作台；旧表普通客户端 INSERT/UPDATE/DELETE/TRUNCATE 权限均为 0。
- 状态：`CLOSED`

### P1-02｜D15 requirement 未物化时错误放行

- 原问题：适用策略尚无 requirement 行时，被错误解释为无需签字。
- 最终结果：D16 调用 D15 authoritative ensure；适用策略会物化 requirement；required 未签时阻塞、全部 signed 后放行；只有权威 `not_required` 才放行；D16 不写 D15 signed result。
- 状态：`CLOSED`

## 测试基础设施事件

- D11 reuse：历史 compatibility wrapper 曾重复启动完整 foundation，现已改为独立短兼容入口。
- D08 v72 replay：旧 runner 曾在新数据库重放 v72，现按当前 capability 检测并输出 `skip-v72-replay`。
- 测试库漂移：`contractor_document_create`、`site_project_set_drilling_operation`、`training_set_member_special_work_types` 已恢复到当前权威定义；完整 D08、D12 后 fingerprint 保持稳定。
- 以上均为测试基础设施事件，不计为产品 P1。

## 最终 FINAL 证据

- Migration verifier：`108/108 PASS`
- D16 photo decode：`7/7 PASS`
- Contract：`19/19 PASS`
- R02 focused：`8/8 PASS`
- D15 zero requirement / prerequisite：`6/6 PASS`
- D16 dynamic：`53/53 PASS`
- D07 permission matrix：`14/14 PASS`
- D08：`36/36 PASS`，`skip-v72-replay`
- D11 foundation：`29/29 PASS`
- D11 reuse：`5/5 PASS`
- D12：`62/62 PASS`
- D13 authoritative exams：`41/41 PASS`
- D15 organization signer：`10/10 PASS`
- D15 supersede / immutable：`12/12 PASS`
- Web smoke：`12/12 PASS`
- fixture residual=0；process/psql residual=0；active/non-idle query=0
- `git diff --check`：PASS

## Deferred / non-blocking

R01 原始报告 P2=6。第 6 项“handoff 状态过期”已由本次 R03 文档维护关闭，不再计入 residual product P2。剩余 deferred product P2=5：

1. 跨 requirement 重用 idempotency key 时，响应对象可进一步严格绑定。
2. requirement immutable guard 缺失 GUC 时，可进一步显式 `COALESCE`。
3. location 经纬度、accuracy 和 schema 可增加更严格的服务端字段校验。
4. confirmation result 可补充 confirmer display snapshot。
5. Web/API 可增加历史 confirmation cycle 浏览。

## D17 / D18 交接边界

- D17 可消费 D16 的 current requirement、current completion、`invalidated` / `reconfirmation_required`、项目/成员状态和权威 evidence reference。
- D17 不得重新实现现场确认、直接写 D16 completion、修改 D16 历史照片/定位，或用自己的现场状态替代 D16 权威结果。
- D18 最终资格状态机消费 D16、D17 等权威结果；D16 本身不是最终 qualification state machine。

## 权限与客户端边界

- Legacy `training_confirm_site`：authenticated=DENIED，anon=DENIED。
- 旧 `training_site_confirmations`：普通客户端 INSERT/UPDATE/DELETE/TRUNCATE 均为 0。
- 新 D16 仅通过权威 RPC、private Storage 和 Edge Function 验证链操作。
- Web/小程序只展示服务端结果，不自行计算现场确认或最终资格；`miniprogram/**` 未修改。
