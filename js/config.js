/**
 * config.js - Supabase 客户端配置
 *
 * 使用前请将下方 URL 和 KEY 替换为您自己的 Supabase 项目凭据。
 * 获取方式：Supabase 控制台 -> Settings -> API
 *   - Project URL -> 填入 SUPABASE_URL
 *   - anon public key -> 填入 SUPABASE_ANON_KEY
 */

// 后端指向腾讯云自托管 Supabase（服务器 140.143.247.55，经 Nginx 同源反代）
// 如需回滚云 Supabase：把下面两行改回云端 Project URL 与 anon key 即可
const SUPABASE_URL = 'http://140.143.247.55';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg3OTIzMTgyLCJleHAiOjIxMDMyODMxODJ9.KnS6ejpGHGxOyET6KQdjwhFzWBcGNpHfoLKOfh-dTXU';

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
