-- ==========================================================================
-- 施工项目月报管理系统 - 项目状态（在建 / 已完工）
-- ==========================================================================
-- 功能：
--   1. project_reports 表新增 project_status 列：
--        'active'    = 在建（默认）
--        'completed' = 已完工
--   2. 部门账号按「在建项目 / 已完工项目」两个列表管理报送；
--      管理员在「完工项目」汇总页查看全部部门已完工项目。
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行（未执行过本脚本的库直接执行即可；执行过的再次执行无副作用）。
--
-- 不执行本脚本的效果：系统自动降级，报送功能不受影响，
-- 仅不显示项目状态相关的列表与汇总页面（页面会提示先执行本脚本）。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 项目状态列（幂等）
-- --------------------------------------------------------------------------
ALTER TABLE public.project_reports
  ADD COLUMN IF NOT EXISTS project_status TEXT DEFAULT 'active';

COMMENT ON COLUMN public.project_reports.project_status IS
  '项目状态：active=在建（默认），completed=已完工；已完工项目归入完工项目列表';

-- 约束：仅允许两种状态值（幂等：先删旧约束再建，避免重复定义报错）
ALTER TABLE public.project_reports DROP CONSTRAINT IF EXISTS project_reports_project_status_check;
ALTER TABLE public.project_reports
  ADD CONSTRAINT project_reports_project_status_check
  CHECK (project_status IN ('active', 'completed'));

-- 历史数据兜底：空值视为在建（幂等）
UPDATE public.project_reports
   SET project_status = 'active'
 WHERE project_status IS NULL OR project_status = '';

-- --------------------------------------------------------------------------
-- 2. 查询索引（完工项目汇总页按状态 + 部门查询，加快检索）
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_project_reports_status_dept
  ON public.project_reports (project_status, department_id);
