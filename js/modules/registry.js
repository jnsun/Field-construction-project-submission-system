/**
 * modules/registry.js —— 模块注册表（模块系统的单一入口）
 *
 * 所有业务模块在此登记，九宫格导航与路由都从这里读取，便于后期扩展：
 *   1. 在 js/modules/ 下新建一个文件，定义全局对象 XxxModule（含 render(app) 方法）
 *   2. 在本文件 modules 数组里追加一项，绑定 id / name / icon / desc / renderer
 * 无需改动 app.js 或 dashboard.js 的硬编码逻辑。
 *
 * icon 为内联 SVG（品牌色瓦片 + 白色符号，采用 Lucide 图标），不依赖系统 emoji 字体，跨平台一致显示。
 */
const ModuleRegistry = (() => {
  // 图标：纯文字首字母 + 渐变填充（品牌色），跨平台一致、清晰可读
  // 图标：纯文字首字母 + 渐变填充（品牌色），跨平台一致、清晰可读
  // 图标：纯文字首字母 + 渐变填充（品牌色），跨平台一致、清晰可读
  // 图标：emoji 字符（跨平台一致显示，依赖系统彩色 emoji 字体）
  const ICON = {
    report: '📋',
    qualification: '📜',
    inspection: '🛡️',
    vehicle: '🛠️',
    docstudy: '📖',
    performance: '📊',
    contract: '📁',
    training: '🎓',
    notice: '📢',
  };




  const modules = [
    { id: 'report', name: '野外施工项目报送', icon: ICON.report,
      desc: '月度施工项目信息报送与管理', ready: true,
      renderer: (app) => {
        if (Auth.isAdmin()) {
          Admin.render(app, { readOnly: false });
        } else if (Auth.canViewAdmin()) {
          Admin.render(app, { readOnly: true });
        } else {
          Reporter.render(app);
        }
      } },
    { id: 'qualification', name: '资质证照管理', icon: ICON.qualification,
      desc: '企业 / 人员资质证照台账', ready: true, trial: true,
      renderer: (app) => QualificationModule.render(app) },
    { id: 'inspection', name: '安全巡查记录', icon: ICON.inspection,
      desc: '现场安全巡检与隐患整改', renderer: (app) => InspectionModule.render(app) },
    { id: 'vehicle', name: '车辆管理', icon: ICON.vehicle,
      desc: '车辆台账与维保', renderer: (app) => VehicleModule.render(app) },
    { id: 'docstudy', name: '文件传达学习', icon: ICON.docstudy,
      desc: '文件传达与学习记录', renderer: (app) => DocStudyModule.render(app) },
    { id: 'performance', name: '安全绩效考核', icon: ICON.performance,
      desc: '安全绩效指标与评价', renderer: (app) => PerformanceModule.render(app) },
    { id: 'contract', name: '合同归档管理', icon: ICON.contract,
      desc: '合同台账与归档', renderer: (app) => ContractModule.render(app) },
    { id: 'training', name: '培训教育', icon: ICON.training, trial: true,
      desc: '培训计划 / 培训记录 / 考试管理', renderer: (app) => TrainingModule.render(app) },
    { id: 'notice', name: '公告通知中心', icon: ICON.notice,
      desc: '内部公告与消息通知', renderer: (app)  => NoticeModule.render(app) },
  ];

  const map = {};
  modules.forEach((m) => { map[m.id] = m; });

  return {
    list: modules,
    get: (id) => map[id] || null,
  };
})();
