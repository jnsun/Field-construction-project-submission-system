-- ==========================================================================
-- 二级部门双类型修正：经营实体(entity) vs 内设机构(internal)
-- ==========================================================================
-- 依据（用户 2026-08-31 确认）：
--   * 公司二级部门分两类：经营实体(entity) + 内设机构(internal)
--   * 部门编号 DEPT-1 ~ DEPT-19 共 19 个为「经营实体」
--   * 其余二级部门为「内设机构」（二级叶子，不再建下级，不报送野外项目）
--   * 只有经营实体可建/挂项目部(project)
-- 前置：必须先执行 sql/department-tree.sql（departments 表需有 parent_id / dept_type）
-- 执行：Supabase 控制台 → SQL Editor → 粘贴全部 → Run（可重复，幂等）
-- ==========================================================================

-- 0. 前置校验：缺少 dept_type 列则明确报错，避免 UPDATE 0 行却以为成功
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'dept_type'
  ) THEN
    RAISE EXCEPTION 'departments 表缺少 dept_type 列，请先执行 sql/department-tree.sql';
  END IF;
END $$;

-- 1. DEPT-1 ~ DEPT-19 → 经营实体（entity）
--    防御：dept_type <> 'company' 避免误改公司根（实际不可能）
UPDATE public.departments
SET dept_type = 'entity'
WHERE code IN (
  'DEPT-1','DEPT-2','DEPT-3','DEPT-4','DEPT-5','DEPT-6','DEPT-7','DEPT-8','DEPT-9',
  'DEPT-10','DEPT-11','DEPT-12','DEPT-13','DEPT-14','DEPT-15','DEPT-16','DEPT-17','DEPT-18','DEPT-19'
)
AND dept_type <> 'company';

-- 2. 其余当前被误标为 entity 的二级部门（不在 DEPT-1~19）→ 内设机构（internal）
--    项目部(dept_type='project')与公司根(dept_type='company')均不在 WHERE，不受影响
UPDATE public.departments
SET dept_type = 'internal'
WHERE dept_type = 'entity'
  AND code NOT IN (
    'DEPT-1','DEPT-2','DEPT-3','DEPT-4','DEPT-5','DEPT-6','DEPT-7','DEPT-8','DEPT-9',
    'DEPT-10','DEPT-11','DEPT-12','DEPT-13','DEPT-14','DEPT-15','DEPT-16','DEPT-17','DEPT-18','DEPT-19'
  );

-- 3. 验证①：按 dept_type 统计（期望 company 1 / entity 19 / internal 若干 / project 若干）
SELECT dept_type, COUNT(*) AS cnt
FROM public.departments
GROUP BY dept_type
ORDER BY dept_type;

-- 4. 验证②：列出被标为 internal 的部门，请核对是否与贵司内设机构一致
SELECT code, name, (parent_id IS NOT NULL) AS has_parent
FROM public.departments
WHERE dept_type = 'internal'
ORDER BY code;

-- 5. 验证③：检查内设机构下是否误挂了项目部（理想应为 0 行；若有，请先处理项目部归属）
SELECT d.code AS internal_code, d.name AS internal_name, c.name AS project_name
FROM public.departments d
JOIN public.departments c ON c.parent_id = d.id AND c.dept_type = 'project'
WHERE d.dept_type = 'internal';
