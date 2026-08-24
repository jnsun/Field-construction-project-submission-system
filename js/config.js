/**
 * config.js - Supabase 客户端配置
 *
 * 使用前请将下方 URL 和 KEY 替换为您自己的 Supabase 项目凭据。
 * 获取方式：Supabase 控制台 -> Settings -> API
 *   - Project URL -> 填入 SUPABASE_URL
 *   - anon public key -> 填入 SUPABASE_ANON_KEY
 */

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
