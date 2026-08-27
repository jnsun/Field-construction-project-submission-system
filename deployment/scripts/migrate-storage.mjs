// =============================================================
// migrate-storage.mjs — 云 Supabase Storage → 自托管 Storage 附件搬运
//
// 用途：把旧项目 Storage 桶（如 certificates）里的所有文件搬到新实例。
// 零依赖（Node 18+ 原生 fetch），可中断后重跑续传。
//
// 在【本地电脑】执行：
//   OLD_PROJECT_URL=https://exwsuwhqqpsqekzkmdol.supabase.co \
//   OLD_SERVICE_ROLE_KEY=<云端service_role> \
//   NEW_PROJECT_URL=http://<服务器IP> \
//   NEW_SERVICE_ROLE_KEY=<新机service_role> \
//   node migrate-storage.mjs
//
// 可选环境变量：
//   ONLY_BUCKETS=certificates      只迁移指定桶（逗号分隔），默认全部
// =============================================================

const OLD_URL = process.env.OLD_PROJECT_URL?.replace(/\/+$/, '');
const NEW_URL = process.env.NEW_PROJECT_URL?.replace(/\/+$/, '');
const OLD_KEY = process.env.OLD_SERVICE_ROLE_KEY;
const NEW_KEY = process.env.NEW_SERVICE_ROLE_KEY;
const ONLY = process.env.ONLY_BUCKETS?.split(',').map(s => s.trim()).filter(Boolean) || null;

if (!OLD_URL || !NEW_URL || !OLD_KEY || !NEW_KEY) {
  console.error('缺少必填环境变量 OLD_PROJECT_URL / OLD_SERVICE_ROLE_KEY / NEW_PROJECT_URL / NEW_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(url, key, options = {}) {
  let lastErr;
  const isBody = options.body !== undefined;
  const isRaw = isBody && options.body instanceof ArrayBuffer;
  const headers = {
    Authorization: `Bearer ${key}`,
    apikey: key,
    ...(isBody && !isRaw ? { 'Content-Type': 'application/json' } : {}),
    ...(options.extraHeaders || {}),
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${url}${options.path}`, {
        method: options.method || 'GET',
        headers,
        ...(isBody ? { body: isRaw ? options.body : options.body } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
      }
      return res;
    } catch (e) {
      // 4xx 业务错误不重试（409 已存在 / 前端已处理）
      if (e.status && e.status < 500) throw e;
      lastErr = e;
      console.warn(`  网络错误(第${attempt}次)：${e.message}，重试中...`);
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function listBuckets(base, key) {
  const res = await api(base, key, { path: '/storage/v1/bucket' });
  return res.json();
}

async function ensureBucket(base, key, bucket) {
  try {
    await api(base, key, {
      path: '/storage/v1/bucket',
      method: 'POST',
      body: JSON.stringify({ name: bucket.name, public: !!bucket.public }),
    });
    console.log(`✓ 新端创建桶 ${bucket.name} (${bucket.public ? 'public' : 'private'})`);
  } catch (e) {
    if (/exist/i.test(e.message)) console.log(`• 桶 ${bucket.name} 已存在`);
    else throw e;
  }
}

// 递归遍历对象（先完整翻完一层，再深入子目录；用前缀栈避免分页错位）
const PAGE = 500;
async function* walkObjects(base, key, bucket) {
  const folders = [''];                        // 待处理的前缀栈
  while (folders.length) {
    const prefix = folders.pop();
    let offset = 0;
    while (true) {
      const res = await api(base, key, {
        path: `/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        method: 'POST',
        body: JSON.stringify({ prefix, limit: PAGE, offset }),
      });
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) break;

      for (const it of items) {
        if (!it.id) {                          // 目录项（id 为空）
          folders.push(it.name.endsWith('/') ? it.name : it.name + '/');
        } else {
          yield { name: it.name };             // 文件，name 为桶内全路径
        }
      }
      if (items.length < PAGE) break;
      offset += items.length;
    }
  }
}

async function uploadFile(bucket, path, arrayBuf, contentType) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `${NEW_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${NEW_KEY}`,
            apikey: NEW_KEY,
            'Content-Type': contentType || 'application/octet-stream',
            'x-upsert': 'true',
          },
          body: Buffer.from(arrayBuf),
        }
      );
      if (res.ok) return true;
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /Duplicate|exist/i.test(text)) return true; // 幂等
      throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      console.warn(`  上传失败(${attempt}/3): ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
  return false;
}

(async () => {
  console.log('== 获取源项目桶列表 ==');
  const oldBuckets = await listBuckets(OLD_URL, OLD_KEY);
  const targets = ONLY ? oldBuckets.filter(b => ONLY.includes(b.name)) : oldBuckets;
  if (targets.length === 0) { console.log('没有匹配的桶'); return; }

  let totalFiles = 0, totalBytes = 0, failures = [];

  for (const b of targets) {
    console.log(`\n===== 桶 ${b.name} =====`);
    await ensureBucket(NEW_URL, NEW_KEY, b);

    let count = 0;
    for (const obj of walkObjects(OLD_URL, OLD_KEY, b.name)) {
      count++;
      try {
        const dlRes = await api(OLD_URL, OLD_KEY, {
          path: `/storage/v1/object/${encodeURIComponent(b.name)}/${obj.name.split('/').map(encodeURIComponent).join('/')}`,
        });
        const buf = await dlRes.arrayBuffer();
        const ct = dlRes.headers.get('content-type') || '';
        const ok = await uploadFile(b.name, obj.name, buf, ct);
        if (ok) {
          totalFiles++;
          totalBytes += buf.byteLength;
          if (count % 20 === 0) console.log(`  已完成 ${count} 个文件…`);
        } else {
          failures.push(`${b.name}/${obj.name}`);
        }
      } catch (e) {
        console.error(`  ✗ ${b.name}/${obj.name}: ${e.message}`);
        failures.push(`${b.name}/${obj.name}`);
      }
    }
    console.log(`桶 ${b.name} 处理完毕：${count} 个文件`);
  }

  console.log('\n============================================');
  console.log(`共成功迁移 ${totalFiles} 个文件，约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (failures.length) {
    console.log(`失败清单 (${failures.length}) —— 重跑本脚本即可续传补齐：`);
    failures.forEach(f => console.log('  ✗ ' + f));
  }
})();
