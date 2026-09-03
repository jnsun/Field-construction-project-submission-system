-- ============================================================================
-- 手机号 + 密码登录连续性 v3
-- 前置：已执行 phone-password-login-v2.sql。
-- 作用：以后新增账号、管理员改号、员工自助改号时，始终保持“手机号 + 原密码”可登录。
-- 不启用短信 Provider，不读取 Cookie、密码或任何第三方服务。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_profile_phone_login_alias_before()
RETURNS TRIGGER AS $$
DECLARE v_alias TEXT;
BEGIN
  IF COALESCE(btrim(NEW.phone), '') ~ '^1[3-9][0-9]{9}$' THEN
    v_alias := lower(btrim(NEW.phone) || '@login.local');
    IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_alias AND u.id <> NEW.id) THEN
      RAISE EXCEPTION '该手机号的登录别名已被其他账号占用，请联系管理员核对';
    END IF;
    NEW.email := v_alias;
  ELSIF TG_OP = 'UPDATE'
     AND COALESCE(btrim(OLD.phone), '') ~ '^1[3-9][0-9]{9}$'
     AND lower(COALESCE(NEW.email, '')) LIKE '%@login.local' THEN
    RAISE EXCEPTION '该手机号正在作为登录名使用；如需清空手机号，请同时在账号管理中设置新的登录邮箱';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.sync_profile_phone_login_alias_after()
RETURNS TRIGGER AS $$
DECLARE v_alias TEXT;
BEGIN
  IF COALESCE(btrim(NEW.phone), '') ~ '^1[3-9][0-9]{9}$' THEN
    v_alias := lower(btrim(NEW.phone) || '@login.local');
    UPDATE auth.users
    SET email = v_alias,
        email_change = '',
        email_change_token_new = '',
        email_change_token_current = '',
        updated_at = NOW()
    WHERE id = NEW.id AND lower(COALESCE(email, '')) <> v_alias;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_profiles_phone_login_alias_before ON public.profiles;
CREATE TRIGGER trg_profiles_phone_login_alias_before
  BEFORE INSERT OR UPDATE OF phone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_phone_login_alias_before();

DROP TRIGGER IF EXISTS trg_profiles_phone_login_alias_after ON public.profiles;
CREATE TRIGGER trg_profiles_phone_login_alias_after
  AFTER INSERT OR UPDATE OF phone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_phone_login_alias_after();

-- 触发器建立后顺带修复以后补录了手机号但尚未切换登录别名的账号。
UPDATE public.profiles
SET phone = phone
WHERE COALESCE(btrim(phone), '') ~ '^1[3-9][0-9]{9}$'
  AND lower(COALESCE(email, '')) <> lower(btrim(phone) || '@login.local');

-- 核对：有手机号的账号必须显示手机号内部别名；密码哈希与用户 ID 不会变化。
SELECT p.full_name, p.phone, p.email AS login_alias,
       CASE WHEN u.email = p.email THEN '手机号登录已就绪' ELSE '请检查账号同步' END AS check_result
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.id
WHERE COALESCE(btrim(p.phone), '') ~ '^1[3-9][0-9]{9}$'
ORDER BY p.full_name NULLS LAST, p.phone;
