#!/usr/bin/env bash
# ============================================================
# 销售管理模块部署(在阿里云服务器上,于仓库根目录执行):
#   cd /root/kmst && git pull && bash deploy/deploy.sh
#   bash deploy/deploy.sh --skip-ui   # 只更新后端服务,不重建后台界面
#
# 做的事:
#   1. 后端 sales-crm 同步到 /opt/sales-crm,pm2 启动/重启(数据在 /var/lib/sales-crm,不受影响)
#   2. 首次生成 /etc/sales-crm.env(工商接口密钥等配置写在这里)
#   3. 每日 02:30 自动备份数据库到 /var/backups/sales-crm(保留 30 份)
#   4. nginx 增加 /sales-api/ 转发
#   5. 销售管理页面装进平台后台源码并重建界面(失败时平台自动回滚到原界面)
# ============================================================
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/xiyejia-training"
CRM_DIR="/opt/sales-crm"
ENV_FILE="/etc/sales-crm.env"
SKIP_UI=0
[[ "${1:-}" == "--skip-ui" ]] && SKIP_UI=1

echo "==> [1/5] 部署销售管理服务"
mkdir -p "$CRM_DIR" /var/lib/sales-crm
cp -r "$REPO_DIR/sales-crm/." "$CRM_DIR/"
if [[ ! -f "$ENV_FILE" ]]; then
  TENANT_NAME=$(grep -E '^TENANT_NAME=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)
  cat > "$ENV_FILE" <<EOF
# 销售管理服务配置(改完执行 pm2 restart sales-crm 生效)
CRM_PORT=3100
CRM_DB_FILE=/var/lib/sales-crm/crm.db
CRM_PLATFORM_URL=http://127.0.0.1:3000
CRM_COMPANY_NAME=${TENANT_NAME}

# 工商信息接口(二选一,都填优先天眼查)
# 天眼查开放平台 https://open.tianyancha.com 「企业基本信息」+「搜索」接口的 token
TIANYANCHA_TOKEN=
# 企查查开放平台 https://openapi.qcc.com 的 key 和 secretKey
QICHACHA_KEY=
QICHACHA_SECRET=
EOF
  echo "    已生成 $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
# 平台端口取自平台 .env(nginx 接管 80 后平台在 3000)
PLATFORM_PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)
if [[ -n "$PLATFORM_PORT" && "$PLATFORM_PORT" != "3000" ]]; then
  echo "    ⚠️ 平台端口是 $PLATFORM_PORT,请同步修改 $ENV_FILE 的 CRM_PLATFORM_URL"
fi
pm2 startOrReload "$CRM_DIR/ecosystem.config.cjs" >/dev/null
pm2 save >/dev/null
for i in $(seq 1 15); do curl -sf -o /dev/null http://127.0.0.1:3100/sales-api/health && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:3100/sales-api/health || { echo "❌ sales-crm 没起来:pm2 logs sales-crm --err --lines 50 --nostream"; exit 1; }
echo "    sales-crm 运行正常"

echo "==> [2/5] 每日备份"
CRON_LINE="30 2 * * * root /usr/local/bin/node $CRM_DIR/backup.mjs >> /var/log/sales-crm-backup.log 2>&1"
echo "$CRON_LINE" > /etc/cron.d/sales-crm-backup
chmod 644 /etc/cron.d/sales-crm-backup
/usr/local/bin/node "$CRM_DIR/backup.mjs"

echo "==> [3/5] nginx 转发 /sales-api/"
cp /etc/nginx/sites-available/xiyejia "/etc/nginx/sites-available/xiyejia.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$REPO_DIR/deploy/nginx-xiyejia.conf" /etc/nginx/sites-available/xiyejia
ln -sf /etc/nginx/sites-available/xiyejia /etc/nginx/sites-enabled/xiyejia
nginx -t
systemctl reload nginx

if [[ $SKIP_UI -eq 1 ]]; then
  echo "==> 跳过界面重建(--skip-ui)"
  exit 0
fi

echo "==> [4/5] 安装销售管理页面并重建后台界面(约 1-3 分钟)"
node "$REPO_DIR/deploy/apply-ui.mjs" "$APP_DIR"
bash "$APP_DIR/rebuild-ui.sh"

echo "==> [5/5] 预压缩前端资源(小带宽下加速首次加载)"
find "$APP_DIR/dist/public" -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" -o -name "*.svg" -o -name "*.json" -o -name "*.wasm" \) \
  -size +1k -exec gzip -9 -k -f {} \;

for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1/ && break; sleep 2; done
curl -sf -o /dev/null http://127.0.0.1/ && echo "🎉 部署完成:后台左侧菜单「销售管理」" || { echo "❌ 平台未响应:pm2 logs my-agent-platform --err --lines 50 --nostream"; exit 1; }
