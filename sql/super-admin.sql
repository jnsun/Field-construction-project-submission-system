-- ==========================================================================
-- 施工项目月报管理系统 - 超级管理员（Super Admin）
-- ==========================================================================
-- 功能：
--   1. profiles 表新增 is_super_admin 列（BOOLEAN，默认 false）
--      角色体系变为三层：
--        'admin' + is_super_admin=true  → 超级管理员（可创建/删除/修改管理员账号）
--        'admin' + is_super_admin=false → 普通管理员（仅可管理部门账号与报送配置等）
--        'reporter'                      → 部门账号
--   2. 新增 public.is_super_admin() 权限判断函数（SECURITY DEFINER）
--   3.（已迁出）账号管理 RPC create/update/delete_dept_user
--      现由 sql/account-rpc-v2.sql 统一维护（合并了手机号登录 p_phone
--      与三级管理员级别 p_admin_level），本文件不再定义，避免签名冲突 42P13。
--   4. 移除 profiles 表的"用户可更新自己的 profile"策略：
--      原策略无 WITH CHECK 限制，任意用户可自行 UPDATE 自己的
--      role / is_super_admin 列实现提权，必须移除。
--      （自助修改邮箱走 change_own_email RPC，SECURITY DEFINER，不受影响）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行。
--
-- 如何设置第一个超级管理员（将某管理员提升为超级管理员）：
--   UPDATE public.profiles
--   SET is_super_admin = true
--   WHERE email = 'admin@company.com';
--
-- 如何撤销超级管理员：
--   UPDATE public.profiles
--   SET is_super_admin = false
--   WHERE email = 'admin@company.com';
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. is_super_admin 列（幂等）
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 历史数据兜底：NULL 视为普通管理员
UPDATE public.profiles
SET is_super_admin = false
WHERE is_super_admin IS NULL;

-- --------------------------------------------------------------------------
-- 2. 超级管理员判断函数（SECURITY DEFINER 绕过 RLS，避免策略递归）
--    仅当账号角色为管理员且被标记为超级管理员时才返回 true
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_super_admin = true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 3.（已迁移）账号管理 RPC
-- --------------------------------------------------------------------------
--   create_dept_user / update_dept_user / delete_dept_user 的定义已全部迁出，
--   统一由 sql/account-rpc-v2.sql 维护，原因：
--     * phone-login.sql 给这两个函数加了 p_phone（手机号登录）
--     * 三级管理员模型又要加 p_admin_level
--   两者参数个数相同、参数名不同，若在本文件里 CREATE OR REPLACE 会报：
--     ERROR 42P13 cannot change name of input parameter "p_phone"
--   且强行 DROP 重建会丢掉手机号登录逻辑。
--
--   ★ 需要账号 RPC 时请执行：sql/account-rpc-v2.sql（含 p_phone + p_admin_level）
--   本文件只负责 is_super_admin 列 / is_super_admin() 函数 / 移除提权策略。
--
-- --------------------------------------------------------------------------
-- 4. 移除"用户可更新自己的 profile"策略（防提权漏洞）
--    - 原策略无 WITH CHECK：任意用户可 UPDATE 自己的 role / is_super_admin
--      自行提升为管理员甚至超级管理员
--    - 自助修改邮箱走 public.change_own_email()（SECURITY DEFINER），
--      自助修改密码走 auth API，均不依赖该策略，移除后功能不受影响
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;

-- --------------------------------------------------------------------------
-- 5. 授权
--    账号 RPC 的 GRANT 已随函数定义迁至 sql/account-rpc-v2.sql，
--    本文件不再重复授权（避免引用不存在的旧签名而报错）。
-- --------------------------------------------------------------------------

-- ==========================================================================
-- 验证：执行以下查询确认列与函数已就绪
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'profiles'
--     AND column_name = 'is_super_admin';
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('is_super_admin', 'create_dept_user', 'update_dept_user', 'delete_dept_user');
-- ==========================================================================
