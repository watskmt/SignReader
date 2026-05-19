#!/usr/bin/env bash
# SignReader Nginx + SSL 設定スクリプト
# 使い方: ./scripts/setup-nginx.sh [setup|cert|deploy|renew|status]
#   setup  — nginx コンテナの設定と起動（HTTPのみ）
#   cert   — Let's Encrypt SSL 証明書を取得
#   deploy — 設定をHTTPSに切り替え、nginx 再起動
#   renew  — SSL 証明書を更新
#   status — nginx/SSL の状態を確認

set -euo pipefail

# ─────────────────────────────── 設定 ─────────────────────────────────────────

SERVER_USER="${SERVER_USER:-rocky}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_PORT="${SERVER_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/signreader}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"

# SSH キー設定
SSH_KEY_FILE=""
if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
    SSH_KEY_FILE=$(mktemp)
    chmod 600 "$SSH_KEY_FILE"
    if [[ -f "$DEPLOY_SSH_KEY" ]]; then
        cp "$DEPLOY_SSH_KEY" "$SSH_KEY_FILE"
    else
        echo "$DEPLOY_SSH_KEY" > "$SSH_KEY_FILE"
    fi
    trap 'rm -f "$SSH_KEY_FILE"' EXIT
fi

# ─────────────────────────────── ヘルパー ─────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

SSH_OPTS=""
if [[ -n "$SSH_KEY_FILE" ]]; then
    SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no"
fi

ssh_cmd() { ssh $SSH_OPTS -p "$SERVER_PORT" "${SERVER_USER}@${SERVER_HOST}" "$@"; }
scp_file() { scp $SSH_OPTS -P "$SERVER_PORT" "$1" "${SERVER_USER}@${SERVER_HOST}:$2"; }

check_config() {
    if [[ -z "$SERVER_HOST" ]]; then error "SERVER_HOST が未設定です"; fi
    if [[ -z "$DOMAIN" ]]; then error "DOMAIN が未設定です。例: export DOMAIN=api.signreader.amtech-service.com"; fi
}

COMPOSE_CMD="docker compose -f docker-compose.prod.yml -f docker-compose.nginx.yml"

# ─────────────────────────────── setup ────────────────────────────────────────

cmd_setup() {
    check_config
    info "nginx 設定を開始します: ${DOMAIN}"

    # 1. docker-compose.nginx.yml を転送
    info "docker-compose.nginx.yml を転送中..."
    scp_file backend/docker-compose.nginx.yml "${DEPLOY_DIR}/backend/docker-compose.nginx.yml"

    # 2. HTTP用のnginx.confを転送
    info "nginx.conf (HTTP) を転送中..."
    sed "s/\${DOMAIN}/${DOMAIN}/g" backend/nginx-http.conf > /tmp/nginx.conf
    scp_file /tmp/nginx.conf "${DEPLOY_DIR}/backend/nginx.conf"
    rm -f /tmp/nginx.conf

    # 3. nginxを起動
    info "nginx を起動中..."
    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend
${COMPOSE_CMD} up -d nginx
REMOTE

    info "nginx 設定完了。次のステップ:"
    info "  1. DNSのAレコードが ${DOMAIN} → ${SERVER_HOST} になっているか確認"
    info "  2. ./scripts/setup-nginx.sh cert  # SSL 証明書を取得"
    info "  3. ./scripts/setup-nginx.sh deploy # HTTPS に切り替え"
}

# ─────────────────────────────── cert ─────────────────────────────────────────

cmd_cert() {
    check_config
    info "SSL 証明書を取得します: ${DOMAIN}"

    # DNS確認
    info "DNS解決を確認中..."
    RESOLVED_IP=$(dig +short "${DOMAIN}" @8.8.8.8 2>/dev/null || echo "")
    if [[ "$RESOLVED_IP" != "$SERVER_HOST" ]]; then
        warn "DNSのIPアドレス (${RESOLVED_IP}) とサーバー (${SERVER_HOST}) が一致しません"
        warn "証明書取得に失敗する可能性があります。DNS設定を確認してください。"
        read -p "続行しますか？ (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            error "中止しました"
        fi
    fi

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

# nginx を停止（ポート80を解放）
${COMPOSE_CMD} stop nginx

# 証明書取得
sudo docker run --rm -p 80:80 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v ${DEPLOY_DIR}/backend/certbot-data:/var/www/certbot \
    certbot/certbot certonly \
    --standalone \
    -d ${DOMAIN} \
    --non-interactive \
    --agree-tos \
    --email ${EMAIL} \
    --keep-until-expiring

# 権限修正
sudo chown -R ${SERVER_USER}:${SERVER_USER} /etc/letsencrypt

# nginx を再起動
${COMPOSE_CMD} up -d nginx
REMOTE

    info "SSL 証明書取得完了！"
    info "次のステップ: ./scripts/setup-nginx.sh deploy"
}

# ─────────────────────────────── deploy ───────────────────────────────────────

cmd_deploy() {
    check_config
    info "HTTPS 設定を適用します..."

    # HTTPS用のnginx.confを転送
    info "nginx.conf (HTTPS) を転送中..."
    sed "s/\${DOMAIN}/${DOMAIN}/g" backend/nginx-https.conf > /tmp/nginx.conf
    scp_file /tmp/nginx.conf "${DEPLOY_DIR}/backend/nginx.conf"
    rm -f /tmp/nginx.conf

    # nginxを再起動
    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

# 設定テスト
docker compose -f docker-compose.nginx.yml exec -T nginx nginx -t

# リロード
${COMPOSE_CMD} exec -T nginx nginx -s reload || ${COMPOSE_CMD} up -d --force-recreate nginx
REMOTE

    # ヘルスチェック
    sleep 2
    info "ヘルスチェック中..."
    if ssh_cmd "curl -sfk https://${DOMAIN}/health > /dev/null"; then
        info "HTTPS 接続成功！"
        info "  https://${DOMAIN}/health"
    else
        warn "HTTPS 接続に失敗しました。ログを確認してください"
        ssh_cmd "cd ${DEPLOY_DIR}/backend && ${COMPOSE_CMD} logs nginx --tail=20"
    fi
}

# ─────────────────────── admin-cert (管理画面用SSL) ───────────────────────────

ADMIN_DOMAIN="admin.signreader.amtech-service.com"

cmd_admin_cert() {
    check_config
    info "管理画面用 SSL 証明書を取得します: ${ADMIN_DOMAIN}"

    info "DNS解決を確認中..."
    RESOLVED_IP=$(dig +short "${ADMIN_DOMAIN}" @8.8.8.8 2>/dev/null || echo "")
    if [[ "$RESOLVED_IP" != "$SERVER_HOST" ]]; then
        warn "DNSのIPアドレス (${RESOLVED_IP}) とサーバー (${SERVER_HOST}) が一致しません"
        warn "証明書取得に失敗する可能性があります。DNS設定を確認してください。"
        read -p "続行しますか？ (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            error "中止しました"
        fi
    fi

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

${COMPOSE_CMD} stop nginx

sudo docker run --rm -p 80:80 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v ${DEPLOY_DIR}/backend/certbot-data:/var/www/certbot \
    certbot/certbot certonly \
    --standalone \
    -d ${ADMIN_DOMAIN} \
    --non-interactive \
    --agree-tos \
    --email ${EMAIL} \
    --keep-until-expiring

sudo chown -R ${SERVER_USER}:${SERVER_USER} /etc/letsencrypt

${COMPOSE_CMD} up -d nginx
REMOTE

    info "管理画面用 SSL 証明書取得完了！"
    info "次のステップ: ./scripts/setup-nginx.sh deploy"
}

# ─────────────────────────────── renew ────────────────────────────────────────

cmd_renew() {
    check_config
    info "SSL 証明書を更新します..."

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

# nginx を一時停止
${COMPOSE_CMD} stop nginx

# 更新
sudo docker run --rm -p 80:80 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v ${DEPLOY_DIR}/backend/certbot-data:/var/www/certbot \
    certbot/certbot renew \
    --non-interactive \
    --quiet

# nginx 再起動
${COMPOSE_CMD} up -d nginx
REMOTE

    info "証明書更新完了"
}

# ─────────────────────────────── status ───────────────────────────────────────

cmd_status() {
    check_config
    info "nginx 状態を確認中..."

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

echo "=== コンテナ状態 ==="
${COMPOSE_CMD} ps nginx

echo ""
echo "=== SSL 証明書有効期限 (API) ==="
if sudo test -d /etc/letsencrypt/live/${DOMAIN}; then
    sudo openssl x509 -in /etc/letsencrypt/live/${DOMAIN}/cert.pem -noout -dates
else
    echo "証明書が見つかりません"
fi

echo ""
echo "=== SSL 証明書有効期限 (Admin) ==="
if sudo test -d /etc/letsencrypt/live/${ADMIN_DOMAIN}; then
    sudo openssl x509 -in /etc/letsencrypt/live/${ADMIN_DOMAIN}/cert.pem -noout -dates
else
    echo "証明書が見つかりません"
fi

echo ""
echo "=== HTTP ヘルスチェック ==="
curl -sf http://${DOMAIN}/health 2>/dev/null | python3 -m json.tool || echo "HTTP 未応答"

echo ""
echo "=== HTTPS ヘルスチェック ==="
curl -sfk https://${DOMAIN}/health 2>/dev/null | python3 -m json.tool || echo "HTTPS 未応答"
REMOTE
}

# ─────────────────────────────── エントリーポイント ───────────────────────────

COMMAND="${1:-setup}"

case "$COMMAND" in
    setup)      cmd_setup ;;
    cert)       cmd_cert ;;
    admin-cert) cmd_admin_cert ;;
    deploy)     cmd_deploy ;;
    renew)      cmd_renew ;;
    status)     cmd_status ;;
    *)
        echo "使い方: $0 [setup|cert|admin-cert|deploy|renew|status]"
        echo ""
        echo "  setup       nginx コンテナの設定と起動（HTTP）"
        echo "  cert        Let's Encrypt SSL 証明書を取得 (api.signreader.amtech-service.com)"
        echo "  admin-cert  管理画面用 SSL 証明書を取得 (admin.signreader.amtech-service.com)"
        echo "  deploy      HTTPS 設定に切り替え"
        echo "  renew       SSL 証明書を更新"
        echo "  status      nginx/SSL の状態を確認"
        echo ""
        echo "環境変数:"
        echo "  SERVER_HOST=157.120.32.158                デプロイ先サーバー（必須）"
        echo "  DOMAIN=api.signreader.amtech-service.com  ドメイン名（必須）"
        echo "  EMAIL=admin@example.com                   Let's Encrypt 登録用メール"
        exit 1
        ;;
esac
