-- ==========================================================================
-- report-permission.sql —— 报送权限独立化（can_report 开关）
--
-- 背景与设计：
--   角色四级：超级管理员 / 部门管理员(admin_level=dept,company) /
--            项目管理员(admin_level=project) / 普通员工(employee)，
--   外加「部门账号」(reporter)。
--   报送权不再是角色专属，而是独立开关 profiles.can_report：
--     - 部门管理员、项目管理员、普通员工、部门账号均可被授予
--     - 超级管理员不需要（超管本身可看全部数据）
--   权限规则：谁能给谁开：
--     - 超级管理员 / 公司级管理员：任意账号
--     - 部门管理员 / 经营实体管理员：本部门树内的账号（复用
--       account_visible_dept_ids()，须先执行 sql/account-rpc-v2.sql）
--
-- 幂等可重复执行。依赖：account-rpc-v2.sql（account_visible_dept_ids）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 字段
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_report BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.can_report IS '允许报送野外施工项目（独立于角色：部门账号/员工/部门管理员/项目管理员均可开启）';

-- --------------------------------------------------------------------------
-- 2. 回填：现有「部门账号」全部默认可报送（保持现状行为不变）
--    管理员 / 员工默认关闭，按需在账号管理里勾选开启
-- --------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE public.profiles SET can_report = TRUE WHERE role = 'reporter' AND can_report = FALSE;
  -- 超级管理员强制关闭（超管不参与报送）
  UPDATE public.profiles SET can_report = FALSE WHERE is_super_admin = TRUE;
END $$;

-- --------------------------------------------------------------------------
-- 3. 设置 RPC（唯一写入口；不扩 account-rpc-v2 的函数签名，避免 42P13）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_user_can_report(
  p_user_id    UUID,
  p_can_report BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_target      public.profiles%ROWTYPE;
  v_my_role     TEXT;
  v_my_super    BOOLEAN;
  v_my_level    TEXT;
  v_my_dept     UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT role, is_super_admin, admin_level, department_id
    INTO v_my_role, v_my_super, v_my_level, v_my_dept
  FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR v_my_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '只有管理员可以设置报送权限';
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '未找到目标账号';
  END IF;

  -- 超级管理员账号不参与报送
  IF v_target.is_super_admin THEN
    RAISE EXCEPTION '超级管理员账号无需设置报送权限';
  END IF;

  -- 非公司级管理员：只能改本部门树内的账号
  IF NOT (v_my_super OR v_my_level = 'company') THEN
    IF NOT (v_target.department_id = ANY (public.account_visible_dept_ids())) THEN
      RAISE EXCEPTION '只能为本部门（含下级）的账号设置报送权限';
    END IF;
  END IF;

  UPDATE public.profiles
     SET can_report = p_can_report,
         updated_at = now()
   WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id, 'can_report', p_can_report);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_can_report(UUID, BOOLEAN) TO authenticated;

-- --------------------------------------------------------------------------
-- 3.5 触发器：超级管理员恒不可报送
--      （「reporter 天生可报送」分支已随该角色取消而移除，见 remove-reporter-role.sql）
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

-- 存量数据再对齐一次（触发器建好后的兜底）
UPDATE public.profiles SET can_report = TRUE  WHERE role = 'reporter' AND is_super_admin = FALSE AND can_report = FALSE;
UPDATE public.profiles SET can_report = FALSE WHERE is_super_admin = TRUE AND can_report = TRUE;

-- --------------------------------------------------------------------------
-- 4. 验证
-- --------------------------------------------------------------------------
-- 4.1 各角色报送权分布
SELECT role,
       COALESCE(admin_level, '-') AS admin_level,
       can_report,
       count(*) AS cnt
FROM public.profiles
GROUP BY role, admin_level, can_report
ORDER BY role, admin_level, can_report;
