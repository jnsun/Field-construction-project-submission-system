# D01：需求追踪矩阵与验收编号

> 更新日期：2026-09-03
>
> 原始需求来源：`E:\codex\safety\和sol对话确定后续开发计划.txt`。该文件位于仓库外；本矩阵固化其 T01-T27。代码状态以 [D00 盘点](00-codebase-inventory.md) 为准，计划中的“已开发”一律不直接视为通过。

## 一、规则

| 状态 | 定义 |
| --- | --- |
| `未实现` | 未发现满足原计划的完整实现。 |
| `部分完成待回归` | 有相关实现，但仍有功能或验证缺口。 |
| `待回归验证` | 已定位实现，尚无完整自动化与人工签收证据。 |
| `阻塞` | 前置环境、数据库核验或试点条件不足，不能签收。 |
| `已验证待签收` | 自动化和人工验收完成，待业务负责人签收。 |

1. 每个 `Txx-ACnn` 都是唯一子要求编号；表内按编号顺序列出原计划的所有子项。
2. “定位”按 `前端 / 数据库 / 接口` 编写；`未发现` 是明确结论，不得留空。
3. 新增规则必须先新增验收编号，再改代码、SQL、RLS、Storage 或配置；每次提交、测试和发布记录必须引用相应编号。
4. 已签字、已发布、已归档或已有培训档案的数据变更，必须有向后兼容迁移、回滚和审计证据。
5. 任何“已开发”先进入 `待回归验证`；只有完整测试与人工签收才能转为 `已验证待签收`。

## 二、T01-T27 验收矩阵

“原始要求”中的每个 `AC编号：内容` 是独立验收子项。每行的定位、角色、正常/异常路径、测试、人工验收和证据共同适用于该行全部子项。

| 验收编号与原始要求 | 当前状态 | 定位（前端 / 数据库 / 接口） | 角色 | 正常路径 | 异常路径 | 自动化测试 | 人工验收 | 证据 | 试点门 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **T01-AC01** 自动项目编号；**T01-AC02** 主责及多参与实体；**T01-AC03** 关联月报；**T01-AC04** 完工仅提醒；**T01-AC05** 暂停/关闭/重开；**T01-AC06** 暂停禁申请和刷新邀请码 | 待回归验证 | `projects.js` / `site_projects`、`site_project_entities`、`project_reports` / `site_project_create`、`site_project_update`、`site_project_link_reports`、`site_project_refresh_invite` | 公司、实体管理员、项目经理、安全员 | 建项目、关联月报、维护状态 | 越权或暂停状态申请/刷新必须拒绝并留痕 | `audit-handlers.js` 仅 RPC 对照 | 创建、暂停、关闭、重开及月报提示回归 | `training-admission-v1/v6/v16/v21.sql` | 否 |
| **T02-AC01** 实体任命角色；**T02-AC02** 最多2名经理；**T02-AC03** 安全员不限；**T02-AC04** 手机准入/催办/核验；**T02-AC05** 权限穿透 | 待回归验证 | `projects.js`、`admission-operations.js`、`admission-verify.js` / `site_project_roles` / `site_project_set_roles` | 实体管理员、项目经理、安全员 | 任命合法角色后管理本人项目 | 第3名经理、越项目管理必须拒绝 | 静态 RPC 对照；权限 E2E 未发现 | 多角色、多项目、手机端权限回归 | `training-admission-v1/v2.sql` | 否 |
| **T03-AC01** 单位合同资质；**T03-AC02** 邀请申请；**T03-AC03** 项目首次审核；**T03-AC04** 跨项目实体审核；**T03-AC05** 关键信息变更复审；**T03-AC06** 四类高危证照；**T03-AC07** 永久留档及单位历史 | 待回归验证 | `contractors.js`、`admission-mine.js`、`admission-review.js` / `contractor_*`、`project_join_*`、`training_personnel_reapproval_requests` / `site_project_apply`、`site_project_review_application`、`training_review_personnel_reapproval` | 外协、项目经理、安全员、实体管理员 | 申请、审核、入项目、变更复审 | 无邀请码、缺高危证照、跨项目未审必须拒绝 | 静态 RPC 对照；完整 E2E 未发现 | 外协建档、变更、跨项目、历史回归 | `training-admission-v1/v2/v29/v30/v34-v37/v42/v45-v47.sql` | 否 |
| **T04-AC01** 三级/专项计划；**T04-AC02** HTML课件；**T04-AC03** 本地生成器；**T04-AC04** 多媒体链接；**T04-AC05** 学时可配；**T04-AC06** 草稿至发布；**T04-AC07** 批量签发；**T04-AC08** 已签发发布禁改 | 部分完成待回归 | `plans.js`、`courses.js`、`admission-packages.js`、`tools/course-generator.html` / `training_plans`、`training_courses`、`training_admission_packages` / `training_request_plan_approval`、`training_approve_plan`、`training_publish_plan` | 安全部、实体、项目经理、安全员、制作者 | 制作、送审、签发、发布、分配 | 无权发布或修改已签发版本必须拒绝 | 课件生成测试、静态 RPC 对照；发布 E2E 未发现 | 各级计划和版本冻结回归 | `training-management.sql`、`training-online-v2.sql`、`training-admission-v7/v13/v19/v20.sql` | 否 |
| **T05-AC01** Word/PDF转草稿；**T05-AC02** 提取标题章节图片重点；**T05-AC03** Logo标识；**T05-AC04** 扁平插画占位；**T05-AC05** 人工审核；**T05-AC06** 不接第三方AI | 部分完成待回归 | `tools/course-generator.html`、`courses.js` / `training_courses`、`training_library`、`training-courses`桶 / Word/PDF 导入 RPC 未发现 | 安全部、制作者、审核人 | 导入或生成后编辑、审核发布 | 解析失败、未审核、外部 AI 调用必须阻断/提示 | `build-sample-course.js`、`test-html-inject.js`；Word/PDF 测试未发现 | Word、PDF、图片、审核发布回归 | `docs/html-courseware-guide.md`、`training-html-course.sql` | 否 |
| **T06-AC01** 三级按规则完成；**T06-AC02** 公司级全国复用；**T06-AC03** 实体级本实体复用；**T06-AC04** 跨项目补专项；**T06-AC05** 公司领导免普通上岗 | 待回归验证 | `admission-packages.js`、`admission-mine.js`、`admission-operations.js` / `training_admission_*`、`site_project_members` / `training_start_admission`、`training_recompute_admission` | 员工、领导、项目经理、安全员 | 按身份和项目计算应学内容 | 缺层级、误复用、领导误发上岗资格必须拦截 | 静态 RPC 对照；规则 E2E 未发现 | 跨项目、跨实体、领导路径回归 | `training-admission-v1/v3/v9/v10.sql` | 否 |
| **T07-AC01** 爆破；**T07-AC02** 钻探；**T07-AC03** 电工；**T07-AC04** 焊工；**T07-AC05** 可扩展专项；**T07-AC06** 无专项/试卷禁准入 | 待回归验证 | `admission-packages.js`、`papers.js`、`exams.js` / `training_admission_special_rules`、`exam_*` / `training_set_package_special_rules`、`training_start_admission`、`training_prepare_admission_exam` | 高危员工、项目经理、安全员、管理员 | 岗位匹配专项课件和试卷后准入 | 缺专项或试卷必须拒绝 | 静态 RPC 对照；专项 E2E 未发现 | 四工种和扩展工种回归 | `training-admission-v9/v10.sql`、`exam-module.sql` | 否 |
| **T08-AC01** 综合考试；**T08-AC02** 20题；**T08-AC03** 30分钟；**T08-AC04** 80分/3次；**T08-AC05** 随机抽题；**T08-AC06** 高危专项失败禁岗 | 部分完成待回归 | `exams.js`、`papers.js`、`mine.js` / `exam_questions`、`exam_papers`、`exam_attempts`、`training_admissions` / `exam_start`、`exam_submit`、`training_prepare_admission_exam` | 员工、管理员、项目经理、安全员 | 完成三级后开考、判分、更新资格 | 超时、超次数、未通过、缺专项必须禁岗 | 考试 RPC 对照；全流程 E2E 未发现 | 随机、补考、专项考试回归 | `exam-module.sql`、`exam-fix-v1.sql`、`training-admission-v9.sql` | 否 |
| **T09-AC01** 随机1-2题；**T09-AC02** 未答暂停；**T09-AC03** 答错重答；**T09-AC04** 留时间答案结果；**T09-AC05** 不做人脸摄像头 | 未实现 | `mine.js` 未发现完整门控 / `training_quiz_checks` / `training_study_quiz_for_course`、`training_study_quiz_answer` | 员工、管理员 | 学习中下发确认题，答后继续 | 未答、断网重复、答错必须阻断/留痕 | 完整 E2E 未发现 | 随机、暂停、重答和无摄像头验收 | `training-admission-v17.sql` | 否 |
| **T10-AC01** 各级员工签字；**T10-AC02** 最终准入签字；**T10-AC03** 项目负责人/安全员；**T10-AC04** 实体负责人；**T10-AC05** 部长签发；**T10-AC06** 永久保存签字图时间人员摘要 | 部分完成待回归 | `mine.js`、`admission-mine.js`、`admission-reports.js` / `training_signatures`、`training_admission_signatures`、Storage / `training_submit_signature`、`training_admission_sign` | 员工、项目、安全员、实体负责人、部长 | 依序签字并归档 | 重复/越权签字或文件不可读必须拒绝 | 静态 RPC 对照；签字 E2E 未发现 | 多方签字、永久档案、下载打印回归 | `exam-module.sql`、`training-admission-v1/v4/v21/v43/v44.sql` | 否 |
| **T11-AC01** 任一经理/安全员确认；**T11-AC02** 现场照片；**T11-AC03** 确认时间；**T11-AC04** 定位弱网补传；**T11-AC05** 确认后上岗；**T11-AC06** 离返场复用；**T11-AC07** 复工重确认 | 待回归验证 | `admission-operations.js`、`admission-verify.js` / `training_site_confirmations`、Storage / `training_confirm_site` | 项目经理、安全员、员工 | 上传证据、确认现场、计算上岗 | 无照片、越权、复工未确认必须禁岗 | 静态 RPC 对照；弱网定位 E2E 未发现 | 两类角色、照片、复工、离返场回归 | `training-admission-v1/v6/v21/v43.sql` | 否 |
| **T12-AC01** 停工天数配置；**T12-AC02** 默认180天可调；**T12-AC03** 只重置项目/专项；**T12-AC04** 公司实体有效；**T12-AC05** 大版本强补学；**T12-AC06** 新周期不覆盖旧档案 | 未实现 | 完整界面和闭环未发现 / `training_admission_retraining_cycles`、`training_admissions` / `training_start_pause_retraining`、`training_start_annual_retraining` | 管理员、项目、安全员、员工 | 阈值或版本变化创建新周期 | 覆盖旧记录、误重置、重复周期必须拒绝 | 完整 E2E 未发现 | 180天、版本、历史周期与重签字回归 | `training-admission-v21/v25.sql` | 否 |
| **T13-AC01** 条件齐备；**T13-AC02** 缺项禁入禁岗；**T13-AC03** 关闭/证照/凭证过期禁岗；**T13-AC04** 默认一年可调；**T13-AC05** 关闭自动失效 | 部分完成待回归 | `admission-mine.js`、`admission-verify.js` / `training_admissions`、`training_eligibility_certificates`、`site_projects` / `training_recompute_admission`、`training_refresh_expired_admissions`、`training_verify_certificate` | 员工、项目、安全员、管理员 | 重算并显示资格 | 缺项、过期、关闭后二维码必须失效 | 静态 RPC 对照；状态机 E2E 未发现 | 失效原因、有效期、关闭项目回归 | `training-admission-v1/v21/v24/v25/v31/v35.sql` | 否 |
| **T14-AC01** 最长24h；**T14-AC02** 原因有效期；**T14-AC03** 高危禁用；**T14-AC04** 红色台账；**T14-AC05** 码/到期/撤销；**T14-AC06** 不替代正常资格 | 待回归验证 | `admission-operations.js`、`admission-verify.js` / `training_temporary_access` / `training_grant_temporary_access`、`training_revoke_temporary_access`、`training_verify_temporary_access` | 项目、安全员、核验人、员工 | 合规岗位授予并核验 | 超24h、高危、到期、撤销必须失效 | 静态 RPC 对照；E2E 未发现 | 高危拒绝、撤销、台账和码回归 | `training-admission-v5/v11.sql` | 否 |
| **T15-AC01** 领导不显示上岗；**T15-AC02** 访客告知；**T15-AC03** 访客码；**T15-AC04** 仅告知有效；**T15-AC05** 暂停关闭到期失效 | 待回归验证 | `admission-visitors.js`、`admission-verify.js` / `training_visitor_safety_notices` / `training_issue_visitor_notice`、`training_acknowledge_visitor_notice`、`training_verify_visitor_notice` | 领导、项目、安全员、核验人 | 告知后生成访客码 | 非领导误用或项目失效必须拒绝 | 静态 RPC 对照；E2E 未发现 | 访客全链路与失效回归 | `training-admission-v14.sql` | 否 |
| **T16-AC01** PDF记录凭证；**T16-AC02** 无电子公章；**T16-AC03** 二维码最小展示；**T16-AC04** 身份证脱敏；**T16-AC05** 实时扫码核验 | 待回归验证 | `admission-mine.js`、`admission-verify.js`、`admission-reports.js` / `training_eligibility_certificates`、`training_verification_logs` / `training_my_certificate`、`training_verify_certificate`、`training_log_verification` | 员工、项目、安全员、核验人 | 下载凭证并扫码实时核验 | 过期码、越权详情、完整身份证展示必须拒绝 | 静态 RPC 对照；二维码 E2E 未发现 | PDF、二维码、脱敏和失效回归 | `training-admission-v3/v32/v35.sql` | 否 |
| **T17-AC01** 三级台账；**T17-AC02** 记录卡；**T17-AC03** 外协台账；**T17-AC04** 签到表；**T17-AC05** 成绩单；**T17-AC06** 年度统计；**T17-AC07** 按课件变化；**T17-AC08** 表头页码签字Logo分页 | 部分完成待回归 | `admission-reports.js`、`records.js`、`stats.js` / 准入考试签字外协表 / `training_admission_record_cards`、`training_contractor_personnel_ledger`、`training_admission_annual_stats` | 安全部、实体、项目、安全员 | 生成、打印、导出固定报表 | 无权完整导出、版式溢出、课件不符必须阻断/修复 | 静态 RPC 对照；打印视觉回归未发现 | 六类报表、分页、签字、Logo、脱敏验收 | `training-admission-v12/v18/v22/v23/v40.sql` | 是 |
| **T18-AC01** 下发提醒；**T18-AC02** 提前3天；**T18-AC03** 逾期每日；**T18-AC04** 批量催办；**T18-AC05** 禁岗名单；**T18-AC06** 默认9点；**T18-AC07** 定时/微信后续 | 部分完成待回归 | `admission-operations.js`、`admission-mine.js` / `training_admission_reminders`、`training_admission_notification_settings` / `training_send_admission_start_notice`、`training_generate_*_reminders` | 管理员、项目、安全员、员工 | 发任务或人工按规则生成提醒 | 重复提醒、越权催办、未调度声称自动发送必须拒绝/标明 | 静态 RPC 对照；定时 E2E 未发现 | 下发、临期、逾期、催办、9点调度验收 | `training-admission-v8/v15/v26/v27/v31.sql` | 否 |
| **T19-AC01** 身份证加密；**T19-AC02** 页面脱敏；**T19-AC03** 项目导出脱敏；**T19-AC04** 完整导出限角色；**T19-AC05** RLS/下载/函数；**T19-AC06** 越权猜码重复签字；**T19-AC07** 凭据外部访问 | 部分完成待回归 | `contractors.js`、`admission-verify.js`、`config.js` / 身份字段、Storage、RLS / SECURITY DEFINER、签名URL、核验RPC | 全体角色、安全部、实体、项目、安全员 | 最小展示、授权访问、审计 | 越权、明文配置、可猜码、重复签字必须阻断 | `audit-handlers.js`；安全 E2E 未发现 | RLS、Storage、导出、码、函数、凭据专项审计 | [D00 风险](00-codebase-inventory.md#七风险清单与建议执行顺序)、`training-admission-v45-v47.sql` | 否 |
| **T20-AC01** 下载当前包；**T20-AC02** 50MB上限；**T20-AC03** 超限拆分；**T20-AC04** 续传重试；**T20-AC05** 离线进度答题签字；**T20-AC06** 恢复同步冲突 | 未实现 | `mine.js` 有局部进度 / `training_course_progress`、`training_study_logs` / `training_save_course_progress`、`training_course_heartbeat` | 员工 | 下载本人任务、离线学习、恢复幂等同步 | 非本人下载、超限、重复、冲突、草稿丢失必须处理 | `test-courseware-runtime.js` 仅本地课件；离线 E2E 未发现 | 断网、续传、重试、冲突、拆包验收 | `training-online-v2.sql`、`training-content-library.sql` | 否 |
| **T21-AC01** 员工学习考试签字凭证；**T21-AC02** 管理人员核验催办；**T21-AC03** 小屏；**T21-AC04** 弱网横竖屏微信；**T21-AC05** 按钮表格画布加载 | 部分完成待回归 | `training-module.css`、`mine.js`、`admission-*.js` / 复用培训表 / 复用现有RPC | 员工、项目经理、安全员 | 手机浏览器完成授权流程 | 遮挡、旋转丢失、弱网重复必须修复 | 浏览器 E2E 需 CDP；移动专项未发现 | Android/iOS/微信横竖屏弱网验收 | `index.html`、`css/training-module.css` | 否 |
| **T22-AC01** 微信登录；**T22-AC02** 手机绑定档案；**T22-AC03** 外协扫码申请；**T22-AC04** 扫码核验；**T22-AC05** 订阅消息；**T22-AC06** 离线同步；**T22-AC07** 禁转发个人凭证 | 未实现 | 未发现小程序/微信SDK / 未发现专用表 / 未发现回调接口 | 员工、外协、项目、安全员、安全部 | 授权后绑定并复用准入服务 | 主体未审、验签失败、跨人绑定、资料转发必须拒绝 | 未发现 | 微信真机、回调、订阅、隐私、离线验收 | [P01 清单](miniprogram-registration-checklist.md) | 否 |
| **T23-AC01** 名称；**T23-AC02** 主体；**T23-AC03** 管理部门；**T23-AC04** AppID/域名/协议；**T23-AC05** Supabase接口文件回调域名；**T23-AC06** 后台配置 | 部分完成待回归 | `miniprogram-registration-checklist.md` / 不适用 / 不适用 | 安全部、法务、小程序管理员 | 补齐资料后提交审核并配置已审域名 | 无AppID、主体/域名未审、无HTTPS不得接入 | 文档链接格式检查；平台审核未执行 | 逐项填写负责人、证据与后台结果 | [P01 验收](miniprogram-registration-checklist.md#八p01-验收记录) | 否 |
| **T24-AC01** v1-v16成功；**T24-AC02** 表函数触发器索引RLS；**T24-AC03** 历史数据未误改；**T24-AC04** 备份恢复；**T24-AC05** 升级验证 | 阻塞 | 无迁移执行器 / 80个 SQL、线上状态未入库 / 无统一验证接口 | 数据库管理员、安全部、开发人员 | 备份后按清单执行并核对对象数据 | 漏迁、乱序、RLS缺失、恢复失败必须停止试点 | `audit-handlers.js` 仅文本 RPC 对照；迁移验证未发现 | SQL Editor核对和恢复演练 | [D00 SQL风险](00-codebase-inventory.md#三sql-迁移范围与顺序风险) | 是 |
| **T25-AC01** 内部三级；**T25-AC02** 外协全流程；**T25-AC03** 跨项目实体；**T25-AC04** 高危专项；**T25-AC05** 暂停复工关闭重开；**T25-AC06** 临时访客；**T25-AC07** 凭证报表权限 | 阻塞 | `js/modules/training/` / 培训准入考试外协表 / training、exam、site RPC | 员工、外协、项目、安全员、实体、安全部 | 按七类场景端到端完成 | 任一状态、权限、重复或弱网异常必须复现记录 | `training-test.html`、`audit-handlers.js`；完整 E2E 未发现 | 隔离数据逐场景签收 | `docs/training-test-report-20260831.md` | 是 |
| **T26-AC01** 员工隔离；**T26-AC02** 项目限权；**T26-AC03** 实体隔离；**T26-AC04** 外协防伪；**T26-AC05** 已发布课件禁改；**T26-AC06** 二维码即时失效 | 阻塞 | `auth.js`、`admission-*`、`courses.js` / RLS、Storage、准入课程表 / SECURITY DEFINER、签名URL、核验RPC | 员工、外协、项目、安全员、实体、安全部 | 各角色仅访问职责范围 | 越权、伪造、发布修改、失效码必须拒绝审计 | `audit-handlers.js`；攻击型 E2E 未发现 | 角色矩阵、RLS、Storage、函数、码专项验收 | [D00 安全风险](00-codebase-inventory.md#七风险清单与建议执行顺序) | 是 |
| **T27-AC01** 普通野外项目；**T27-AC02** 高危项目；**T27-AC03** 20-40人；**T27-AC04** 2-4周反馈；**T27-AC05** 修正后扩至200人/20项目 | 未实现 | 未发现试点配置页 / 复用项目人员培训表 / 不适用 | 安全部、试点项目经理、安全员、员工、外协 | 选两项目通过门禁后试运行 | 发布门未过、无项目同意或高危缺陷不得扩面 | 未发现 | 启动会、周报、问题闭环、扩面评审 | 本文第三节 | 否 |

## 三、试点发布门

原计划指定的 T24、T25、T26、T09、T12、T20、T17 是试点前必过门。当前均未达到 `已验证待签收`，不得标记为“可试点发布”。

| 发布门 | 状态 | 放行条件 | 当前缺口 |
| --- | --- | --- | --- |
| T24 | 阻塞 | 迁移清单、备份恢复、对象/RLS/历史数据有证据 | 无线上执行记录和恢复演练 |
| T25 | 阻塞 | 七类流程在隔离数据环境通过 | 无完整 E2E 与人工签收 |
| T26 | 阻塞 | 角色、RLS、Storage、函数、二维码安全通过 | 无攻击型权限测试和线上策略核验 |
| T09 | 未实现 | 确认题、暂停、重答、审计均通过 | 无完整实现与测试 |
| T12 | 未实现 | 停工阈值、版本复训、历史留档通过 | 无完整规则闭环与测试 |
| T20 | 未实现 | 离线下载、续传、幂等同步、冲突处理通过 | 无完整弱网实现与测试 |
| T17 | 部分完成待回归 | 六类报表、打印版式、签字、分页通过 | 无正式版式和视觉/打印验收 |

## 四、D01 验收记录

| 验收编号 | 验收点 | 状态 | 证据 |
| --- | --- | --- |
| D01-AC01 | T01-T27 原计划已固化为唯一 Txx-ACnn 编号 | 已验证待签收 | 本文第二节，27项任务、约160项子要求 |
| D01-AC02 | 每项含状态、定位、角色、正常/异常、测试、人工验收、证据和发布门 | 已验证待签收 | 本文第二节 |
| D01-AC03 | “已开发”均降为待回归或部分完成，未实现和阻塞明确标记 | 已验证待签收 | 第一至三节 |
| D01-AC04 | 变更规则和试点发布门已建立 | 已验证待签收 | 第一、三节 |

## 五、后续更新方式

后续开发或测试任务必须引用一个或多个 `Txx-ACnn`。新增规则先入矩阵再实施；不得只在聊天记录中形成未追踪需求。
