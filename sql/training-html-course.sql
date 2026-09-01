-- ==========================================================================
-- 培训 HTML 课件类型（Markdown 生成的单文件响应式 HTML）
-- ==========================================================================
-- 背景（2026-09-01 用户决策）：
--   培训课件以 Markdown 生成的单文件响应式 HTML 为主。
--   管理员在 tools/course-generator.html 粘贴 Markdown → 生成 .html 上传；
--   员工端 mine.js 以 iframe 加载，课件内嵌运行时负责：
--     分节门控防"一滑到底"（滚动到底 + 驻留时长达标才解锁下一节）
--     心跳计时（可见时每 20s postMessage 给宿主，宿主转 training_course_heartbeat）
--     进度/完成上报（已解锁最大节 / 总节数）
--   未挂进系统单独打开（微信/小程序 webview）时自动降级为本地模式（localStorage 进度）。
--
-- 依赖：training-management.sql（training_courses）、training-content-library.sql（training_library）
-- 执行：云 Supabase → SQL Editor → 粘贴全部 → Run（幂等）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. training_courses.course_type 放开 'html'
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.training_courses'::regclass
               AND conname  = 'training_courses_course_type_check') THEN
    ALTER TABLE public.training_courses DROP CONSTRAINT training_courses_course_type_check;
  END IF;
  ALTER TABLE public.training_courses
    ADD CONSTRAINT training_courses_course_type_check
    CHECK (course_type IN ('pdf', 'video', 'image', 'text', 'link', 'ppt', 'html'));
END $$;

-- --------------------------------------------------------------------------
-- 2. training_library.course_type 放开 'html'（资源库同样支持）
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.training_library'::regclass
               AND conname  = 'training_library_course_type_check') THEN
    ALTER TABLE public.training_library DROP CONSTRAINT training_library_course_type_check;
  END IF;
  ALTER TABLE public.training_library
    ADD CONSTRAINT training_library_course_type_check
    CHECK (course_type IN ('pdf', 'ppt', 'article', 'image', 'html'));
END $$;

COMMENT ON COLUMN public.training_courses.course_type IS
  '课件类型：html = Markdown 生成的单文件 HTML（file_path 指向 training-courses 桶 .html 文件）';

-- ==========================================================================
-- 验证：
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('public.training_courses'::regclass,
--                      'public.training_library'::regclass)
--     AND conname LIKE '%course_type%';
--   两条 CHECK 均应包含 'html'。
-- ==========================================================================
