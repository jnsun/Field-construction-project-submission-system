# D05 安全、隐私、RLS、导出与二维码基线审查

审查日期：2026-09-03
范围：隔离 Supabase 测试项目、静态网页、GitHub Pages 部署工作流及 D05 负向 API 测试。本文不包含任何密钥、口令、会话或个人信息。

## 1. 已核对的基线

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 客户端配置 | 已移除仓库内的实际 Supabase 地址与浏览器密钥，改为部署时生成的 `js/config.runtime.js` | `js/config.js`、`.github/workflows/pages.yml`、`.gitignore` |
| 私有文件桶 | `avatars`、`certificates`、`training-courses` 均为非公开桶 | 测试库 `storage.buckets` 查询 |
| 高权限函数 | 已撤销全部 `public` 架构 `SECURITY DEFINER` 函数对 `PUBLIC` 与 `anon` 的默认执行授权，并固定包括用户建档触发器在内的函数搜索路径；匿名可执行数量为 0 | `training-admission-v49-security-baseline.sql`、迁移后数据库核对 |
| 签字不可覆盖 | `training_signatures` 与 `training_admission_signatures` 的更新、删除由数据库触发器拒绝；宽泛签字策略已替换为本人读取/本人写入 | v49 迁移、触发器清单 |
| 已发布课件保护 | `training_courses` 已有版本保护触发器，覆盖新增、修改、删除入口 | 数据库触发器清单 |

## 2. 本轮修复

### D05-AC01：仓库与部署配置

`js/config.js` 不再保存实际项目配置。GitHub Pages 工作流仅从 Actions Secrets 读取 `SAFETY_SUPABASE_URL` 和 `SAFETY_SUPABASE_ANON_KEY`，在构建工件中生成浏览器运行时配置。该浏览器密钥属于公开客户端配置，不能替代 RLS；服务端密钥不得进入该文件。

本机开发可从 `js/config.runtime.example.js` 复制得到被忽略的 `js/config.runtime.js`。部署前必须在 GitHub 仓库的 Actions Secrets 中设置上述两个变量，否则工作流会主动失败，避免把空配置发布出去。

当前工作区的路径级扫描未发现 JWT、服务端角色密钥、私钥或 SSH 私钥字面量；唯一保留的 Supabase 地址是运行时配置示例中的占位地址。静态代码未发现应用自行设置 Cookie 的调用；会话持久化由 Supabase 浏览器 SDK 的 `persistSession` 配置承担。未来若改用服务端 Cookie 会话，必须另行验证 `Secure`、`HttpOnly`、`SameSite` 与过期时间。

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

结果：5/5 通过。

补充静态审计：`node tests/audit-handlers.js` 共 942 项检查通过。`js/config.runtime.js` 被明确标记为部署时生成文件，本机工作区缺失该文件不再被误报为引用缺失。

| 验收编号 | 覆盖内容 | 结果 |
| --- | --- | --- |
| D05-AC01 | 匿名读取 `profiles` 被拒绝 | 通过 |
| D05-AC02 | 匿名调用凭证二维码核验 RPC 被拒绝 | 通过 |
| D05-AC03 | 经营实体账号直接读取全体 `training_employees` 被拒绝 | 通过 |
| D05-AC04 | 经营实体账号不能枚举无关 `profiles` | 通过 |
| D05-AC05 | 经营实体账号伪造他人签字被拒绝 | 通过 |

## 4. 未完成的安全验证与缺陷清单

| 优先级 | 事项 | 影响 | 后续验收编号 |
| --- | --- | --- | --- |
| P1 | 历史 Git 提交中曾出现浏览器 Supabase 密钥 | 虽非服务端密钥，仍应在 Supabase 控制台轮换，并更新 GitHub Actions Secrets 与本机运行时配置；若仓库曾公开，评估历史清理 | T19-AC07 |
| P1 | 测试库尚未完成 v17-v47 的完整迁移链验证 | 高危岗位、访客、临时通行、报表与即时失效不能据此宣称已通过 | T24、T25、T26 |
| P2 | 项目经理/安全员脱敏导出与安全部/实体完整导出尚无独立服务端导出接口验收 | 当前页面导出依赖 RLS 读取结果，尚不能证明各字段级导出授权完整 | T19-AC03、T19-AC04 |
| P2 | 员工、项目经理、安全员、外协四类独立账号的负向 RLS 用例未全部运行 | 当前仅完成匿名和经营实体账号的 API 负向验证 | T26-AC01 至 T26-AC04 |
| P2 | 二维码过期、撤销、项目暂停/关闭后的实时失效，以及接口速率限制未完成攻击型 E2E | 防重放和抗枚举结论尚未形成 | T16-AC05、T26-AC06 |
| P2 | 现场签字图片实际写入桶与现有存储策略的全链路授权未进行角色矩阵测试 | 可能造成合法上传受阻或文件访问范围不符合预期 | T10-AC06、T19-AC05 |

## 5. 人工验收与密钥轮换

1. 在 Supabase 测试项目确认 `storage.buckets` 中三个桶均保持私有。
2. 在 GitHub 仓库设置 Actions Secrets 的 `SAFETY_SUPABASE_URL` 与 `SAFETY_SUPABASE_ANON_KEY`，手动运行 Pages 工作流并确认应用能登录。
3. 在 Supabase 控制台轮换曾出现在历史提交中的浏览器密钥；仅在受控的本机环境变量和 GitHub Actions Secrets 更新新值。不得写回源代码、文档或测试输出。
4. 执行 v49 后，以匿名、员工、项目经理、安全员、实体管理员、安全生产部管理员分别测试读取、写入、导出、签字和二维码核验。
5. 在完成 T26 全部攻击型用例前，不得将本次 5/5 结果作为试点发布放行依据。

## 6. 回滚

本轮不删除业务数据。若 v49 引发合法签字流程异常，可先停止新签字操作，再由数据库管理员在维护窗口内删除两个不可变触发器并按原授权策略恢复；恢复前必须保留 v49 执行记录与数据库备份。不得通过直接修改或删除已签字记录绕过问题。
