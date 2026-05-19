# SignReader

スマートフォンのカメラで看板をリアルタイムにOCR読み取りし、GPS座標と共に記録するアプリケーションです。

## 概要

SignReader は Raspberry Pi Zero W に接続した USB ウェブカメラでフレームをキャプチャし、FastAPI バックエンドへ送信して PaddleOCR で OCR 処理を行います。ファジーマッチングで重複を排除し、GPS 座標と共に PostgreSQL へ保存します。モバイルクライアントは React Native 0.75 と TypeScript で構築した Pi Monitor（リアルタイム結果表示）と Record（スマホカメラ録画送信）の 2 つのモードを持ちます。

詳細な開発者向けドキュメントは [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) を参照してください。

## ユースケース

- フィールド調査での街路標識・店舗看板・建物案内の記録
- 地図作成・研究目的での走行ルート沿いの標識データ収集
- 視覚障害者向けアクセシビリティ支援
- 小売り監査：店舗の価格・販促看板の大量収集
- 旅行中に出会った看板の自動記録

## 技術スタック

| レイヤー | 技術 |
|---|---|
| モバイルクライアント | React Native 0.75.4、TypeScript |
| ナビゲーション | React Navigation v6 |
| カメラ | react-native-vision-camera v3（RN 0.75 互換パッチ適用済み） |
| HTTP クライアント | Axios（タイムアウト 30 秒） |
| バックエンド API | FastAPI 0.104、Python 3.10 |
| OCR エンジン | PaddleOCR 2.7.3（paddlepaddle 2.6.2 CPU） |
| タスクキュー | Celery 5.3 + Redis 7 |
| キャッシュ | Redis 7 |
| データベース | PostgreSQL 15 + SQLAlchemy 2.0 |
| マイグレーション | Alembic 1.12 |
| テスト（バックエンド） | pytest 7.4、pytest-asyncio、pytest-cov |
| テスト（モバイル） | Jest 29、@testing-library/react-native |
| キャプチャクライアント | Raspberry Pi Zero W + USB ウェブカメラ + Python 3（OpenCV） |

## Android ビルド環境

| 項目 | バージョン |
|---|---|
| Android Gradle Plugin | 8.6.1 |
| Gradle | 8.10.2 |
| Kotlin | 2.0.21 |
| compileSdk / targetSdk | 35 |
| minSdk | 26 |
| NDK | 27.1.12297006 |
| New Architecture | 無効（newArchEnabled=false） |

## ディレクトリ構成

```
SignReader/
├── .gitignore
├── README.md
├── SPECIFICATION.md
├── DEVELOPER_GUIDE.md
├── TESTING_GUIDE.md
├── deploy.sh                        # デプロイスクリプト
├── scripts/
│   ├── rocky-setup.sh               # Rocky Linux VPS 初期セットアップ
│   └── nginx-signreader.conf        # nginx サブドメイン設定テンプレート
│
├── raspberry-pi/
│   ├── capture.py                   # Pi Zero W ウェブカメラキャプチャクライアント
│   ├── install.sh                   # Pi セットアップスクリプト
│   ├── requirements.txt             # Python 依存パッケージ
│   └── signreader-capture.service  # systemd サービスユニット
│
├── backend/
│   ├── .env.example
│   ├── .env.prod                    # 本番環境変数（git管理外）
│   ├── Dockerfile
│   ├── docker-compose.yml           # ローカル開発用
│   ├── docker-compose.prod.yml      # 本番用
│   ├── nginx-https.conf             # nginx HTTPS 設定（本番）
│   ├── nginx-certbot.conf           # nginx HTTP 設定（証明書取得用）
│   ├── requirements.txt
│   ├── pytest.ini
│   ├── SETUP.md
│   ├── PHASE2_GUIDE.md
│   ├── QUICKSTART.md
│   │
│   ├── app/
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── main.py                  # Phase 1（同期 OCR）
│   │   ├── main_optimized.py        # Phase 2（Celery + Redis）本番使用
│   │   ├── tasks.py
│   │   └── services/
│   │       ├── ocr_service.py
│   │       ├── cache_service.py
│   │       └── filter_service.py
│   │
│   └── tests/
│       ├── conftest.py
│       ├── test_api.py
│       ├── test_ocr_service.py
│       └── test_services.py
│
└── mobile/
    ├── package.json
    ├── tsconfig.json
    ├── babel.config.js
    ├── metro.config.js
    ├── jest.config.js
    ├── jest.setup.js
    ├── PHASE3_GUIDE.md
    ├── android/
    └── src/
        ├── App.tsx
        ├── config/api.ts            # API_BASE_URL・タイムアウト設定
        ├── context/AppContext.tsx
        ├── services/
        │   ├── api.ts
        │   ├── camera.ts
        │   └── storage.ts
        ├── screens/
        │   ├── CameraScreen.tsx     # Pi Monitor（ポーリング）＋ Record（スマホカメラ）
        │   ├── SessionListScreen.tsx
        │   └── ResultsScreen.tsx
        └── __tests__/services/
            ├── api.test.ts
            └── storage.test.ts
```

## クイックスタート

### バックエンド（ローカル開発）

```bash
cd backend

# 仮想環境の作成と有効化（Python 3.10 必須）
python3.10 -m venv venv
source venv/bin/activate

# 依存パッケージのインストール
pip install -r requirements.txt

# PostgreSQL + Redis の起動
docker-compose up -d

# 環境変数の設定
cp .env.example .env

# Phase 2 API サーバーの起動（非同期 OCR 対応）
uvicorn app.main_optimized:app --reload --host 0.0.0.0 --port 8000

# Celery ワーカーの起動（別ターミナル）
celery -A app.tasks.celery_app worker --loglevel=info --concurrency=2
```

Swagger UI: http://localhost:8000/docs

### モバイルアプリ

```bash
cd mobile
npm install

# Metro バンドラー起動
npx react-native start

# 別ターミナルで Android デバイスにインストール
npx react-native run-android
```

> **本番 API への接続:** `src/config/api.ts` の `API_BASE_URL` は `https://api.signreader.amtech-service.com` に設定済みです。
>
> **モバイル機能:** CameraScreen は Pi Monitor モード（3 秒ポーリングで OCR 結果をリアルタイム表示）と Record モード（スマホカメラで撮影・OCR 送信）の 2 モードを持ちます。Record モードには VisionCamera v3 を lazy-load で使用しています。

### Raspberry Pi キャプチャクライアント

Raspberry Pi Zero W に USB ウェブカメラを接続し、バックエンドへフレームを送信するクライアントです。

```bash
# Pi 上で実行
cd raspberry-pi
bash install.sh
```

インストール後、`/opt/signreader-pi/.env` で API URL やキャプチャ間隔を設定できます。

```bash
# 状態確認
sudo systemctl status signreader-capture

# ログ確認
sudo journalctl -u signreader-capture -f

# 設定変更後の再起動
sudo nano /opt/signreader-pi/.env
sudo systemctl restart signreader-capture
```

**主な環境変数:**

| 変数 | デフォルト | 説明 |
|---|---|---|
| `SIGNREADER_API_URL` | `https://api.signreader.amtech-service.com` | バックエンド API URL |
| `CAPTURE_INTERVAL` | `2.0` | キャプチャ間隔（秒） |
| `CAMERA_INDEX` | `0` | V4L2 デバイスインデックス |
| `JPEG_QUALITY` | `70` | JPEG 品質（1〜100） |
| `CAPTURE_WIDTH` / `CAPTURE_HEIGHT` | `640` / `480` | フレーム解像度 |
| `SESSION_TITLE` | `Pi-YYYYMMDD-HHMM` | セッション名プレフィックス |

### 自動デプロイ (GitHub Actions)

`main` ブランチへのプッシュにより自動的にデプロイが実行されます。
以下の GitHub Secrets を設定する必要があります：
- `SERVER_HOST`: サーバーのIPアドレス (`157.120.37.201`)
- `SERVER_USER`: SSH ユーザー (`rocky`)
- `DEPLOY_SSH_KEY`: SSH 秘密鍵の内容 (PEM 形式)
- `PROD_ENV_FILE`: `backend/.env.prod` の内容

### 手動デプロイ

```bash
# 初回セットアップ（Dockerインストール・スワップ・daemon.json設定）
export SERVER_HOST=157.120.37.201
export SERVER_USER=rocky
export DEPLOY_SSH_KEY=~/.ssh/webarena  # 秘密鍵ファイルへのパス
./deploy.sh setup

# アプリのデプロイ
./deploy.sh deploy

# 状態確認
./deploy.sh status
```

> **注意:** このサーバーは kernel 6.12（EL10系）のため `/etc/docker/daemon.json` に `{"firewall-backend": "nftables"}` が必須です。deploy.sh が自動設定します。

## nginx サブドメイン構成

本番サーバーでは 2 つのサブドメインを nginx で運用しています。

| サブドメイン | 用途 |
|---|---|
| `api.signreader.amtech-service.com` | OCR API（バックエンド FastAPI、ポート 8000 へプロキシ） |
| `admin.signreader.amtech-service.com` | 管理画面（同じバックエンド、管理者向けルーティング） |

nginx 設定テンプレートは `scripts/nginx-signreader.conf` を参照してください。管理画面用には `server_name admin.signreader.amtech-service.com` のサーバーブロックを追加して、同じ `proxy_pass http://127.0.0.1:8000` へプロキシします。
