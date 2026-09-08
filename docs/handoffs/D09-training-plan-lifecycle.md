# D09 培训计划、课件与版本签发流程交接（PASS）

- 发起泳道：Web/后端
- 工作目录：`E:\codex\safety-web`
- 分支：`track/web-backend`
- 开发基线 HEAD：`70e3a53b9db7c914e3e4174e1d208c0fe633d0fd`
- 需求/验收：T04；培训计划、课件、学习有效时长、签发发布和版本闭环
- 当前结论：D09 FINAL `70/70 PASS`，R01 四项 P1 已由 R02 关闭，P0=0、P1=0；本交接随 D09 R03 独立提交生效，D09 状态为 `PASS`
- 机器契约：[D09-training-plan-api-v1](../contracts/D09-training-plan-api-v1.json)

## 迁移与核心对象

- v75：计划、课件和培训历史不可变；学员课件读取边界；课件类型、HTTPS 外链与 Storage 正式文件锁定。
- v76：计划范围、课件库快照和文件 owner/跨范围权限收口。
- v77：Storage 对象绑定授权，阻止使用他人、跨实体或不存在的路径创建课件和资源库记录。
- v78：`company`、`entity`、`project`、`special` 四类权威范围；`training_plan_targets` 原子维护；`hours`、`required_hours` 和 `effective hours`。
- v79：送审、驳回、签发、批量签发、发布、撤回、克隆新版本及事件审计。
- v80：R02 权限语义、服务端 heartbeat、撤回后学习门禁和稳定版本 lineage 收口。
- migration manifest 与校验工具已连续登记至 v80，最终静态校验为 `80/80 PASS`。部署必须按 v75 至 v80 顺序应用；已进入共享迁移账本的版本不得回写。

## 计划范围、课件与学时

- 公司级计划按公司管理员权限管理；经营实体/部门级计划按真实实体管理范围处理；项目级计划读取复用 `site_project_can_read`，管理复用 `site_project_can_manage`；专项计划按实际绑定的实体或项目范围鉴权，不用空部门字段放宽权限。
- 项目经理和安全员可以用普通 employee profile 通过权威项目角色管理本项目培训；公司管理员、参与实体管理员或其他只读角色不会因可见而自动获得修改、签发或文件管理权限。计划 UPDATE 同时校验旧范围和新范围，阻止范围提升。
- `training_save_plan_draft` 原子维护计划及 `training_plan_targets`；越权 target 会使整次操作失败，不留下部分计划或名单数据。客户端不能直接写 targets。
- 计划同时保存计划学时和要求学时。客户端进度百分比不等于有效学时，assignment 完成状态由服务端依据实际有效秒数、要求学时和现有考试规则计算。
- plan、course、library snapshot 及已有培训历史进入正式生命周期后不可原地改写；资源库后续变化不会影响已生成课件快照。

## Storage 与学员访问

- `training-courses` bucket 保持私有。read、bind 和 manage 使用不同权限；绑定必须验证对象存在、真实 owner 或已有业务管理权限。
- 未关联临时文件仅真实 owner 可维护；跨实体、跨项目或只读角色不能覆盖/删除。已送审、签发、发布或形成历史的正式文件锁定，不能覆盖或删除。
- 学员读取计划和课件必须同时满足 `published + 本人 assignment`；知道 UUID 或 Storage path 不会获得访问权。
- 首次 heartbeat（含重复传 NULL session）只创建学习会话，`credited_seconds=0`。后续请求锁定同一会话行，并按“客户端提示上限、服务端实际经过时间、单次 60 秒上限”三者最小值计入有效时长；会话必须属于当前用户、assignment 和 course，并发调用不能重复计时。
- 计划 withdraw 后保留 assignment、学习记录和既有有效时长，但拒绝新的 heartbeat、progress 和 complete。

## 生命周期、版本与审计

- 生命周期包含 review、reject、sign、batch sign、publish 和 withdraw；意见、操作人、时间、批次与版本摘要写入 `training_plan_events`，客户端不能直接伪造生命周期状态。
- 每条计划版本保存稳定的 `version_root_id` 和 `version_no`。历史链回填沿完整祖先链查找根节点；检测到 cycle 或同 root 重复版本号时迁移明确停止，不静默重编号正式历史。
- `(version_root_id, version_no)` 由数据库 UNIQUE 约束兜底。任意后代版本克隆时锁定稳定 root 行，并按全 lineage 的最大版本号生成下一版本，避免并发重复编号。
- 新版本复制计划和课件内容，不复制 assignment、学习记录或旧版本审计；旧 published/signed 内容及其历史引用保持不变。

## Web、契约与验收证据

- Web 培训计划页面覆盖计划维护、课件内容、送审、签发、批量签发、发布、撤回和新版本；项目经理/安全员入口不再被通用 admin 前端门槛拦截，最终授权仍由数据库/RPC 决定。
- 课件支持 text、PDF、video、image、HTML sandbox 和 HTTPS external link；text 使用安全文本渲染，HTML 保持 sandbox 隔离。
- `D09-training-plan-api-v1.json` 记录四类范围、生命周期、有效学时、heartbeat 返回字段和版本 lineage；未改变旧客户端 heartbeat 请求格式。
- D09 FINAL：历史/内容 11/11、权限/RLS/Storage 24/24、Storage binding 15/15、范围/targets/有效学时 10/10、lifecycle/version/audit/contract 10/10，合计 `70/70 PASS`，测试 residual=0。
- 正式 R01：P0=0、P1=4。R02 已关闭 P1-01（项目角色管理入口与权限）、P1-02（read 与 write/approve/Storage manage 分离）、P1-03（heartbeat 服务端计时及撤回门禁）、P1-04（稳定 lineage 与并发唯一性）；R02 TARGETED 18/18 PASS，最终 P0=0、P1=0。

## 保留 P2、回滚与后续输入

- P2-01：machine contract 结构仍可继续增强。
- P2-02：测试仍可增加额外覆盖。
- P2-03：withdraw 返回 `"status":"withdrawn"` 与数据库真实状态字段表达存在差异。
- 以上 P2 均不阻塞 D09 PASS，本轮不处理。
- 若 v75-v80 尚未应用，可回退 D09 业务提交；若已应用到共享环境，不得删除或改写历史 migration、正式计划、审计或学习记录，只能新增连续迁移向前修正。回滚 Web 时也必须保留数据库安全边界和旧客户端请求兼容。
- D11 的输入为 D09 已发布计划、课件快照、四类范围、`training_plan_targets`、学员 assignment、有效学时、生命周期和版本能力；D11 可在总控另行授权后构建三级安全教育培训包及复用规则。本交接不授权开始 D11。
- C01 状态：无。未修改 `miniprogram/**`；交接不包含密码、令牌、Cookie、AppSecret、service role、数据库连接串或真实个人数据。
