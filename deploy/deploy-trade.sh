#!/usr/bin/env bash
# ============================================================
# 进出口贸易管理系统部署(在阿里云服务器上,于仓库根目录执行):
#   cd /root/kmst && git pull && bash deploy/deploy-trade.sh
#
# 做的事:
#   1. trade-erp 同步到 /opt/trade-erp,pm2 启动/重启(数据与附件在 /var/lib/trade-erp,不受影响)
#   2. 首次生成 /etc/trade-erp.env(含随机管理员密码;企查查/天眼查密钥也填在这里)
#   3. 每日 02:50 自动备份数据库和附件到 /var/backups/trade-erp
#   4. nginx 增加 /trade/ 转发
# 不改平台源码,不需要重建后台界面。
# ============================================================
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TE_DIR="/opt/trade-erp"
ENV_FILE="/etc/trade-erp.env"

echo "==> [1/3] 部署进出口贸易服务"
mkdir -p "$TE_DIR" /var/lib/trade-erp/files
cp -r "$REPO_DIR/trade-erp/." "$TE_DIR/"
if [[ ! -f "$ENV_FILE" ]]; then
  PASS=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-12)
  cat > "$ENV_FILE" <<EOT
# 进出口贸易管理系统配置(改完执行 pm2 restart trade-erp 生效)
TE_PORT=3300
TE_DATA_DIR=/var/lib/trade-erp
# 首次启动时创建的管理员 admin 的密码(之后在系统里改密码,这里不再生效)
TE_ADMIN_PASSWORD=$PASS
# 登录会话签名密钥(更换后所有人需重新登录)
TE_SESSION_SECRET=$(openssl rand -hex 32)

# 工商信息接口(二选一,都填优先天眼查),用于客商资料自动获取和风险扫描
TIANYANCHA_TOKEN=
QICHACHA_KEY=
QICHACHA_SECRET=
EOT
  echo "    已生成 $ENV_FILE,管理员账号 admin,初始密码:$PASS"
fi
chmod 600 "$ENV_FILE"
pm2 startOrReload "$TE_DIR/ecosystem.config.cjs" >/dev/null
pm2 save >/dev/null
for i in $(seq 1 15); do curl -sf -o /dev/null http://127.0.0.1:3300/trade/api/health && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:3300/trade/api/health || { echo "❌ trade-erp 没起来:pm2 logs trade-erp --err --lines 50 --nostream"; exit 1; }
echo "    trade-erp 运行正常"

echo "==> [2/3] 每日备份"
echo "50 2 * * * root /usr/local/bin/node $TE_DIR/backup.mjs >> /var/log/trade-erp-backup.log 2>&1" > /etc/cron.d/trade-erp-backup
chmod 644 /etc/cron.d/trade-erp-backup
/usr/local/bin/node --disable-warning=ExperimentalWarning "$TE_DIR/backup.mjs"

echo "==> [3/3] nginx 转发 /trade/"
cp /etc/nginx/sites-available/xiyejia "/etc/nginx/sites-available/xiyejia.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$REPO_DIR/deploy/nginx-xiyejia.conf" /etc/nginx/sites-available/xiyejia
ln -sf /etc/nginx/sites-available/xiyejia /etc/nginx/sites-enabled/xiyejia
nginx -t
systemctl reload nginx

curl -sf -o /dev/null http://127.0.0.1/trade/ && echo "🎉 部署完成:http://<服务器IP>/trade/" || { echo "❌ nginx 转发不通,检查 /etc/nginx/sites-available/xiyejia"; exit 1; }
