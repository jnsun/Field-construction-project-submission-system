-- ==========================================================================
-- remove-reporter-role.sql —— 取消「部门账号」(reporter) 角色
--
-- 背景：
--   早期用部门负责人手机号预建的「部门账号」(role='reporter') 不再作为
--   独立角色。角色收敛为三级：超级管理员 / 管理员(部门·公司级·项目部) /
--   普通员工(employee)。报送能力统一由独立开关 profiles.can_report 控制。
--
-- 处理规则：
--   1. 存量 reporter 全部迁移为 employee，且 can_report 保持 TRUE
--      （它们本就是为报送预建的账号，迁移后仍是「员工账号 · 可报送」）
--   2. CHECK 约束收紧为 (admin, employee)，杜绝 reporter 再被写入
--   3. 触发器去掉「reporter 天生可报送」分支，仅保留超管恒不可报送
--   4. resolve_login_identifier 的「部门名称登录」改为按 can_report 找账号
--      （原来按 role='reporter' 找，迁移后会找不到）
--
-- 幂等可重复执行。执行顺序：account-rpc-v2.sql（重跑）之后执行本文件。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 数据迁移：reporter → employee（触发器会把 can_report 置 TRUE 后再落行，
--    报送权自动保留）
-- --------------------------------------------------------------------------
UPDATE public.profiles
   SET role = 'employee',
       admin_level = NULL,
       updated_at = now()
 WHERE role = 'reporter';

-- --------------------------------------------------------------------------
-- 2. CHECK 约束收紧：role 只允许 (admin, employee)
-- --------------------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  -- 删掉所有针对 profiles.role 的 CHECK（历史约束名不统一）
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'employee'));

-- --------------------------------------------------------------------------
-- 3. 触发器更新：仅保留「超级管理员恒不可报送」
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_reporter_can_report()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_super_admin THEN
    NEW.can_report := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_can_report ON public.profiles;
CREATE TRIGGER trg_profiles_can_report
  BEFORE INSERT OR UPDATE OF role, is_super_admin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_reporter_can_report();

-- --------------------------------------------------------------------------
-- 4. 登录标识解析：「部门名称/编码登录」改为按 can_report 找该部门账号
--    （原版按 role='reporter' 找，取消该角色后会报「没有可用账号」）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_login_identifier(p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id    TEXT;
  v_dept  TEXT;
  v_email TEXT;
  v_phone TEXT;
BEGIN
  v_id := btrim(coalesce(p_identifier, ''));
  IF v_id = '' THEN
    RAISE EXCEPTION '请输入邮箱、手机号、部门名称或部门编码';
  END IF;

  -- 1) 邮箱格式：直接返回
  IF v_id LIKE '%@%' THEN
    RETURN jsonb_build_object('email', lower(v_id), 'identifier_type', 'email');
  END IF;

  -- 2) 手机号：精确匹配 profiles.phone
  IF v_id ~ '^1[0-9]{10}$' THEN
    SELECT p.email, p.phone INTO v_email, v_phone
    FROM public.profiles p
    WHERE p.phone = v_id
    LIMIT 1;

    IF v_email IS NOT NULL THEN
      RETURN jsonb_build_object(
        'email',           lower(v_email),
        'identifier_type', 'phone',
        'phone',           v_phone
      );
    END IF;

    RAISE EXCEPTION '未找到使用该手机号的账号，请核对手机号，或使用邮箱/部门名称登录';
  END IF;

  -- 3) 部门编码精确匹配（不区分大小写）
  SELECT d.name INTO v_dept
  FROM public.departments d
  WHERE lower(d.code) = lower(v_id)
  LIMIT 1;

  -- 4) 部门名称精确匹配（不区分大小写）
  IF v_dept IS NULL THEN
    SELECT d.name INTO v_dept
    FROM public.departments d
    WHERE lower(d.name) = lower(v_id)
    LIMIT 1;
  END IF;

  IF v_dept IS NULL THEN
    RAISE EXCEPTION '未找到该部门，请核对部门名称或部门编码，或直接使用邮箱/手机号登录';
  END IF;

  -- 5) 取该部门下第一个「可报送」账号的邮箱
  SELECT p.email INTO v_email
  FROM public.profiles p
  WHERE p.department_id = (SELECT id FROM public.departments WHERE name = v_dept)
    AND p.can_report = TRUE
  ORDER BY p.created_at ASC
  LIMIT 1;

  IF v_email IS NULL THEN
    RAISE EXCEPTION '部门「%」下没有可用账号，请联系管理员分配账号', v_dept;
  END IF;

  RETURN jsonb_build_object(
    'email',           lower(v_email),
    'identifier_type', 'department',
    'department_name', v_dept
  );
END;
$$;

-- --------------------------------------------------------------------------
-- 5. 验证
-- --------------------------------------------------------------------------
-- 5.1 不应再有 reporter
SELECT count(*) AS remaining_reporters FROM public.profiles WHERE role = 'reporter';

-- 5.2 各角色报送权分布
SELECT role,
       COALESCE(admin_level, '-') AS admin_level,
       can_report,
       count(*) AS cnt
FROM public.profiles
GROUP BY role, admin_level, can_report
ORDER BY role, admin_level, can_report;
