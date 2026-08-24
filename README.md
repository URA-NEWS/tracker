# 📊 ツイキャス配信者追跡ツール

複数のツイキャス配信者の**同時接続数**と**総来場者数**を 24/7 自動で監視し、リアルタイムグラフで可視化するツールです。

## 機能

✅ **自動監視**  
配信開始を自動検知し、配信中は 30 秒ごとにデータを記録

✅ **複数配信者対応**  
好きな配信者を自由に追加・削除可能。配信者のアイコンと名前も自動取得

✅ **リアルタイムグラフ**  
同時接続数と総来場者数の推移を折れ線グラフで可視化

✅ **データエクスポート**  
全データを JSON 形式でダウンロード可能

✅ **デザイン性**  
モダンで直感的な UI、レスポンシブ対応

## セットアップ

### ローカルで実行

**必須要件**: Node.js 14+

```bash
# リポジトリをクローン
git clone https://github.com/YOUR_USERNAME/twitcas-tracker.git
cd twitcas-tracker

# サーバーを起動
npm start
```

ブラウザで `http://localhost:3943` を開く。

### Render へデプロイ

1. このリポジトリを GitHub にプッシュ
2. [Render](https://render.com) で新規 Web Service を作成
3. GitHub リポジトリを接続
4. 数分待つだけで自動デプロイ完了

デプロイ後の URL は `https://twitcas-tracker-xxxx.onrender.com` の形式。

## 使い方

### 配信者を追加

1. サイドバーのフォーム欄に ツイキャス URL か user_id を入力
   - 例: `https://twitcasting.tv/love1001only`
   - または: `love1001only`
2. **「追加する」** ボタンをクリック
3. 配信者がリストに追加され、自動監視が開始される

### データを確認

- **配信者カード**: 現在の状態（配信中 / オフライン）と最新データを表示
- **グラフ**: すべての配信者の履歴を重ねて表示
- **更新ボタン**: 手動でデータを再取得

### データをエクスポート

**「データ出力」** ボタンで JSON ファイルをダウンロード。

## API

### GET /api/config
現在の設定（追加済み配信者）を取得
```json
{
  "broadcasters": [
    {
      "user_id": "love1001only",
      "name": "配信者名",
      "image": "https://..."
    }
  ]
}
```

### GET /api/twitcas/stats
全配信者のデータを取得
```json
{
  "love1001only": {
    "user_id": "love1001only",
    "current_broadcast": {
      "broadcast_id": "...",
      "started_at": "...",
      "samples": [
        {"concurrent": 856, "total": 1251, "timestamp": "..."}
      ]
    },
    "history": [...]
  }
}
```

### POST /api/config/broadcasters
新しい配信者を追加
```json
{"user_id": "love1001only"}
```

### DELETE /api/config/broadcasters/{user_id}
配信者を削除

## データ永続性

### Render 無料プラン

サーバーが再起動するとメモリ内のデータが消去されます。

**解決策:**
- **Persistent Disk を追加**（有料）
- またはローカルで運用

### ローカルホスト

`config.json` と `stats.json` がプロジェクトフォルダに保存されるため、データは永続化されます。

## カスタマイズ

### 監視間隔を変更

`server.js` の最下部

```javascript
setInterval(monitorBroadcasters, 30000); // 30秒 → 必要な間隔に変更
```

### ポート番号を変更

```bash
PORT=4000 npm start
```

## トラブルシューティング

### グラフが表示されない
- ブラウザのコンソール（F12）でエラーを確認
- `/api/twitcas/stats` にアクセスしてサーバーが稼働しているか確認

### データが記録されない
- 配信者が実際に配信中か確認
- ツイキャスの HTML 構造が変わった場合は、抽出ロジックの更新が必要な場合があります

### Render でエラー

**Build logs** で詳細を確認。通常は Node.js のバージョン問題です。

## ライセンス

MIT

---

**開発・改善提案は Welcome！**
