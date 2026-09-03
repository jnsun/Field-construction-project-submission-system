-- ============================================================================
-- 手机号 + 原密码登录兼容迁移 v2
-- ============================================================================
-- 目标：已有账号可直接使用“profiles.phone + 原密码”登录，无需短信或 Twilio。
-- 原理：将有手机号的账户底层登录邮箱改为“手机号@login.local”。
--       仅改登录别名；用户 ID、原密码哈希、角色、部门和培训档案均不改变。
--
-- 执行前：请确认 profiles.phone 已填写正确且一个手机号只对应一个账号。
-- 执行后：有手机号的账号使用手机号登录；未绑定手机号的账号仍使用原邮箱登录。
-- 本脚本不开放任何匿名手机号查询接口，不会暴露账号是否存在。
-- 可重复执行。若发现重复手机号或别名冲突，会停止且不进行迁移。
-- ============================================================================

BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

-- 员工档案已绑定登录账号时，补齐空的账号手机号；不会覆盖账号端已有号码。
UPDATE public.profiles p
SET phone = e.phone,
    updated_at = NOW()
FROM public.training_employees e
WHERE p.employee_id = e.id
  AND COALESCE(btrim(p.phone), '') = ''
  AND btrim(COALESCE(e.phone, '')) ~ '^1[3-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles other
    WHERE other.id <> p.id AND btrim(COALESCE(other.phone, '')) = btrim(e.phone)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE btrim(COALESCE(p.phone, '')) ~ '^1[3-9][0-9]{9}$'
    GROUP BY btrim(p.phone)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '存在重复手机号，请先在账号管理中修正后再执行本脚本';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN auth.users u ON lower(u.email) = lower(btrim(p.phone) || '@login.local')
                    AND u.id <> p.id
    WHERE btrim(COALESCE(p.phone, '')) ~ '^1[3-9][0-9]{9}$'
  ) THEN
    RAISE EXCEPTION '存在已被其他账号占用的手机号登录别名，请联系管理员核对';
  END IF;
END;
$$;

-- 保留原邮箱到用户元数据中供后台追溯；不修改密码哈希或用户 ID。
UPDATE auth.users u
SET email = lower(btrim(p.phone) || '@login.local'),
    email_change = '',
    email_change_token_new = '',
    email_change_token_current = '',
    raw_user_meta_data = jsonb_set(
      COALESCE(u.raw_user_meta_data, '{}'::jsonb),
      '{original_login_email}',
      to_jsonb(u.email),
      true
    ),
    updated_at = NOW()
FROM public.profiles p
WHERE p.id = u.id
  AND btrim(COALESCE(p.phone, '')) ~ '^1[3-9][0-9]{9}$'
  AND lower(COALESCE(u.email, '')) <> lower(btrim(p.phone) || '@login.local');

UPDATE public.profiles p
SET email = lower(btrim(p.phone) || '@login.local'),
    updated_at = NOW()
WHERE btrim(COALESCE(p.phone, '')) ~ '^1[3-9][0-9]{9}$'
  AND lower(COALESCE(p.email, '')) <> lower(btrim(p.phone) || '@login.local');

COMMIT;

-- 执行后核对：结果中的 login_alias 即可作为内部登录名；页面仍只需输入手机号。
SELECT p.full_name,
       p.phone,
       p.email AS login_alias,
       CASE WHEN u.id IS NULL THEN '账号缺失' ELSE '可使用手机号+原密码登录' END AS check_result
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE btrim(COALESCE(p.phone, '')) ~ '^1[3-9][0-9]{9}$'
ORDER BY p.full_name NULLS LAST, p.phone;
