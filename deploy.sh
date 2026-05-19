#!/usr/bin/env bash
# SignReader デプロイスクリプト
# 使い方: ./deploy.sh [setup|deploy|rollback|status|logs]
#   setup    — サーバーの初期セットアップ（初回のみ）
#   deploy   — 最新コードをデプロイ（デフォルト）
#   rollback — 直前のバージョンに戻す
#   status   — サービス状態を確認
#   logs     — ログを表示

set -euo pipefail

# ─────────────────────────────── ヘルパー ─────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─────────────────────────────── 設定 ─────────────────────────────────────────

SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_HOST="${SERVER_HOST:-}"          # 例: 192.168.1.100 または example.com
SERVER_PORT="${SERVER_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/signreader}"
GIT_BRANCH="${GIT_BRANCH:-main}"
COMPOSE_FILE="backend/docker-compose.prod.yml"

# SSH キー設定
# DEPLOY_SSH_KEY は秘密鍵ファイルへのパス
SSH_KEY_FILE="${DEPLOY_SSH_KEY:-}"
if [[ -n "$SSH_KEY_FILE" ]]; then
    # ~ を展開
    SSH_KEY_FILE="${SSH_KEY_FILE/#\~/$HOME}"
    if [[ ! -f "$SSH_KEY_FILE" ]]; then
        error "SSH 鍵ファイルが見つかりません: $SSH_KEY_FILE (DEPLOY_SSH_KEY=$DEPLOY_SSH_KEY)"
    fi
    # 鍵ファイルの形式を簡易チェック (PEM 形式のヘッダーがあるか)
    if ! head -n 1 "$SSH_KEY_FILE" | grep -q "BEGIN "; then
        warn "警告: SSH 鍵ファイルが正しい PEM 形式（-----BEGIN ...）でない可能性があります。"
    fi
    chmod 600 "$SSH_KEY_FILE"
fi

SSH_OPTS=""
if [[ -n "$SSH_KEY_FILE" ]]; then
    SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no"
fi

ssh_cmd() { ssh $SSH_OPTS -p "$SERVER_PORT" -o ConnectTimeout=15 "${SERVER_USER}@${SERVER_HOST}" "$@"; }
scp_file() { scp $SSH_OPTS -P "$SERVER_PORT" -o ConnectTimeout=15 "$1" "${SERVER_USER}@${SERVER_HOST}:$2"; }

check_config() {
    if [[ -z "$SERVER_HOST" ]]; then error "SERVER_HOST が未設定です。例: export SERVER_HOST=192.168.1.100"; fi
}

# ─────────────────────────────── setup ────────────────────────────────────────

cmd_setup() {
    check_config
    info "サーバーの初期セットアップを開始します: ${SERVER_HOST}"

    ssh_cmd bash << 'REMOTE'
set -euo pipefail

# Docker のインストール
if ! command -v docker &>/dev/null; then
    echo "Docker をインストール中..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER"
    echo "Docker インストール完了（再ログインが必要な場合があります）"
fi

# Docker Compose Plugin の確認
if ! docker compose version &>/dev/null; then
    echo "Docker Compose Plugin をインストール中..."
    sudo apt-get update -qq
    sudo apt-get install -y docker-compose-plugin
fi

# デプロイディレクトリを作成
sudo mkdir -p /opt/signreader
sudo chown "$USER:$USER" /opt/signreader

echo "セットアップ完了"
REMOTE

    info "セットアップが完了しました"
    info "次のステップ:"
    info "  1. .env.prod を作成: cp backend/.env.prod.example backend/.env.prod && vi backend/.env.prod"
    info "  2. デプロイ: ./deploy.sh deploy"
}

# ─────────────────────────────── deploy ───────────────────────────────────────

cmd_deploy() {
    check_config

    # .env.prod の存在確認
    if [[ ! -f "backend/.env.prod" ]]; then error ".env.prod が見つかりません。backend/.env.prod.example をコピーして設定してください"; fi

    info "デプロイを開始します → ${SERVER_HOST}:${DEPLOY_DIR}"

    # 現在のコミットを記録（ロールバック用）
    CURRENT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    info "デプロイするバージョン: ${CURRENT_SHA} (branch: ${GIT_BRANCH})"

    # ─── Docker 未インストール時は自動インストール ──────────────────────────

    info "Docker の状態を確認中..."
    if ! ssh_cmd "docker --version" 2>/dev/null; then
        warn "Docker が見つかりません。インストールを開始します..."
        ssh_cmd bash << 'REMOTE'
set -euo pipefail
if ! command -v docker &>/dev/null; then
    if command -v dnf &>/dev/null; then
        sudo dnf install -y dnf-utils
        sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    elif command -v apt-get &>/dev/null; then
        curl -fsSL https://get.docker.com | sh
    fi
    sudo usermod -aG docker "$USER"
fi
echo "Docker インストール完了"
REMOTE
    fi

    info "Docker デーモンを起動中..."
    ssh_cmd bash << 'REMOTE'
set -euo pipefail

# kernel 6.12（EL10系）では nftables ネイティブモードが必要
sudo mkdir -p /etc/docker
echo '{"firewall-backend": "nftables"}' | sudo tee /etc/docker/daemon.json > /dev/null

sudo modprobe br_netfilter 2>/dev/null || true
sudo modprobe overlay 2>/dev/null || true
sudo sysctl -w net.ipv4.ip_forward=1 > /dev/null
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-docker.conf > /dev/null

if ! docker info &>/dev/null; then
    sudo systemctl enable docker
    sudo systemctl start docker || {
        echo "Docker 起動に失敗しました。journalctl -xeu docker.service を確認してください"
        sudo journalctl -xeu docker.service --no-pager -n 20
        exit 1
    }
    sleep 2
    echo "Docker デーモン起動完了"
else
    echo "Docker デーモンは既に稼働中"
fi
REMOTE

    # ─── ファイル転送 ───────────────────────────────────────────────────────

    info "ファイルを転送中..."
    ssh_cmd "mkdir -p ${DEPLOY_DIR}/backend ${DEPLOY_DIR}/backend/app ${DEPLOY_DIR}/backend/app/services"

    # backend ファイル一式を rsync で転送（node_modules / venv / __pycache__ 除外）
    rsync -az --delete \
        --exclude='venv/' \
        --exclude='__pycache__/' \
        --exclude='*.pyc' \
        --exclude='.pytest_cache/' \
        --exclude='htmlcov/' \
        --exclude='*.egg-info/' \
        -e "ssh $SSH_OPTS -p ${SERVER_PORT}" \
        backend/ \
        "${SERVER_USER}@${SERVER_HOST}:${DEPLOY_DIR}/backend/"

    # .env.prod を転送
    scp_file "backend/.env.prod" "${DEPLOY_DIR}/backend/.env.prod"

    # nginx-https.conf を nginx.conf として配置（YOUR_DOMAIN 残留を防ぐ）
    info "nginx.conf を更新中..."
    ssh_cmd "cp ${DEPLOY_DIR}/backend/nginx-https.conf ${DEPLOY_DIR}/backend/nginx.conf"

    # ─── リモートでビルド＆起動 ─────────────────────────────────────────────

    info "サービスをビルド・起動中..."
    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

# 直前のイメージタグを保存（ロールバック用）
docker images signreader-api --format "{{.ID}}" | head -1 > /tmp/signreader_prev_image || true

# ディスク空き確認 → 残量 < 2GB なら dangling イメージ・ビルドキャッシュを削除
AVAIL_KB=\$(df --output=avail /var/lib/docker 2>/dev/null | tail -1 || df --output=avail / | tail -1)
if [ "\${AVAIL_KB:-0}" -lt 2097152 ]; then
    echo "ディスク残量が少ないため不要なイメージ・キャッシュを削除します (avail=\${AVAIL_KB}KB)..."
    docker image prune -f
    docker builder prune -f
fi

# イメージをビルド（--no-cache は使わない: OOMでsshdが落ちる原因になる）
docker compose -f docker-compose.prod.yml build api worker

# ゼロダウンタイムでサービスを更新（nginx は別管理のため --remove-orphans は使わない）
docker compose -f docker-compose.prod.yml up -d

# nginx を再起動して設定・証明書を最新化
docker restart signreader-nginx 2>/dev/null || true

# ip_forward はDockerの操作で無効化されることがあるため毎回確認
sudo sysctl -w net.ipv4.ip_forward=1 > /dev/null

# ヘルスチェック待機（最大60秒）
echo "API の起動を待機中..."
for i in \$(seq 1 12); do
    if docker compose -f docker-compose.prod.yml exec -T api curl -sf http://localhost:8000/health > /dev/null 2>&1; then
        echo "API が正常に起動しました"
        break
    fi
    echo "  待機中... (\${i}/12)"
    sleep 5
done

# デプロイ結果の確認
docker compose -f docker-compose.prod.yml ps
REMOTE

    info "デプロイ完了！"
    info "API: http://${SERVER_HOST}:8000/health"
}

# ─────────────────────────────── rollback ─────────────────────────────────────

cmd_rollback() {
    check_config
    warn "直前のバージョンにロールバックします"

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

PREV_IMAGE=\$(cat /tmp/signreader_prev_image 2>/dev/null || echo "")
if [[ -z "\$PREV_IMAGE" ]]; then
    echo "ロールバック先のイメージが見つかりません"
    exit 1
fi

echo "ロールバック先イメージ: \$PREV_IMAGE"
docker compose -f docker-compose.prod.yml stop api worker
docker tag "\$PREV_IMAGE" signreader-api:latest
docker compose -f docker-compose.prod.yml up -d api worker
echo "ロールバック完了"
REMOTE
}

# ─────────────────────────────── status ───────────────────────────────────────

cmd_status() {
    check_config
    info "サービス状態を確認中: ${SERVER_HOST}"

    ssh_cmd bash << REMOTE
set -euo pipefail
cd ${DEPLOY_DIR}/backend

echo "=== コンテナ状態 ==="
docker compose -f docker-compose.prod.yml ps

echo ""
echo "=== ヘルスチェック ==="
curl -s http://localhost:8000/health | python3 -m json.tool 2>/dev/null || echo "API 未応答"

echo ""
echo "=== ディスク使用量 ==="
df -h /opt/signreader

echo ""
echo "=== メモリ ==="
free -h
REMOTE
}

# ─────────────────────────────── logs ─────────────────────────────────────────

cmd_logs() {
    check_config
    SERVICE="${2:-api}"
    info "${SERVICE} のログを表示します（Ctrl+C で終了）"
    ssh_cmd "cd ${DEPLOY_DIR}/backend && docker compose -f docker-compose.prod.yml logs -f --tail=100 ${SERVICE}"
}

# ─────────────────────────────── SSL 設定 ─────────────────────────────────────

cmd_ssl() {
    check_config
    if [[ -z "${DOMAIN:-}" ]]; then error "DOMAIN が未設定です。例: export DOMAIN=api.example.com"; fi

    info "SSL 証明書を取得します: ${DOMAIN}"
    ssh_cmd bash << REMOTE
set -euo pipefail

# certbot のインストール
if ! command -v certbot &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y certbot
fi

# nginx を一時停止して証明書取得
docker compose -f ${DEPLOY_DIR}/backend/docker-compose.prod.yml stop nginx 2>/dev/null || true

sudo certbot certonly --standalone \
    -d ${DOMAIN} \
    --non-interactive \
    --agree-tos \
    --email admin@${DOMAIN}

# nginx.conf のドメインを置換
sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" ${DEPLOY_DIR}/backend/nginx.conf

# nginx を再起動
docker compose -f ${DEPLOY_DIR}/backend/docker-compose.prod.yml up -d nginx
echo "SSL 設定完了"
REMOTE
}

# ─────────────────────────────── エントリーポイント ───────────────────────────

COMMAND="${1:-deploy}"

case "$COMMAND" in
    setup)    cmd_setup ;;
    deploy)   cmd_deploy ;;
    rollback) cmd_rollback ;;
    status)   cmd_status ;;
    logs)     cmd_logs "$@" ;;
    ssl)      cmd_ssl ;;
    *)
        echo "使い方: $0 [setup|deploy|rollback|status|logs|ssl]"
        echo ""
        echo "  setup    サーバーの初期セットアップ（Docker インストールなど）"
        echo "  deploy   最新コードをデプロイ（デフォルト）"
        echo "  rollback 直前のバージョンに戻す"
        echo "  status   サービス状態・ヘルスチェックを確認"
        echo "  logs     ログをストリーミング表示"
        echo "  ssl      Let's Encrypt SSL 証明書を取得・設定"
        echo ""
        echo "環境変数:"
        echo "  SERVER_HOST=192.168.1.100  デプロイ先サーバー（必須）"
        echo "  SERVER_USER=ubuntu         SSH ユーザー（デフォルト: ubuntu）"
        echo "  SERVER_PORT=22             SSH ポート（デフォルト: 22）"
        echo "  DEPLOY_SSH_KEY='...'       SSH 秘密鍵ファイルへのパス"
        echo "  DOMAIN=api.example.com     ドメイン名（ssl コマンドで必須）"
        exit 1
        ;;
esac
