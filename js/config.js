/**
 * config.js - Supabase 客户端配置
 *
 * 使用前请将下方 URL 和 KEY 替换为您自己的 Supabase 项目凭据。
 * 获取方式：Supabase 控制台 -> Settings -> API
 *   - Project URL -> 填入 SUPABASE_URL
 *   - anon public key -> 填入 SUPABASE_ANON_KEY
 */

// 后端指向云端 Supabase（HTTPS）。
//
// ⚠️ GitHub Pages 是 HTTPS 站点，这里不能用 http:// 的自托管端点：
// 浏览器会把对 http:// 的 fetch 判定为「混合内容」直接拦截，
// 表现就是登录时报 Failed to fetch。同理，http://140.143.247.55 也无法在 Pages 上使用。
//
// 如将来要切回腾讯云自托管后端（140.143.247.55），必须同时满足两个前提：
//   1) 该站点本身提供 HTTPS（例如 https://test.safety.sx.cn）；
//   2) 其 Nginx 已正确反代 /auth/v1 与 /rest/v1，并返回允许 GitHub Pages 源站跨域的 CORS 头。
// 否则改回 http:// 只会再次登录失败。
const SUPABASE_URL = 'https://exwsuwhqqpsqekzkmdol.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4d3N1d2hxcXBzcWVremttZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzUyNTcsImV4cCI6MjEwMzExMTI1N30.bMqWlGbJ0IGL9mgT33r9IjUQiJ7E2dwADKHNU04ukW0';

// 初始化 Supabase 客户端（全局可用）
// 使用 try-catch 防止 SDK 加载失败时阻塞整个应用
let sb = null;

try {
  if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  } else {
    console.error('Supabase SDK 未加载，请检查 vendor/supabase.min.js 是否存在');
  }
} catch (e) {
  console.error('Supabase 客户端初始化失败:', e);
  sb = null;
}

// 资质证照模块：附件 Storage 桶名（sql/certificate-management.sql 中创建的私有桶）
const CERT_STORAGE_BUCKET = 'certificates';

// 附件限制：单文件最大 10MB，允许的类型
const CERT_FILE_MAX_SIZE = 10 * 1024 * 1024;
const CERT_FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
