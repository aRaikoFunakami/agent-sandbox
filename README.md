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

生成後は `~/.agent-sandbox/llm.env` または `.agent-sandbox/llm.env` を編集してから `agent-sandbox copilot --version` で起動確認できます。

### LLM 環境変数の設定

`agent-sandbox init` は次のファイルを作成します。

| パス | 用途 |
|---|---|
| `~/.agent-sandbox/llm.env` | 全プロジェクト共通のデフォルト設定 |
| `~/.agent-sandbox/llm.env.example` | 共通設定用サンプル |
| `<project>/.agent-sandbox/llm.env` | プロジェクト固有の上書き設定 |
| `<project>/.agent-sandbox/llm.env.example` | プロジェクト設定用サンプル |

環境変数の優先順位は **ホスト共通 < プロジェクト固有 < コマンドライン指定** です。例えば、`~/.agent-sandbox/llm.env` に共通の API endpoint を置き、特定プロジェクトだけ `.agent-sandbox/llm.env` で model を変え、さらに一時的に `COPILOT_MODEL=... agent-sandbox copilot ...` のように上書きできます。

#### LLM サーバー URL / モデルの管理コマンド

`llm.env` を直接編集しなくても、以下のコマンドで設定の参照・更新ができます。デフォルトの書き込み先はカレントワークスペースの `.agent-sandbox/llm.env` で、`--global` を付けると `~/.agent-sandbox/llm.env` を更新します。

```bash
# サーバー URL の参照・設定（COPILOT_PROVIDER_TYPE=openai も同時に設定されます）
agent-sandbox url
agent-sandbox url http://llm.example.com:8000/v1
agent-sandbox url http://llm.example.com:8000/v1 --global

# モデル名の参照・設定
agent-sandbox model
agent-sandbox model Qwen3.5-9B-bf16
agent-sandbox model Qwen3.5-9B-bf16 --global

# 設定済み URL に対して OpenAI 互換の /models を問い合わせ
agent-sandbox models
agent-sandbox models --url http://llm.example.com:8000/v1   # 一時的に別の URL を確認
```

`models` の出力では、現在 `COPILOT_MODEL` に設定されているモデル ID の行頭に `*` が付きます。`agent-sandbox status` は Docker のコンテナ状態に加えて、現在有効な `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_TYPE` / `COPILOT_MODEL` と、その値がどのファイル（ホスト・プロジェクト・プロセス環境）由来かを表示します。

### コンテナの状態確認・停止・クリーンアップ

```bash
agent-sandbox status        # コンテナ状態 + 現在の LLM 設定を表示
agent-sandbox stop          # カレントワークスペースのコンテナを停止
agent-sandbox clean         # コンテナとイメージを削除（ディスク解放）
agent-sandbox distclean     # clean + ボリューム削除 + Docker ビルドキャッシュ削除
agent-sandbox rebuild       # distclean + コンテナをゼロから再ビルド（--build-no-cache）
agent-sandbox -w /path/to/project stop  # ワークスペースを明示して停止
agent-sandbox -w /path/to/project clean # ワークスペースを明示してクリーン
```

| コマンド | コンテナ削除 | イメージ削除 | ボリューム削除 | ビルドキャッシュ削除 | 再ビルド (--build-no-cache) |
|----------|:---:|:---:|:---:|:---:|:---:|
| `clean` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `distclean` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `rebuild` | ✅ | ✅ | ✅ | ✅ | ✅ |

- **`clean`** — コンテナとイメージを消すが、Docker ビルドキャッシュは残るため次回ビルドが高速。
- **`distclean`** — すべてのローカル成果物を削除し、完全にまっさらな状態に戻す。
- **`rebuild`** — `distclean` 後に `devcontainer up --build-no-cache` を実行。Docker にレイヤーキャッシュを一切使わせないため、`apt-get update` や `git clone @main` (appium-cli 等) が最新のパッケージを必ず取得する。依存ツールの最新版を確実に反映したい場合はこれを使う。

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
# 注意: agent-sandbox は毎回コンテナを停止するため、以下は単発コマンドとして使う
agent-sandbox appium-cli doctor                        # 環境チェック
agent-sandbox appium-cli devices --platform android    # デバイス一覧

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

その後、コンテナ内から動作確認:

```bash
agent-sandbox appium-cli devices --platform android
```

> ⚠️ `adb -a` は ADB server をネットワークインタフェースに公開します。ファイアウォール内 / 信頼できるネットワークでのみ使用してください。

### opt-in: Linux ホストでの USB pass-through

Linux ホストで USB デバイスを直接コンテナに渡したい場合は、生成された `.devcontainer/devcontainer.json` を以下のように手動編集してから `agent-sandbox stop` → 再起動してください。

1. `containerEnv.ADB_SERVER_SOCKET` を削除 (コンテナ内 `adb` をローカルで起動させるため)。
2. `runArgs` を以下に書き換え:

```json
"runArgs": [
  "--env-file",
  ".agent-sandbox/llm.env",
  "--add-host=host.docker.internal:host-gateway",
  "--device=/dev/bus/usb"
]
```

3. ホスト側で対象 Android デバイスへの udev rule (USB ID ベース) を設定し、`plugdev` グループから読み書き可能にしておく。

macOS では Docker Desktop の制約により USB pass-through は使えないため、必ず既定の TCP モードを使用してください。

## Apple Silicon macOS + Chrome / WebView 自動化 (host Appium モード)

Apple Silicon Mac でこの devcontainer から **Android Chrome / WebView** を自動操作する場合、Appium は **macOS ホスト側で実行する必要があります**。

### なぜホスト側 Appium が必要か

- devcontainer は Linux arm64 (aarch64) として動きます。
- Appium の `uiautomator2` driver は WebView を操作するとき、Appium と同じマシン上で動く **ChromeDriver バイナリ** を必要とします。
- Chrome for Testing が公開している ChromeDriver は `linux64` (x86_64 Linux) と `mac-arm64` (Apple Silicon macOS) のみで、**`linux-arm64` ChromeDriver は存在しません**。
- そのため Appium がコンテナ内で動くと、Chromedriver autodownload は `linux64` を選んでしまい、arm64 Linux 上では実行できません (`mac-arm64` も Linux 上では Mach-O のため動きません)。
- native Android (uiautomator2) の操作は arm64 Linux コンテナでも動きますが、WebView コンテキスト切り替えや `web_snapshot` だけが失敗します。
- 解決策は Appium を **macOS ホスト側** で動かし、コンテナの `appium-cli` から `host.docker.internal:4723` 経由で接続することです。host 側なら `mac-arm64` ChromeDriver が自然に解決されます。

### 既定モード: `--appium-server=host` (macOS 既定)

`agent-sandbox init --install=appium-cli` は macOS 上では **デフォルトで host モード** を生成します:

```bash
agent-sandbox init --install=appium-cli                       # macOS では暗黙的に host
agent-sandbox init --install=appium-cli --appium-server=host
```

host モードの生成物の差分:

- `.devcontainer/Dockerfile` から **Appium / uiautomator2 / Android SDK / Java の重いインストールを除外** (`adb` と `appium-cli` のみ残る)。
- `containerEnv.APPIUM_SERVER_URL=http://host.docker.internal:4723` が設定され、`appium-cli session start` が自動的にホスト側 Appium に接続します。
- イメージタグは `agent-sandbox-devcontainer:appium-cli-host` (container モードの `agent-sandbox-devcontainer:appium-cli` とは別キャッシュ)。

逆に native Android のみ操作したい場合や Linux ホストでは `--appium-server=container` で従来通りのフル Appium 入りイメージが生成されます。

### ホスト前提条件 (ユーザーが事前に用意)

`agent-sandbox` は **ホスト側に Appium / Node をインストールしません**。次のものを Mac 側に揃えてください:

| 要件 | コマンド例 |
|------|-----------|
| Node.js ≥ 20 | `brew install node` |
| Appium 3.x | `npm install -g appium` |
| uiautomator2 driver | `appium driver install uiautomator2` |
| Android platform-tools (`adb`) | `brew install --cask android-platform-tools` |
| ADB を有効化した Android デバイス | デバイス開発者オプションで USB デバッグ有効 |
| 対象デバイスに Chrome がインストール済み | Google Play から |

### ホスト Appium のライフサイクル

```bash
# ホスト側 Appium を起動 (4723 番、リッスン中なら再利用)
agent-sandbox appium host start

# 状態確認
agent-sandbox appium host status            # human-readable
agent-sandbox appium host status --json     # ownership / pid / port / url

# ログ (デフォルト末尾 200 行、`-f` でフォロー)
agent-sandbox appium host log
agent-sandbox appium host log -f

# 自分が起動したものだけ停止 (external は停止しない)
agent-sandbox appium host stop
```

- `start` は最初に `http://127.0.0.1:4723/status` を probe し、既に応答する Appium があれば **external として再利用** します (agent-sandbox は停止しません)。
- 応答する Appium がなく自分で起動する場合は厳格なプリチェックを行います: `appium` が PATH にあり、`appium driver list --installed` に `uiautomator2` が含まれ、`adb` が PATH にある必要があります。1つでも欠けると終了コード 1 で失敗します。
- 起動した Appium は `detached` で動き、状態は `~/.agent-sandbox/appium-host/state.json`、ログは `~/.agent-sandbox/appium-host/appium.log` に保存されます。
- `stop` は **自分で起動した PID にのみ SIGTERM** を送ります。external Appium を停止することはありません。

### 自動起動はしません

`agent-sandbox appium-cli ...` は host Appium を暗黙起動しません。host/container の境界をユーザーが明示的に意識できるように、`appium host start` は必ず手動で呼んでください。

> **注意**: `agent-sandbox` はコマンド実行ごとにコンテナを起動・停止するため、`appium-cli session start` で開始したセッションは次のコマンド実行時には消えています。appium-cli のインタラクティブな操作（session start → activate_app → web_eval → session stop）は、VS Code Dev Containers 拡張でコンテナを開いた状態で直接実行するか、`agent-sandbox copilot` / `claude` のツールとして AI エージェントに委任してください。

### 既存ワークスペースのマイグレーション

container モードで生成済みのワークスペースを host モードに切り替えるには:

```bash
agent-sandbox init --force --install=appium-cli --appium-server=host
agent-sandbox rebuild    # 古い appium-cli イメージを使い続けないように
```

## 動作

1. カレントディレクトリから上方向に `.devcontainer/` ディレクトリを探す
2. `devcontainer` コマンドが未インストールの場合、`npm install -g @devcontainers/cli` を自動実行
3. 前回の実行で残存した孤立コンテナがあれば自動停止する（SIGKILL 後の復旧）
4. 対象 devcontainer が未起動なら、ワークスペース単位のロックを取得してから `devcontainer up --workspace-folder <path>` を実行
5. 起動後のイメージを `agent-sandbox-devcontainer:<profile>` (例: `base` / `playwright-cli` / `appium-cli` / `appium-cli+playwright-cli`) に tag し、別ワークスペースの `cacheFrom` に使えるようにする
6. `~/.agent-sandbox/llm.env`、`<workspace>/.agent-sandbox/llm.env`、実行時環境変数を優先順位順にマージする
7. `devcontainer exec --workspace-folder <path> <command>` を実行してコマンドの終了コードをそのまま返す
8. コマンド完了後、起動したコンテナを自動停止する（正常終了・SIGINT・SIGTERM いずれも対応）
9. 親プロセスが SIGKILL された場合に備え、バックグラウンドのウォッチドッグプロセスが親の生存を監視し、死亡検知時にコンテナを停止する

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
