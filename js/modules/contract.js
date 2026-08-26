// js/modules/contract.js —— 合同归档管理（占位模块）
// 实现时替换 render 内的内容，保持 render(app) 签名不变即可。
const ContractModule = {
  render(app) {
    app.innerHTML = `
      <div class="page">
        <div class="page-header">
          <button class="btn btn-sm" onclick="App.openDashboard()">← 返回工作台</button>
          <h1>合同归档管理</h1>
        </div>
        <div class="card"><div class="card-body">
          <p class="text-muted">该模块正在建设中，敬请期待。</p>
        </div></div>
      </div>`;
  }
};
