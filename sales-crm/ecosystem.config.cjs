// pm2 进程定义:销售管理服务(只监听本机 3100,由 nginx 的 /sales-api/ 转发)
// 配置与密钥放在 /etc/sales-crm.env(见 deploy/deploy.sh 首次生成的模板)
module.exports = {
  apps: [
    {
      name: "sales-crm",
      script: "server.mjs",
      cwd: "/opt/sales-crm",
      node_args: "--env-file-if-exists=/etc/sales-crm.env --disable-warning=ExperimentalWarning",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
    },
  ],
};
