# Qquick-NEXT

YouTube チャンネル巡回用の Google Apps Script (GAS) Webアプリ。登録したチャンネルの最新動画を、サムネ付きの一覧で高速にチェックできる。

## 特徴

- **独自リスト管理**: YouTube の登録機能ではなく、自分の「巡回したいチャンネル」だけを並べる
- **サムネ付き一覧**: チャンネルごとのサムネを並べて、視聴回数・投稿日時・動画長を一目で確認
- **プライバシー保護**: チャンネルリストは UserProperties に保存。利用者ごとに完全に独立
- **自分のクォータで動く**: YouTube API は利用者自身の Google アカウントで叩く
- **キーボード操作**: ↑↓ Enter Space Home End / で完結
- **ダーク/ライトモード**: 切り替え可能

## 動作要件

- Google アカウント
- Google Apps Script (無料)
- YouTube Data API v3（GAS のアドバンスドサービスから有効化）

## セットアップ手順

### いちばん簡単：Drive からコピー

[こちらの共有リンク](https://script.google.com/d/1msoB51Zgu5UF-tQD7LW91ynuhWeqYfOsiBf1uupHO8KusbrY9gqAqKT6/edit?usp=sharing) を開き、ドライブで**右クリック →「コピーを作成」**するだけ。自分の Google ドライブにプロジェクトごと複製されます（ファイルのコピペ不要）。あとは下の「**4. デプロイ**」以降を行えば使えます。

### 手動でセットアップ（clasp / コピペ派向け）

1. **GAS プロジェクトを作成**
   - [Google Apps Script](https://script.google.com/) で「新しいプロジェクト」
2. **このリポジトリのファイルをコピー**
   - `appsscript.json` / `GQuick_Server.js` / `GQuick_UI.html` / `Channels.html` / `Manual.html` の中身を、それぞれ同名のファイルとして GAS エディタに貼り付ける
   - `appsscript.json` を編集するには、左側の「プロジェクトの設定」→「`appsscript.json` マニフェスト ファイルをエディタで表示する」をオンに
3. **初期チャンネルを設定**（任意）
   - `Channels.html` に「チャンネル名,チャンネルID」を1行ずつ書いておくと、初回起動時にそれが初期値として読み込まれる
   - 空でもOK（後からアプリ内で追加可能）
4. **デプロイ**
   - 右上「デプロイ」→「新しいデプロイ」
   - 種類: 「ウェブアプリ」
   - 実行: 「自分」
   - アクセスできるユーザー: 「自分のみ」（推奨）
5. **承認**
   - 初回は「承認が必要」と表示される。「アクセスを承認」→ Google アカウントを選択 → 「詳細」→「（安全ではないページ）に移動」→「許可」
6. **ブックマーク**
   - 表示された Web アプリの URL をブックマーク。以降そこから利用

詳細は同梱の `Manual.html` を参照。

## clasp で開発する場合

```bash
# .clasp.json を作る
cp .clasp.json.example .clasp.json

# .clasp.json の scriptId に、自分の GAS プロジェクトの scriptId を記入
# scriptId は GAS エディタの「プロジェクトの設定」で確認できる
```

## チャンネル管理

- アプリ右上の歯車アイコン → 「チャンネル管理（DB）」から追加・削除・並び替え
- 追加には **チャンネル ID**（UC で始まる24文字）が必要
  - YouTube のチャンネルページ URL `youtube.com/channel/UC...` の UC 以降がID
- リスト先頭のチャンネルは **VIP** として優先表示

## キーボード操作

| キー | 動作 |
|---|---|
| ↑ / ↓ | 動画移動 |
| Enter | 新タブで開く |
| Space | 動画選択/解除 |
| Home / End | 先頭/末尾 |
| / | 検索欄にフォーカス |
| Escape | 検索欄離脱 / モーダル閉じる |

PC は **右クリック**、スマホは **長押し** で動画再生。

## 仕様メモ（実装の特徴）

- **データベース**: GAS 純正の `PropertiesService.getUserProperties()` を使用。Sheets を介在させない設計
- **キャッシュ**: `CacheService.getUserCache()` で6時間キャッシュ
- **並列取得**: `UrlFetchApp.fetchAll()` でチャンネル別プレイリストと動画詳細をバッチ並列取得
- **UC→UU 変換**: チャンネル ID の先頭2文字 `UC` を `UU` に変えると、そのチャンネルの全アップロード動画プレイリスト ID になる。これでチャンネル詳細 API を1回省略できる
- **@handle 対応**: 2024年以降の `@handle` 形式の解決にも対応

## クォータ

YouTube API は利用者自身の Google アカウントの通信枠を使う。通常使用で制限にかかることはまずないが、極端に大量の動画を一度に取得すると翌日まで制限がかかることがある（自動リセット）。

## ライセンス

[MIT License](LICENSE)

## クレジット

- 連載記事（Qiita）: 公開予定
- 関連動画（YouTube）: 公開予定
