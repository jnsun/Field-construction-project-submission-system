# D05 安全、隐私、RLS、导出与二维码基线审查

审查日期：2026-09-03；最终验收日期：2026-09-05
范围：隔离 Supabase 测试项目、静态网页、GitHub Pages 部署工作流及 D05 负向 API 测试。本文不包含任何密钥、口令、会话或个人信息。

## 1. 已核对的基线

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 客户端配置 | 已移除仓库内历史 legacy `anon` API key 字面量，改为部署时生成的 `js/config.runtime.js`；未发现服务端秘密进入客户端 | `js/config.js`、`.github/workflows/pages.yml`、`.gitignore`、`tests/verify-d05-secret-scan.js` |
| 私有文件桶 | `avatars`、`certificates`、`training-courses` 均为非公开桶 | 测试库 `storage.buckets` 查询 |
| 高权限函数 | 已撤销全部 `public` 架构 `SECURITY DEFINER` 函数对 `PUBLIC` 与 `anon` 的默认执行授权，并固定包括用户建档触发器在内的函数搜索路径；匿名可执行数量为 0 | `training-admission-v49-security-baseline.sql`、迁移后数据库核对 |
| 签字不可覆盖 | `training_signatures` 与 `training_admission_signatures` 的更新、删除由数据库触发器拒绝；宽泛签字策略已替换为本人读取/本人写入 | v49 迁移、触发器清单 |
| 已发布课件保护 | `training_courses` 已有版本保护触发器，覆盖新增、修改、删除入口 | 数据库触发器清单 |

## 2. 本轮修复

### D05-AC01：仓库与部署配置

`js/config.js` 不再保存实际项目配置。GitHub Pages 工作流仅从 Actions Secrets 读取 `SAFETY_SUPABASE_URL` 和 `SAFETY_SUPABASE_ANON_KEY`，在构建工件中生成浏览器运行时配置。该浏览器密钥属于公开客户端配置，不能替代 RLS；服务端密钥不得进入该文件。

本机开发可从 `js/config.runtime.example.js` 复制得到被忽略的 `js/config.runtime.js`。部署前必须在 GitHub 仓库的 Actions Secrets 中设置上述两个变量，否则工作流会主动失败，避免把空配置发布出去。

当前 HEAD 与工作区的自动扫描未发现历史 legacy `anon` API key 字面量，也未发现 `service_role`、JWT signing secret、数据库密码、私钥或 SSH 私钥字面量。`tests/verify-d05-secret-scan.js` 保留为安全回归检查，只报告路径和秘密类型，不输出匹配内容。静态代码未发现应用自行设置 Cookie 的调用；会话持久化由 Supabase 浏览器 SDK 的 `persistSession` 配置承担。未来若改用服务端 Cookie 会话，必须另行验证 `Secure`、`HttpOnly`、`SameSite` 与过期时间。

### D05-AC02 至 D05-AC05：数据库权限

新增 `sql/training-admission-v49-security-baseline.sql`，已在隔离测试库执行：

1. 收紧所有现有和后续 `SECURITY DEFINER` 函数的默认 `PUBLIC` 执行授权。
2. 固定用户建档触发器的 `search_path`，仅保留原有显式业务角色授权，未删除历史数据或已签字记录。
3. 将学习签字表限制为本人读取、本人插入；触发器拒绝后续更新和删除。
4. 校验匿名调用二维码核验 RPC、匿名读取人员资料、实体账号枚举档案及伪造他人签字均失败。

## 3. 自动化测试结果

运行命令：

```powershell
node tests/e2e/d05-security-baseline.js
```

早期基线结果：5/5 通过。该结果不等同于 2026-09-05 的最终验收结论。

补充静态审计：`node tests/audit-handlers.js` 共 942 项检查通过。`js/config.runtime.js` 被明确标记为部署时生成文件，本机工作区缺失该文件不再被误报为引用缺失。

| 验收编号 | 覆盖内容 | 结果 |
| --- | --- | --- |
| D05-AC01 | 匿名读取 `profiles` 被拒绝 | 通过 |
| D05-AC02 | 匿名调用凭证二维码核验 RPC 被拒绝 | 通过 |
| D05-AC03 | 经营实体账号直接读取全体 `training_employees` 被拒绝 | 通过 |
| D05-AC04 | 经营实体账号不能枚举无关 `profiles` | 通过 |
| D05-AC05 | 经营实体账号伪造他人签字被拒绝 | 通过 |

### 2026-09-05 首次最终验收（历史结果）

统一入口：`node tests/e2e/run-d05-final-acceptance.js`。首次执行内部总耗时 19.405 秒（外层计时 19.571 秒），当时结果为 **FAIL**：5 个测试套件中 4 个通过、1 个失败。

- 断言自测 6/6、现有角色/RLS 负向 API 8/8、统计函数权限 8/8、秘密扫描均通过。
- v51、v52 清单哈希和测试库实际权限状态通过；`profiles`、`departments`、`training_employees` 均保持 RLS，合法访问成功，跨实体人员数据被 RLS 过滤。
- 144 个 `public` SECURITY DEFINER 函数中，PUBLIC/anon 可执行数量均为 0。验收器把固定为 `search_path=pg_catalog` 的 `rls_auto_enable()` 误判为不安全；该函数实际使用更严格的系统目录路径，不构成安全缺陷。
- 文件桶 3/3 私有、`storage.objects` RLS 开启、匿名 Storage policy 为 0；匿名签名 URL 请求被拒绝。导出、二维码及邀请码敏感函数匿名可执行数量为 0。
- 跨项目场景无法执行：现有 4 个项目均属于同一个 D02 经营实体，实体管理员依法可见全部 4 个项目；测试环境没有项目经理/安全员的第二项目负向夹具。
- 跨实体部门夹具断言使用了直接读取的部门目录；该目录按既有设计允许 authenticated 全读，因此断言不能代表业务数据越权。现有人员数据测试仍证明实体树外员工记录被 RLS 过滤。
- 因跨项目负向场景缺少可执行夹具，首次验收当时不能判为 PASS；这是已保留的历史结果，不代表当前结论。

### 2026-09-05 修正后最终完整验收（当前结论）

针对首次验收暴露的三个阻塞项，先完成 SECURITY DEFINER `pg_catalog` 安全路径判断、部门目录真实权限模型判断，以及复用 D02 匿名数据的第二经营实体/第二项目最小夹具。定向测试 9/9 通过，临时数据清理残留为 0。

随后执行一次修正后的统一 FINAL，内部总耗时 35.271 秒（外层计时 35.374 秒），最终结果为 **PASS**：6 个测试套件全部通过。

- 断言自测 6/6、角色/RLS 负向 API 8/8、统计函数权限 8/8、跨范围阻塞回归 9/9、最终安全区域 14/14、秘密扫描 0 项。
- v51、v52 清单哈希及隔离测试库实际权限通过；三张业务表保持 RLS，10 个统计函数的 PUBLIC/anon EXECUTE 为 0，authenticated 仅能执行 8 个外部 RPC。
- 合法项目范围读取成功；跨项目读取被 RLS 过滤，跨项目 RPC 被拒绝；跨经营实体统计导出被 403/42501 拒绝。
- `rls_auto_enable()` 的固定 `search_path=pg_catalog` 被正确接受；authenticated 可读取完整部门目录，但目录可见不再被误判为业务数据越权。
- 两次夹具使用后的残留均为 0。D05 FINAL 为 `PASS`，R03 交接完成后当前状态为 `PASS`。

## 4. 未完成的安全验证与缺陷清单

截至 2026-09-05 修正后最终验收，当前剩余风险计数为 P0=0、P1=0、P2=4、P3=1。历史 Git 中出现的仅是本来用于公开客户端的 legacy `anon` API key，不属于服务端秘密泄露，已从 P1 调整为“正式上线前 API Key 迁移事项”。D03 已通过，旧的迁移链验证 P1 不再保留。D05 FINAL 为 `PASS`，R01 为 `PASS / No findings`，R03 交接完成，当前状态为 `PASS`。

| 优先级 | 事项 | 影响 | 建议后续任务 | 阻塞试点 |
| --- | --- | --- | --- | --- |
| P2 | 项目经理/安全员脱敏导出与安全部/实体完整导出尚无独立服务端导出接口验收 | 尚不能证明不同角色获得的导出字段均符合最小披露要求 | T19 导出字段与角色矩阵专项验收 | 是 |
| P2 | 员工、项目经理、安全员、外协四类独立账号的负向 RLS 用例未全部运行；本次仅用最小夹具验证实体管理员的跨项目、跨经营实体边界 | 最小跨范围边界已有证据，但四类独立角色与外协攻击矩阵仍不完整 | T26 完整角色矩阵与外协边界专项 | 是 |
| P2 | 二维码过期、撤销、项目暂停/关闭后的实时失效，以及接口速率限制未完成攻击型 E2E | 防重放、即时失效和抗枚举结论尚未形成 | T16/T26 二维码、邀请码状态机与限流专项 | 是 |
| P2 | 现场签字图片实际写入桶与现有存储策略的全链路授权未进行角色矩阵测试 | 可能造成合法上传受阻，或文件读取范围不符合预期 | T10/T19 Storage 上传、签名 URL、读取和撤销矩阵 | 是 |
| P3 | 当前使用 Supabase 浏览器 SDK 本地会话，尚无服务端 Cookie 安全属性测试 | 当前架构不使用服务端 Cookie；只有未来改为 Cookie 会话时才可能遗漏 Secure、HttpOnly、SameSite 或过期策略 | 后续引入服务端会话时新增 Cookie 安全验收 | 否 |

## 5. 人工验收与上线前 API Key 迁移

1. 在 Supabase 测试项目确认 `storage.buckets` 中三个桶均保持私有。
2. 在 GitHub 仓库设置 Actions Secrets 的 `SAFETY_SUPABASE_URL` 与 `SAFETY_SUPABASE_ANON_KEY`，手动运行 Pages 工作流并确认应用能登录。
3. 正式上线前，将浏览器使用的 legacy `anon` API key 迁移为 publishable API key，将仅供后端使用的 legacy `service_role` API key 迁移为 secret API key；仅在受控的部署平台环境变量和 GitHub Actions Secrets 中配置，不得写回源代码、文档或测试输出。该事项属于上线前部署清单，不作为 D05 P1，且不要求修改 JWT Signing Keys。
4. 执行 v49 后，以匿名、员工、项目经理、安全员、实体管理员、安全生产部管理员分别测试读取、写入、导出、签字和二维码核验。
5. D05 FINAL PASS 只代表本安全基线通过；在完成上述四个 P2 的专项验收前，仍不得据此放行完整业务试点。

## 6. 回滚

本轮不删除业务数据。若 v49 引发合法签字流程异常，可先停止新签字操作，再由数据库管理员在维护窗口内删除两个不可变触发器并按原授权策略恢复；恢复前必须保留 v49 执行记录与数据库备份。不得通过直接修改或删除已签字记录绕过问题。

## 7. R03 最终交接

- D05 FINAL：6/6 PASS；R01：PASS / No findings。
- 风险计数：P0=0、P1=0、P2=4、P3=1；四个 P2 与一个 P3 均继续登记，未伪装为已解决。
- v51、v52 已纳入连续迁移账本；三张业务表的 authenticated 最小表级权限、RLS 实际参与、跨项目/跨经营实体隔离、SECURITY DEFINER 与 `stats_*` 执行边界、Storage/签名 URL、二维码/邀请码以及秘密扫描均已通过 D05 验收。
- legacy API Key 迁移继续作为正式上线前部署事项，不属于 D05 P1；未执行真实密钥轮换，未修改 JWT Signing Keys。
- 本阶段未访问生产环境，未修改 `miniprogram/**`。
- D05=`PASS`，安全基线门 G0=`PASS`，D06 已解锁但本轮未开始。
