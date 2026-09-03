/**
 * config.js - Supabase 客户端配置
 *
 * 使用前请将下方 URL 和 KEY 替换为您自己的 Supabase 项目凭据。
 * 获取方式：Supabase 控制台 -> Settings -> API
 *   - Project URL -> 填入 SUPABASE_URL
 *   - anon public key -> 填入 SUPABASE_ANON_KEY
 */

const runtimeConfig = globalThis.__SAFETY_SUPABASE_CONFIG__ || {};
const SUPABASE_URL = typeof runtimeConfig.url === 'string' ? runtimeConfig.url : 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = typeof runtimeConfig.anonKey === 'string' ? runtimeConfig.anonKey : 'YOUR_SUPABASE_ANON_KEY';

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
