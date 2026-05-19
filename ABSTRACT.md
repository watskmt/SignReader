# SignReader — プロジェクト要旨

**SignReader** は、Raspberry Pi と Android スマートフォンを組み合わせたリアルタイム看板 OCR 記録システムです。フィールド調査・道路標識データ収集・小売り監査など、移動しながら大量の看板テキストを GPS 座標付きで自動収集するユースケースに対応します。

## システム構成

| コンポーネント | 役割 |
|---|---|
| Raspberry Pi Zero W + USB カメラ | フレームキャプチャ（2 秒間隔）・API 送信 |
| Android アプリ（React Native） | Pi Monitor（結果リアルタイム表示）＋ Record（スマホカメラ録画）|
| FastAPI バックエンド | OCR 処理・重複排除・GPS 付きデータ保存 |
| PaddleOCR | 日本語・英語テキスト抽出 |
| PostgreSQL + Redis + Celery | 永続化・キャッシュ・非同期タスク処理 |

## 処理フロー

```
Pi カメラ / スマホカメラ
  → JPEG フレーム（base64）
  → FastAPI /ocr/process/async
  → Celery ワーカー（PaddleOCR）
  → ファジーマッチ重複排除（信頼度 ≥ 80%）
  → PostgreSQL 保存
  → Android アプリにリアルタイム反映
```

## 本番インフラ

- **サーバー**: WebArena VPS（Rocky Linux、kernel 6.12）
- **API**: `https://api.signreader.amtech-service.com`
- **管理画面**: `https://admin.signreader.amtech-service.com`
- **CI/CD**: GitHub Actions（`master` push → 自動デプロイ）
- **SSL**: Let's Encrypt（nginx で自動終端）
