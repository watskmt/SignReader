# SignReader 開発者ガイド

このドキュメントは、SignReader プロジェクトに参加する開発者のための技術ガイドです。システムの詳細な構造、開発ワークフロー、およびベストプラクティスについて説明します。

## 1. 開発環境のセットアップ

### 前提条件
- **OS**: macOS (推奨) または Linux (Ubuntu/Rocky)
- **Node.js**: v18以上 (LTS推奨)
- **Python**: 3.10.x
- **Docker & Docker Compose**
- **Android Studio**: Android SDK 35, Build Tools 35.0.0, NDK 27.1
- **Java**: OpenJDK 17
- **Raspberry Pi Zero W**（キャプチャクライアント用）: Raspberry Pi OS Lite、USB ウェブカメラ、Python 3、OpenCV

### バックエンドのセットアップ
1. **仮想環境の作成**:
   ```bash
   cd backend
   python3.10 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
2. **インフラの起動**:
   ```bash
   docker-compose up -d  # PostgreSQL と Redis を起動
   ```
3. **環境変数の設定**:
   `.env.example` を `.env` にコピーし、必要に応じて編集します。
4. **サーバーの起動**:
   ```bash
   # API サーバー
   uvicorn app.main_optimized:app --reload --host 0.0.0.0 --port 8000
   
   # Celery ワーカー (別ターミナル)
   celery -A app.tasks.celery_app worker --loglevel=info --concurrency=2
   ```

### モバイルのセットアップ
1. **依存関係のインストール**:
   ```bash
   cd mobile
   npm install
   ```
   > VisionCamera v3 は patch-package で RN 0.75 互換パッチが適用済みです（`npm install` 時に自動適用）。
2. **Android ビルド**:
   ```bash
   npx react-native run-android
   ```

### Raspberry Pi キャプチャクライアントのセットアップ
1. Pi Zero W へ SSH 接続し、`raspberry-pi/` ディレクトリの内容を転送します。
   ```bash
   scp -r raspberry-pi/ pi@<Pi_IP>:/tmp/signreader-pi/
   ssh pi@<Pi_IP>
   cd /tmp/signreader-pi
   bash install.sh
   ```
2. `/opt/signreader-pi/.env` を編集して API URL を確認します（デフォルトは `https://api.signreader.amtech-service.com`）。
3. USB ウェブカメラが認識されているか確認します。
   ```bash
   v4l2-ctl --list-devices
   ```

---

## 2. システムアーキテクチャ詳細

### データフロー — Pi キャプチャモード（メイン）

```
Raspberry Pi Zero W
  └─ USB ウェブカメラ
       └─ capture.py (2 秒ごとにフレームキャプチャ)
            └─ POST /ocr/process/async
                 └─ Backend (FastAPI)
                      ├─ Celery タスクをキューイング
                      ├─ PaddleOCR 実行
                      ├─ Redis キャッシュ + ファジーマッチング重複排除
                      └─ PostgreSQL に保存
                           └─ Mobile (Pi Monitor)
                                └─ GET /sessions・/extractions を 3 秒ごとにポーリング
                                     └─ CameraScreen に結果をリアルタイム表示
```

1. **Pi**: `capture.py` が USB ウェブカメラから 2 秒ごとにフレームを取得し、JPEG へエンコード。
2. **Pi**: `SIGNREADER_API_URL`（デフォルト: `https://api.signreader.amtech-service.com`）の `/ocr/process/async` へ送信。
3. **Backend**: FastAPI がリクエストを受け取り、Celery タスクをキューイング。
4. **Backend**: Celery ワーカーが `PaddleOCR` を実行し、Gemini で OCR 結果をバリデーション。
5. **Backend**: 結果を Redis に一時保存し、ファジーマッチングで重複を判定。信頼度 80% 未満は除外。
6. **Backend**: 最終結果を PostgreSQL に保存（JST タイムスタンプ付き）。
7. **Mobile (Pi Monitor)**: 3 秒ごとに `listSessions` / `getExtractions` をポーリングし、CameraScreen にリアルタイム表示。AppState 対応済みでバックグラウンド復帰時に自動再開。

### データフロー — Record モード（スマホカメラ）

1. **Mobile**: Record ボタン押下で VisionCamera v3（旧アーキテクチャ対応）を lazy-load して起動。
2. **Mobile**: 3 秒ごとにフレームをキャプチャし GPS 座標と共に `processOCRAsync` で送信。
3. **Backend**: Pi キャプチャと同じ OCR パイプラインで処理・保存。
4. **Mobile**: 停止後、作成したセッションの ResultsScreen へ遷移。

### 主要コンポーネント
- **Backend**:
  - `app/main_optimized.py`: エントリーポイント。
  - `app/tasks.py`: Celery タスク定義（OCR、定期アーカイブ）。
  - `app/services/ocr_service.py`: PaddleOCR のラッパー。
  - `app/services/filter_service.py`: 重複排除とキーワードフィルタ。
- **Raspberry Pi**:
  - `raspberry-pi/capture.py`: USB ウェブカメラからフレームをキャプチャしバックエンドへ送信。
  - `raspberry-pi/install.sh`: Pi Zero W セットアップスクリプト（systemd サービス登録まで一括）。
  - `raspberry-pi/signreader-capture.service`: systemd ユニットファイル（自動起動）。
- **Mobile**:
  - `src/screens/CameraScreen.tsx`: Pi Monitor（ポーリング）と Record（スマホカメラ）の 2 モードを持つ画面。
  - `src/services/api.ts`: Axios ベースの通信クライアント。
  - `src/context/AppContext.tsx`: アプリの状態管理。

---

## 3. 開発ガイドライン

### コーディング規約
- **TypeScript (Mobile)**: 
  - strict モードを有効。
  - 型定義を徹底し、`any` の使用を避ける。
  - コンポーネントは関数コンポーネントを使用。
- **Python (Backend)**:
  - PEP 8 準拠。
  - 型ヒントを必須とする。
  - 非同期処理 (`async/await`) を適切に使用。

### テスト
- **バックエンド**: `pytest` を使用。DB 操作を伴うテストはテスト用 DB を使用するように設定されています。
  ```bash
  cd backend && pytest
  ```
- **モバイル**: `Jest` を使用。
  ```bash
  cd mobile && npm test
  ```

### API 変更時の注意点
1. `app/schemas.py` の Pydantic モデルを更新。
2. `app/main_optimized.py` のエンドポイントを修正。
3. `mobile/src/services/api.ts` の型定義とリクエストロジックを更新。

---

## 4. トラブルシューティング

### モバイルアプリが API に接続できない
- **原因**: 開発マシンのローカル IP が `mobile/src/config/api.ts` に設定されていない。
- **解決策**: `localhost` ではなく、PC の実際の IP（例: `192.168.x.x`）を設定してください。

### OCR の反応が遅い
- **原因**: CPU リソースの不足、または Celery ワーカーが起動していない。
- **解決策**: `celery worker` が正常に動作しているか確認してください。CPU 推論のため、最初の実行はモデルのロードに時間がかかります。

### Android ビルドエラー
- **原因**: NDK のバージョン不一致。
- **解決策**: `android/build.gradle` で指定されている `ndkVersion "27.1.12297006"` がインストールされているか確認してください。

### VisionCamera が初期化エラーで起動しない
- **原因**: VisionCamera v3 の旧アーキテクチャ互換パッチが未適用、またはネイティブモジュールのビルド失敗。
- **解決策**: `npm install` で patch-package が適用されているか確認してください。アプリは VisionCamera を lazy-load するため、初期化に失敗しても Pi Monitor モードは正常に動作します。Record ボタンを押すと「カメラモジュールが利用できません」とエラーが表示されます。

### Pi キャプチャクライアントがバックエンドに接続できない
- **原因**: `/opt/signreader-pi/.env` の `SIGNREADER_API_URL` が誤っている、または Pi からサーバーへの疎通がない。
- **解決策**: `curl https://api.signreader.amtech-service.com/health` で疎通を確認してください。ログは `sudo journalctl -u signreader-capture -f` で確認できます。

### モバイルの Pi Monitor に結果が表示されない
- **原因**: Pi のキャプチャクライアントが起動していない、またはセッションが作成されていない。
- **解決策**: `sudo systemctl status signreader-capture` で Pi 側のサービス状態を確認してください。バックエンドの `/sessions` エンドポイントでアクティブなセッションが存在するかも確認してください。

---

## 5. デプロイフロー

詳細は `deploy.sh`、`.github/workflows/deploy.yml` および `README.md` を参照してください。
基本手順:
1. `master` ブランチへ `git push` (GitHub Actions が自動デプロイを開始)
   - 注: GitHub Secrets の `DEPLOY_SSH_KEY` には秘密鍵の**内容**を登録してください。
2. 手動デプロイが必要な場合は、適切な環境変数（`SERVER_HOST`, `SERVER_USER`, `DEPLOY_SSH_KEY` (秘密鍵へのパス)）を設定して `./deploy.sh deploy` を実行

### nginx サブドメイン構成

本番サーバーでは以下の 2 つのサブドメインを nginx で運用しています。

| サブドメイン | 用途 |
|---|---|
| `api.signreader.amtech-service.com` | OCR API（バックエンド FastAPI） |
| `admin.signreader.amtech-service.com` | 管理画面（同じ FastAPI、管理者向けルーティング） |

`admin.signreader.amtech-service.com` は nginx に独立したサーバーブロックとして追加されています。設定テンプレートは `scripts/nginx-signreader.conf` を参照し、`server_name` を `admin.signreader.amtech-service.com` に変更して同じ `proxy_pass http://127.0.0.1:8000` へプロキシします。
