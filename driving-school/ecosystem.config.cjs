// pm2 进程定义:驾校报名管理服务(只监听本机 3200,由 nginx 的 /driving/ 转发)
// 配置与密码放在 /etc/driving-school.env(见 deploy/deploy-driving.sh 首次生成的模板)
module.exports = {
  apps: [
    {
      name: "driving-school",
      script: "server.mjs",
      cwd: "/opt/driving-school",
      node_args: "--env-file-if-exists=/etc/driving-school.env --disable-warning=ExperimentalWarning",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
