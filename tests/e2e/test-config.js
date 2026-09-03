/**
 * 端到端测试配置只从本机环境变量读取，禁止在仓库中保存真实账号或密码。
 */
function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`缺少测试环境变量 ${name}，为避免误连云端，测试已停止。`);
  }
  return value;
}

module.exports = { required };
