// js/modules/qualification.js —— 资质证照管理（入口模块）
// 分发规则：管理员进入可写的管理后台（CertAdmin），其余账号进入只读台账（Certs）。
// CertAdmin / Certs / CertImport 的定义见同目录下的 admin.js / certs.js / import.js。
const QualificationModule = {
  async render(app) {
    if (Auth.isAdmin()) {
      await CertAdmin.render(app);
    } else {
      await Certs.render(app);
    }
  }
};
