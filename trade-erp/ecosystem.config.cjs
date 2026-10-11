// pm2 进程定义:进出口贸易管理系统(只监听本机 3300,由 nginx 的 /trade/ 转发)
// 配置与密钥放在 /etc/trade-erp.env(见 deploy/deploy-trade.sh 首次生成的模板)
module.exports = {
  apps: [
    {
      name: "trade-erp",
      script: "server.mjs",
      cwd: "/opt/trade-erp",
      node_args: "--env-file-if-exists=/etc/trade-erp.env --disable-warning=ExperimentalWarning",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "400M",
    },
  ],
};
