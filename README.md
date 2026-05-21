# agent-sandbox

`devcontainer exec --workspace-folder . <command>` を短いコマンドで実行するラッパー CLI です。  
カレントディレクトリから `.devcontainer/` を自動検出し、コンテナが未起動なら自動で起動します。

devcontainer-cli が Node.js/npm を前提とするため、同じ npm エコシステムで完結するよう TypeScript で実装されています。Python 等の追加インストールは不要です。

## 前提条件

| ツール | 必須 | 備考 |
|--------|------|------|
| Node.js ≥ 20 | ✅ | `agent-sandbox` と `@devcontainers/cli` の実行に必要 |
| Docker | ✅ | [Docker Desktop](https://www.docker.com/products/docker-desktop/) をインストール |
| @devcontainers/cli | 自動 | 未インストールの場合、初回実行時に `npm install -g @devcontainers/cli` を自動実行 |

## インストール

```bash
# npm でグローバルインストール（推奨）
npm install -g --install-links=true git+https://github.com/aRaikoFunakami/agent-sandbox.git

# または開発用ローカルインストール
npm install -g ./agent-sandbox
```

このパッケージは `dist/` と `templates/` を同梱しているため、インストール時に TypeScript のビルドは不要です。`--install-links=true` は、npm の設定が `install-links=false` の環境でも GitHub からのグローバルインストールを実体コピーにして、消える可能性がある npm 一時ディレクトリへの symlink を避けるために指定しています。

## 使い方

### 新規プロジェクトへの devcontainer 設定の追加

```bash
cd your-project
agent-sandbox init                                          # 軽量 base profile
agent-sandbox init --install=playwright-cli                 # playwright-cli profile
agent-sandbox init --install=appium-cli                     # appium-cli profile
agent-sandbox init --install=playwright-cli,appium-cli      # 両方を同時に有効化
agent-sandbox init --install=playwright-cli --install=appium-cli  # 繰り返し指定でも同じ
agent-sandbox init --force                                  # 既存の設定を上書き
```

デフォルトの `base` profile は、公式 Dev Containers base image (`mcr.microsoft.com/devcontainers/base:ubuntu-24.04`) を使い、Copilot CLI / Claude Code / GitHub CLI だけを Features で入れます。Playwright や Appium は入りません。

`--install=playwright-cli` を指定した場合だけ、Playwright 公式 image をベースに `@playwright/cli` と Chromium をイメージビルド時に入れます。ブラウザを `postCreateCommand` で入れないため、ワークスペースごとのコンテナ writable layer が肥大化しにくくなります。

`--install=appium-cli` を指定すると、OpenJDK 17 + Android command-line tools + `platform-tools` + Appium 3 (`uiautomator2` driver pinned) + [`aRaikoFunakami/appium-cli`](https://github.com/aRaikoFunakami/appium-cli) を `uv tool install` でビルド時に導入します。`xcuitest` driver は入りません (iOS 自動化は macOS ホスト/ Xcode 必須のためコンテナ対象外)。Android デバイスへの ADB 接続は **既定ではホスト側 ADB server に TCP で接続** します (下記 [Android デバイス接続](#android-デバイス接続) 参照)。

`--install` を複数指定すると、`appium-cli+playwright-cli` の組み合わせ profile が生成され、Playwright image の上に Appium レイヤを積みます。生成物の `agent-sandbox-devcontainer:<profile>` タグはアルファベット順 (`appium-cli+playwright-cli`) で安定化されます。

生成後は `.devcontainer/llm.env` を編集してから `agent-sandbox copilot --version` で起動確認できます。

### コンテナの状態確認・停止・クリーンアップ

```bash
agent-sandbox status        # コンテナ名・状態・イメージを表示
agent-sandbox stop          # カレントワークスペースのコンテナを停止
agent-sandbox clean         # コンテナとイメージを削除（ディスク解放）
agent-sandbox distclean     # clean + ボリューム削除 + Docker ビルドキャッシュ削除
agent-sandbox rebuild       # distclean + コンテナをゼロから再ビルド（--no-cache）
agent-sandbox -w /path/to/project stop  # ワークスペースを明示して停止
agent-sandbox -w /path/to/project clean # ワークスペースを明示してクリーン
```

| コマンド | コンテナ削除 | イメージ削除 | ボリューム削除 | ビルドキャッシュ削除 | 再ビルド (--no-cache) |
|----------|:---:|:---:|:---:|:---:|:---:|
| `clean` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `distclean` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `rebuild` | ✅ | ✅ | ✅ | ✅ | ✅ |

- **`clean`** — コンテナとイメージを消すが、Docker ビルドキャッシュは残るため次回ビルドが高速。
- **`distclean`** — すべてのローカル成果物を削除し、完全にまっさらな状態に戻す。
- **`rebuild`** — `distclean` 後に `devcontainer up --no-cache` を実行。Docker にレイヤーキャッシュを一切使わせないため、`apt-get update` や `git clone @main` (appium-cli 等) が最新のパッケージを必ず取得する。依存ツールの最新版を確実に反映したい場合はこれを使う。

`clean` は該当ワークスペースのラベル付きコンテナ（起動中含む）を強制削除し、それらが使用していたイメージと agent-sandbox のキャッシュタグも削除します。他プロジェクトのコンテナ・イメージには影響しません。

### コンテナ内でのエージェント実行

```bash
# GitHub Copilot CLI
agent-sandbox copilot --allow-all -p "fix all failing tests"

# プロンプトファイルから読み込む
agent-sandbox copilot --allow-all -p "$(cat ./prompts/normal.txt)"

# Claude Code
agent-sandbox claude --dangerously-skip-permissions -p "run tests and fix failures"

# playwright-cli (--install=playwright-cli で init した場合)
agent-sandbox playwright-cli open https://example.com
agent-sandbox playwright-cli snapshot
agent-sandbox playwright-cli close

# appium-cli (--install=appium-cli で init した場合)
agent-sandbox appium-cli doctor
agent-sandbox appium-cli devices --platform android
agent-sandbox appium-cli server start
agent-sandbox appium-cli session start
agent-sandbox appium-cli snapshot

# ワークスペースを明示指定
agent-sandbox -w /path/to/project copilot --allow-all -p "review code"
```

## Android デバイス接続

`--install=appium-cli` プロファイルは、Android デバイスに 2 通りの方法で接続できます。

### 既定: ホスト ADB server に TCP 接続 (macOS / Linux 両対応)

生成された `.devcontainer/devcontainer.json` の `containerEnv` には `ADB_SERVER_SOCKET=tcp:host.docker.internal:5037` がデフォルトで入っているため、コンテナ内 `adb` は **ホスト側で稼働中の ADB server** に接続します。

ホスト側で次のように ADB server を LAN 公開モードで起動します:

```bash
# ホストの別ターミナルで実行
adb kill-server
adb -a -P 5037 nodaemon server
```

その後、コンテナ内から:

```bash
agent-sandbox appium-cli devices --platform android
agent-sandbox appium-cli server start
```

> ⚠️ `adb -a` は ADB server をネットワークインタフェースに公開します。ファイアウォール内 / 信頼できるネットワークでのみ使用してください。

### opt-in: Linux ホストでの USB pass-through

Linux ホストで USB デバイスを直接コンテナに渡したい場合は、生成された `.devcontainer/devcontainer.json` を以下のように手動編集してから `agent-sandbox stop` → 再起動してください。

1. `containerEnv.ADB_SERVER_SOCKET` を削除 (コンテナ内 `adb` をローカルで起動させるため)。
2. `runArgs` を以下に書き換え:

```json
"runArgs": [
  "--env-file",
  ".devcontainer/llm.env",
  "--add-host=host.docker.internal:host-gateway",
  "--device=/dev/bus/usb"
]
```

3. ホスト側で対象 Android デバイスへの udev rule (USB ID ベース) を設定し、`plugdev` グループから読み書き可能にしておく。

macOS では Docker Desktop の制約により USB pass-through は使えないため、必ず既定の TCP モードを使用してください。

## 動作

1. カレントディレクトリから上方向に `.devcontainer/` ディレクトリを探す
2. `devcontainer` コマンドが未インストールの場合、`npm install -g @devcontainers/cli` を自動実行
3. 前回の実行で残存した孤立コンテナがあれば自動停止する（SIGKILL 後の復旧）
4. 対象 devcontainer が未起動なら、ワークスペース単位のロックを取得してから `devcontainer up --workspace-folder <path>` を実行
5. 起動後のイメージを `agent-sandbox-devcontainer:<profile>` (例: `base` / `playwright-cli` / `appium-cli` / `appium-cli+playwright-cli`) に tag し、別ワークスペースの `cacheFrom` に使えるようにする
6. `devcontainer exec --workspace-folder <path> <command>` を実行してコマンドの終了コードをそのまま返す
7. コマンド完了後、起動したコンテナを自動停止する（正常終了・SIGINT・SIGTERM いずれも対応）
8. 親プロセスが SIGKILL された場合に備え、バックグラウンドのウォッチドッグプロセスが親の生存を監視し、死亡検知時にコンテナを停止する

## 同時実行時の挙動

`devcontainer` CLI は既存コンテナを `devcontainer.local_folder=<workspace>` ラベルで探索して再利用します。ただし、コンテナがまだ存在しない cold start で `devcontainer up` が完全に同時実行されると、「存在確認 → docker run」の race により同じワークスペースに複数コンテナが作られる可能性があります。

`agent-sandbox` はこれを避けるため、`.devcontainer/.agent-sandbox-up.lock/` を使って同一ワークスペースの初回起動を直列化します。起動完了後の `devcontainer exec` は複数プロセスから並行実行できます。

`status` / `stop` / `clean` はランダムな Docker コンテナ名ではなく `devcontainer.local_folder` ラベルで対象を特定するため、コンテナ名が毎回変わっても動作します。

## ストレージ実測メモ

同一 profile のワークスペースを2つ作成した実測では、2個目以降も `vsc-<workspace>-<hash>` イメージタグとコンテナ writable layer が作られるため、約 1.25GB / workspace 程度の増分がありました。

| profile | 2個目作成時の追加増分 | コンテナ writable layer |
|---|---:|---:|
| `base` | Images +630MB / Containers +627MB | 約 627MB / workspace |
| `playwright-cli` | Images +620MB / Containers +626MB | 約 625MB / workspace |
| `appium-cli` | (未測定: OpenJDK 17 + Android SDK platform-tools + Appium + uiautomator2 + appium-cli) | (未測定) |
| `appium-cli+playwright-cli` | (未測定: Playwright image + 上記 Appium レイヤ) | (未測定) |

以前のように `postCreateCommand` で Chromium を入れる構成では Playwright 利用時の writable layer が約 1.62GB / workspace まで増えていました。現在は Dockerfile のビルド時に Chromium を入れるため、その増分は抑えられています。
