#!/usr/bin/env bash
# ============================================================
# 驾校培训报名管理系统部署(在阿里云服务器上,于仓库根目录执行):
#   cd /root/kmst && git pull && bash deploy/deploy-driving.sh
#
# 做的事:
#   1. driving-school 同步到 /opt/driving-school,pm2 启动/重启(数据在 /var/lib/driving-school,不受影响)
#   2. 首次生成 /etc/driving-school.env(含随机管理员密码)
#   3. 每日 02:40 自动备份数据库到 /var/backups/driving-school(保留 30 份)
#   4. nginx 增加 /driving/ 转发
# 不改平台源码,不需要重建后台界面。
# ============================================================
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DS_DIR="/opt/driving-school"
ENV_FILE="/etc/driving-school.env"

echo "==> [1/3] 部署驾校报名服务"
mkdir -p "$DS_DIR" /var/lib/driving-school
cp -r "$REPO_DIR/driving-school/." "$DS_DIR/"
if [[ ! -f "$ENV_FILE" ]]; then
  PASS=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-12)
  cat > "$ENV_FILE" <<EOF
# 驾校报名管理系统配置(改完执行 pm2 restart driving-school 生效)
DS_PORT=3200
DS_DB_FILE=/var/lib/driving-school/ds.db
# 管理后台 /driving/admin 登录密码
DS_ADMIN_PASSWORD=$PASS
# 登录会话签名密钥(更换后所有人需重新登录)
DS_SESSION_SECRET=$(openssl rand -hex 32)
EOF
  echo "    已生成 $ENV_FILE,管理后台初始密码:$PASS"
fi
chmod 600 "$ENV_FILE"
pm2 startOrReload "$DS_DIR/ecosystem.config.cjs" >/dev/null
pm2 save >/dev/null
for i in $(seq 1 15); do curl -sf -o /dev/null http://127.0.0.1:3200/driving/api/health && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:3200/driving/api/health || { echo "❌ driving-school 没起来:pm2 logs driving-school --err --lines 50 --nostream"; exit 1; }
echo "    driving-school 运行正常"

echo "==> [2/3] 每日备份"
echo "40 2 * * * root /usr/local/bin/node $DS_DIR/backup.mjs >> /var/log/driving-school-backup.log 2>&1" > /etc/cron.d/driving-school-backup
chmod 644 /etc/cron.d/driving-school-backup
/usr/local/bin/node "$DS_DIR/backup.mjs"

echo "==> [3/3] nginx 转发 /driving/"
cp /etc/nginx/sites-available/xiyejia "/etc/nginx/sites-available/xiyejia.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$REPO_DIR/deploy/nginx-xiyejia.conf" /etc/nginx/sites-available/xiyejia
ln -sf /etc/nginx/sites-available/xiyejia /etc/nginx/sites-enabled/xiyejia
nginx -t
systemctl reload nginx

curl -sf -o /dev/null http://127.0.0.1/driving/ && echo "🎉 部署完成:学员报名 http://<服务器IP>/driving/ ,管理后台 http://<服务器IP>/driving/admin" \
  || { echo "❌ nginx 转发不通,检查 /etc/nginx/sites-available/xiyejia"; exit 1; }
