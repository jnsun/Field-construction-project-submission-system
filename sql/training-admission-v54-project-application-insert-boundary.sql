-- D06：外协申请只允许通过 site_project_apply() 创建。
-- 保留现有 RLS，不再向客户端开放可绕过项目状态检查的直接 INSERT。
BEGIN;

REVOKE INSERT ON TABLE public.project_join_applications
FROM anon, authenticated;

-- Supabase 将 pgcrypto 安装在 extensions；保持受控 RPC 的合法申请路径可用。
-- vault.decrypted_secrets 已在函数体内使用完整 schema 名，不需要加入搜索路径。
ALTER FUNCTION public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  SET search_path = public, extensions;

COMMIT;
