/**
 * modules/registry.js —— 模块注册表（模块系统的单一入口）
 *
 * 所有业务模块在此登记，九宫格导航与路由都从这里读取，便于后期扩展：
 *   1. 在 js/modules/ 下新建一个文件，定义全局对象 XxxModule（含 render(app) 方法）
 *   2. 在本文件 modules 数组里追加一项，绑定 id / name / icon / desc / renderer
 * 无需改动 app.js 或 dashboard.js 的硬编码逻辑。
 */
const ModuleRegistry = (() => {
  const modules = [
    {
      id: 'report',
      name: '野外施工项目报送',
      icon: '📋',
      desc: '月度施工项目信息报送与管理',
      ready: true,
      renderer: (app) => { if (Auth.isAdmin()) Admin.render(app); else Reporter.render(app); }
    },
    {
      id: 'qualification',
      name: '资质证照管理',
      icon: '📜',
      desc: '企业 / 人员资质证照台账',
      renderer: (app) => QualificationModule.render(app)
    },
    {
      id: 'inspection',
      name: '安全巡查记录',
      icon: '🛡️',
      desc: '现场安全巡检与隐患整改',
      renderer: (app) => InspectionModule.render(app)
    },
    {
      id: 'vehicle',
      name: '车辆管理',
      icon: '🛠️',
      desc: '车辆台账与维保',
      renderer: (app) => VehicleModule.render(app)
    },
    {
      id: 'docstudy',
      name: '文件传达学习',
      icon: '📖',
      desc: '文件传达与学习记录',
      renderer: (app) => DocStudyModule.render(app)
    },
    {
      id: 'performance',
      name: '安全绩效考核',
      icon: '📊',
      desc: '安全绩效指标与评价',
      renderer: (app) => PerformanceModule.render(app)
  },
    {
      id: 'contract',
      name: '合同归档管理',
      icon: '📁',
      desc: '合同台账与归档',
      renderer: (app) => ContractModule.render(app)
    },
    {
      id: 'training',
      name: '培训考试管理',
      icon: '🎓',
      desc: '培训计划与考试记录',
      renderer: (app) => TrainingModule.render(app)
    },
    {
      id: 'notice',
      name: '公告通知中心',
      icon: '📢',
      desc: '内部公告与消息通知',
      renderer: (app) => NoticeModule.render(app)
    },
  ];

  const map = {};
  modules.forEach((m) => { map[m.id] = m; });

  return {
    list: modules,
    get: (id) => map[id] || null,
  };
})();
