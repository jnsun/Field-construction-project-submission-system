-- ==========================================================================
-- fix-account-names.sql —— 账号名=部门名 的账号批量修正
-- --------------------------------------------------------------------------
-- 背景：早期为各二级部门开的账号，账号名称直接用了部门名称（如账号名
--       与部门名都是「工程物探所」），无法看出是哪位员工在用。
-- 目标：
--   1) 按手机号在员工档案(training_employees)里找到对应员工姓名，改写账号名称；
--   2) 全部升级为「部门管理员」（role='admin'，admin_level='dept'），
--      使其可管理本部门员工的档案和账号。
-- 保护：跳过超级管理员、公司根部门（dept_type='company'）的账号。
-- 执行：云 Supabase SQL Editor → 粘贴全部 → Run（可重复执行，幂等）。
-- 注意：第 2 节只改「手机号能匹配到员工档案」的账号；
--       匹配不到的会由第 3 节列出，需人工补手机号或确认后处理。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1) 预览：将被修改的账号（先看一眼再跑第 2 节）
-- --------------------------------------------------------------------------
SELECT p.id,
       p.full_name  AS 当前账号名,
       d.name       AS 部门名,
       p.phone,
       e.name       AS 将改为的员工姓名
FROM public.profiles p
JOIN public.departments d ON d.id = p.department_id
LEFT JOIN public.training_employees e
       ON btrim(coalesce(p.phone, '')) <> ''
      AND btrim(coalesce(e.phone, '')) = btrim(p.phone)
WHERE p.full_name = d.name
  AND coalesce(p.is_super_admin, false) = false
  AND d.dept_type <> 'company'
ORDER BY d.name;

-- --------------------------------------------------------------------------
-- 2) 执行：改名 + 升级为部门管理员
--    同一手机号在员工档案中有多条时，取最近更新的一条
-- --------------------------------------------------------------------------
WITH matched AS (
  SELECT DISTINCT ON (p.id) p.id, e.name AS emp_name
  FROM public.profiles p
  JOIN public.departments d ON d.id = p.department_id
  JOIN public.training_employees e
         ON btrim(coalesce(p.phone, '')) <> ''
        AND btrim(coalesce(e.phone, '')) = btrim(p.phone)
  WHERE p.full_name = d.name
    AND coalesce(p.is_super_admin, false) = false
    AND d.dept_type <> 'company'
  ORDER BY p.id, e.updated_at DESC NULLS LAST
)
UPDATE public.profiles p
SET full_name   = m.emp_name,
    role        = 'admin',
    admin_level = 'dept'
FROM matched m
WHERE p.id = m.id;

-- --------------------------------------------------------------------------
-- 3) 核对：改不动的账号（手机号为空 / 员工档案中无此手机号）
--    这些账号保持原名，请人工确认后用「编辑」改名
-- --------------------------------------------------------------------------
SELECT p.id,
       p.full_name AS 账号名,
       d.name      AS 部门名,
       p.phone,
       CASE WHEN coalesce(p.phone, '') = '' THEN '手机号为空'
            ELSE '员工档案中无此手机号' END AS 原因
FROM public.profiles p
JOIN public.departments d ON d.id = p.department_id
WHERE p.full_name = d.name
  AND coalesce(p.is_super_admin, false) = false
  AND d.dept_type <> 'company'
  AND NOT EXISTS (
    SELECT 1 FROM public.training_employees e
    WHERE btrim(coalesce(e.phone, '')) <> ''
      AND btrim(e.phone) = btrim(coalesce(p.phone, ''))
  );

-- --------------------------------------------------------------------------
-- 4) 验证：账号名=部门名 的账号还剩几个（应只剩第 3 节列出的）
-- --------------------------------------------------------------------------
SELECT count(*) AS 剩余同名账号
FROM public.profiles p
JOIN public.departments d ON d.id = p.department_id
WHERE p.full_name = d.name
  AND coalesce(p.is_super_admin, false) = false
  AND d.dept_type <> 'company';
