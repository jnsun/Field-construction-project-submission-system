-- ==========================================================================
-- dept-report-accounts.sql —— 部门报送专用账号批量开通（19 个部门）
-- ==========================================================================
-- 背景与目标：
--   野外施工项目月报由 19 个业务部门分别填报。每个部门配一个「报送专用账号」，
--   账号名称就是部门名称（登录时直接输入中文部门名即可，前端自动映射为底层邮箱）。
--
-- 账号规则（用户锁定）：
--   账号名称 = 部门名称       例：工程测绘中心
--   底层邮箱 = 部门编码小写   例：dept-02@login.local（与 departments.code 一一对应）
--   默认密码 = 8652517
--   角色     = employee（reporter 角色已废弃）
--   报送权   = can_report = TRUE（独立开关，见 report-permission.sql）
--   归属部门 = 对应 department_id（决定只能看到/填报本部门项目，RLS 隔离）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
--   执行后控制台会输出两张结果表：① 本次执行明细 ② 19 个账号总览
--
-- 幂等可重复执行：
--   - 账号已存在 → 重置为默认密码、部门、报送权（不新建重复账号）
--   - 某个部门失败 → 只影响该部门，其余照常开通，失败原因在结果表里列出
--
-- 依赖：schema.sql（profiles / departments）、report-permission.sql（can_report 列）
-- 不执行本脚本的效果：这 19 个部门需由管理员在「账号管理」页面逐个手工新建。
-- ==========================================================================

SET search_path = public, extensions;

-- --------------------------------------------------------------------------
-- 0. 执行日志临时表（Supabase 控制台不显示 RAISE NOTICE，用表来呈现结果）
-- --------------------------------------------------------------------------
DROP TABLE IF EXISTS pg_temp.tmp_dept_acct_log;
CREATE TEMP TABLE tmp_dept_acct_log (
  seq         INT,
  dept_name   TEXT,
  dept_code   TEXT,
  login_email TEXT,
  action      TEXT,
  ok          BOOLEAN,
  detail      TEXT
);

-- --------------------------------------------------------------------------
-- 1. 批量开通（逐个部门独立异常块，单点失败不影响其余部门）
-- --------------------------------------------------------------------------
DO $$
DECLARE
  -- 需要报送的 19 个部门（名称须与 departments.name 完全一致）
  v_names TEXT[] := ARRAY[
    '碳中和产业研究院', '工程测绘中心', '大地测绘中心', '遥感中心', '太原分院',
    '卫星遥感大数据应用中心', '地信中心', '岩土工程所', '地灾防治所', '地质勘查所',
    '生态化学所', '地质调查所', '资源环境所', '能源物探所', '广州分院',
    '工程物探所', '综合研究所', '地震物探所', '电磁物探所'
  ];
  v_password TEXT := '8652517';
  v_missing  TEXT;
  v_seq      INT := 0;
  r          RECORD;
  v_uid      UUID;
  v_email    TEXT;
  v_action   TEXT;
BEGIN
  IF length(v_password) < 6 THEN
    RAISE EXCEPTION '默认密码长度不足 6 位，Supabase 认证会拒绝';
  END IF;

  -- 1.0 先记下不存在（名称写错 / 部门被改名）的目标部门，避免静默少建
  SELECT string_agg(n, '、') INTO v_missing
    FROM unnest(v_names) AS n
   WHERE NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.name = n);
  IF v_missing IS NOT NULL THEN
    INSERT INTO tmp_dept_acct_log (seq, dept_name, dept_code, login_email, action, ok, detail)
    VALUES (0, v_missing, '-', '-', '跳过', FALSE,
            'departments 表中不存在该部门（名称不一致或已被改名），请先在「部门管理」中核对');
  END IF;

  -- 1.1 逐部门开通
  FOR r IN
    SELECT d.id, d.name, d.code
      FROM public.departments d
     WHERE d.name = ANY (v_names)
     ORDER BY d.sort_order NULLS LAST, d.name
  LOOP
    v_seq   := v_seq + 1;
    v_email := lower(btrim(r.code)) || '@login.local';

    BEGIN
      -- (a) 认证账号：已存在则重置密码，不存在则新建
      SELECT u.id INTO v_uid FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;

      IF v_uid IS NULL THEN
        v_action := '新建';
        INSERT INTO auth.users (
          instance_id, id, aud, role,
          email, phone,
          encrypted_password,
          email_confirmed_at, phone_confirmed_at,
          confirmation_token, recovery_token,
          email_change, email_change_token_new,
          raw_app_meta_data, raw_user_meta_data,
          created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000000',
          gen_random_uuid(),
          'authenticated',
          'authenticated',
          v_email,
          NULL,
          crypt(v_password, gen_salt('bf', 10)),
          now(),
          NULL,
          '', '',
          '', '',
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('dept_report_account', TRUE, 'dept_name', r.name),
          now(), now()
        )
        RETURNING id INTO v_uid;
      ELSE
        v_action := '重置';
        UPDATE auth.users
           SET encrypted_password = crypt(v_password, gen_salt('bf', 10)),
               email_confirmed_at = COALESCE(email_confirmed_at, now()),
               updated_at         = now()
         WHERE id = v_uid;
      END IF;

      -- (b) 账号档案：绑定部门 + 报送权
      --     handle_new_user 触发器可能已插入仅含 id/email 的行，用 ON CONFLICT 覆盖
      INSERT INTO public.profiles (
        id, email, department_id, role, full_name,
        is_super_admin, phone, admin_level, can_report
      ) VALUES (
        v_uid, v_email, r.id, 'employee', r.name,
        FALSE, NULL, NULL, TRUE
      )
      ON CONFLICT (id) DO UPDATE SET
        email          = EXCLUDED.email,
        department_id  = EXCLUDED.department_id,
        role           = EXCLUDED.role,
        full_name      = EXCLUDED.full_name,
        is_super_admin = FALSE,
        phone          = NULL,   -- 部门账号不占用手机号，避免与员工账号冲突
        admin_level    = NULL,
        can_report     = TRUE,
        updated_at     = now();

      INSERT INTO tmp_dept_acct_log (seq, dept_name, dept_code, login_email, action, ok, detail)
      VALUES (v_seq, r.name, r.code, v_email, v_action, TRUE, '已开通并绑定部门，可报送');

    EXCEPTION WHEN OTHERS THEN
      INSERT INTO tmp_dept_acct_log (seq, dept_name, dept_code, login_email, action, ok, detail)
      VALUES (v_seq, r.name, r.code, v_email, '失败', FALSE, SQLERRM);
    END;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 2. 结果表①：本次执行明细
--    ok = false 的行需要处理：detail 里写明了失败原因
-- --------------------------------------------------------------------------
SELECT seq         AS "序号",
       dept_name   AS "部门名称",
       dept_code   AS "部门编码",
       login_email AS "底层邮箱",
       action      AS "动作",
       CASE WHEN ok THEN '成功' ELSE '需处理' END AS "结果",
       detail      AS "说明"
  FROM tmp_dept_acct_log
 WHERE seq > 0
 ORDER BY seq;

-- --------------------------------------------------------------------------
-- 3. 结果表②：19 个部门账号总览（应为 19 行，可报送/可登录 均为 19）
-- --------------------------------------------------------------------------
SELECT d.sort_order AS "序号",
       d.name       AS "部门名称",
       d.code       AS "部门编码",
       p.email      AS "底层邮箱",
       p.full_name  AS "账号名称",
       p.role       AS "角色",
       p.can_report AS "可报送",
       CASE WHEN u.email_confirmed_at IS NOT NULL THEN '正常' ELSE '异常（邮箱未确认，无法登录）' END AS "登录状态"
  FROM public.departments d
  LEFT JOIN public.profiles p ON p.department_id = d.id
                             AND lower(p.email) = lower(d.code) || '@login.local'
  LEFT JOIN auth.users    u ON u.id = p.id
 WHERE d.name IN (
    '碳中和产业研究院', '工程测绘中心', '大地测绘中心', '遥感中心', '太原分院',
    '卫星遥感大数据应用中心', '地信中心', '岩土工程所', '地灾防治所', '地质勘查所',
    '生态化学所', '地质调查所', '资源环境所', '能源物探所', '广州分院',
    '工程物探所', '综合研究所', '地震物探所', '电磁物探所'
 )
 ORDER BY d.sort_order;

-- --------------------------------------------------------------------------
-- 4. 快速自检：一行汇总（部门总数 / 已建账号 / 可报送 / 可登录 应均为 19）
-- --------------------------------------------------------------------------
SELECT count(*)                                                AS "部门总数",
       count(p.id)                                             AS "已建账号",
       count(*) FILTER (WHERE p.can_report)                    AS "可报送",
       count(*) FILTER (WHERE u.email_confirmed_at IS NOT NULL) AS "可登录"
  FROM public.departments d
  LEFT JOIN public.profiles p ON p.department_id = d.id
                             AND lower(p.email) = lower(d.code) || '@login.local'
  LEFT JOIN auth.users    u ON u.id = p.id
 WHERE d.name IN (
    '碳中和产业研究院', '工程测绘中心', '大地测绘中心', '遥感中心', '太原分院',
    '卫星遥感大数据应用中心', '地信中心', '岩土工程所', '地灾防治所', '地质勘查所',
    '生态化学所', '地质调查所', '资源环境所', '能源物探所', '广州分院',
    '工程物探所', '综合研究所', '地震物探所', '电磁物探所'
 );

-- --------------------------------------------------------------------------
-- 5. 常用运维片段（按需单独执行，本脚本不会自动跑）
-- --------------------------------------------------------------------------
-- 5.1 统一重置全部部门账号密码为 8652517
-- UPDATE auth.users u
--    SET encrypted_password = crypt('8652517', gen_salt('bf', 10)), updated_at = now()
--   FROM public.profiles p
--  WHERE p.id = u.id
--    AND p.email ~ '^dept-[0-9]+@login\.local$';
--
-- 5.2 收回某个部门账号的报送权（保留账号，关闭报送入口）
-- UPDATE public.profiles SET can_report = FALSE WHERE email = 'dept-02@login.local';
--
-- 5.3 部门改了编码（如 DEPT-02 → DEPT-20）后重新对齐
--   先改 departments.code，再重跑本脚本：会为新邮箱建号，旧邮箱账号需手工清理。
-- ==========================================================================
