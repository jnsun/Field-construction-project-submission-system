const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const failures = [];
const check = (label, passed) => { if (!passed) failures.push(label); };

const v1 = read('sql/training-admission-v1.sql');
const v53 = read('sql/training-admission-v53-project-code-allocation-boundary.sql');
const projects = read('js/modules/training/projects.js');
const manifest = JSON.parse(read('sql/training-admission-v17-v49.manifest.json'));
const entry = manifest.migrations.find(item => item.version === 53);
const digest = crypto.createHash('sha256').update(v53).digest('hex').toUpperCase();

check('项目编号必须由数据库序列 nextval 生成', /CREATE OR REPLACE FUNCTION public\.next_site_project_code\(\)[\s\S]*nextval\('public\.site_project_code_seq'\)/i.test(v1));
check('项目编号列必须非空、唯一并默认自动生成', /project_code\s+TEXT\s+NOT NULL\s+UNIQUE\s+DEFAULT public\.next_site_project_code\(\)/i.test(v1));
check('项目创建接口不得接收调用方指定的项目编号', /CREATE FUNCTION public\.site_project_create\(\s*p_name TEXT/i.test(v1));
check('项目创建审计必须保存包含项目编号的新记录快照', /site_project_audit_trigger\(\)[\s\S]*'new',\s*to_jsonb\(NEW\)/i.test(v1));
check('Web 新建表单不得提供项目编号输入框', !/id=["']site-project-code["']/i.test(projects));
check('D06 迁移必须撤销登录用户直接调用编号生成器的权限', /REVOKE ALL ON FUNCTION public\.next_site_project_code\(\)[\s\S]*FROM PUBLIC, anon, authenticated/i.test(v53));
check('v53 必须登记到迁移清单且校验和一致', entry && entry.file === 'training-admission-v53-project-code-allocation-boundary.sql' && entry.sha256 === digest);

if (failures.length) {
  console.error('D06 项目编号定向检查失败：');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('D06 项目编号定向检查通过：数据库序列、唯一约束、审计快照、页面只读及生成器权限边界共 7 项。');
