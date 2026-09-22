/**
 * config.js - Supabase 客户端配置
 *
 * 使用前请将下方 URL 和 KEY 替换为您自己的 Supabase 项目凭据。
 * 获取方式：Supabase 控制台 -> Settings -> API
 *   - Project URL -> 填入 SUPABASE_URL
 *   - anon public key -> 填入 SUPABASE_ANON_KEY
 */

// 运行时配置（js/config.runtime.js 注入，可选）。缺失或不是 https 时，回退到下面的默认值。
const runtimeConfig = globalThis.__SAFETY_SUPABASE_CONFIG__ || {};

// 默认后端 = 云端 Supabase。
// ⚠️ 必须是 https://：GitHub Pages 是 HTTPS 站点，任何指向 http:// 的请求都会被浏览器
// 按「混合内容」直接拦截，表现就是登录时报 Failed to fetch。
const DEFAULT_SUPABASE_URL = 'https://exwsuwhqqpsqekzkmdol.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4d3N1d2hxcXBzcWVremttZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzUyNTcsImV4cCI6MjEwMzExMTI1N30.bMqWlGbJ0IGL9mgT33r9IjUQiJ7E2dwADKHNU04ukW0';

// 只在注入值是 https 且非空时才采用它，避免一次错误的注入把站点打回 http://
const _rtUrl = (typeof runtimeConfig.url === 'string' && /^https:\/\//i.test(runtimeConfig.url)) ? runtimeConfig.url : '';
const _rtKey = (typeof runtimeConfig.anonKey === 'string' && runtimeConfig.anonKey) ? runtimeConfig.anonKey : '';

const SUPABASE_URL = _rtUrl || DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY = _rtKey || DEFAULT_SUPABASE_ANON_KEY;

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
