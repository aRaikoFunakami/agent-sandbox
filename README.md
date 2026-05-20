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
agent-sandbox init                            # 軽量 base profile
agent-sandbox init --install=playwright-cli   # playwright-cli profile
agent-sandbox init --force                    # 既存の設定を上書き
```

デフォルトの `base` profile は、公式 Dev Containers base image (`mcr.microsoft.com/devcontainers/base:ubuntu-24.04`) を使い、Copilot CLI / Claude Code / GitHub CLI だけを Features で入れます。Playwright と Chromium は入りません。

`--install=playwright-cli` を指定した場合だけ、Playwright 公式 image をベースに `@playwright/cli` と Chromium をイメージビルド時に入れます。ブラウザを `postCreateCommand` で入れないため、ワークスペースごとのコンテナ writable layer が肥大化しにくくなります。

生成後は `.devcontainer/llm.env` を編集してから `agent-sandbox copilot --version` で起動確認できます。

### コンテナの状態確認・停止

```bash
agent-sandbox status        # コンテナ名・状態・イメージを表示
agent-sandbox stop          # カレントワークスペースのコンテナを停止
agent-sandbox -w /path/to/project stop  # ワークスペースを明示して停止
```

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

# ワークスペースを明示指定
agent-sandbox -w /path/to/project copilot --allow-all -p "review code"
```

## 動作

1. カレントディレクトリから上方向に `.devcontainer/` ディレクトリを探す
2. `devcontainer` コマンドが未インストールの場合、`npm install -g @devcontainers/cli` を自動実行
3. 対象 devcontainer が未起動なら、ワークスペース単位のロックを取得してから `devcontainer up --workspace-folder <path>` を実行
4. 起動後のイメージを `agent-sandbox-devcontainer:base` または `agent-sandbox-devcontainer:playwright-cli` に tag し、別ワークスペースの `cacheFrom` に使えるようにする
5. `devcontainer exec --workspace-folder <path> <command>` を実行してコマンドの終了コードをそのまま返す

## 同時実行時の挙動

`devcontainer` CLI は既存コンテナを `devcontainer.local_folder=<workspace>` ラベルで探索して再利用します。ただし、コンテナがまだ存在しない cold start で `devcontainer up` が完全に同時実行されると、「存在確認 → docker run」の race により同じワークスペースに複数コンテナが作られる可能性があります。

`agent-sandbox` はこれを避けるため、`.devcontainer/.agent-sandbox-up.lock/` を使って同一ワークスペースの初回起動を直列化します。起動完了後の `devcontainer exec` は複数プロセスから並行実行できます。

`status` / `stop` はランダムな Docker コンテナ名ではなく `devcontainer.local_folder` ラベルで対象を特定するため、コンテナ名が毎回変わっても動作します。

## ストレージ実測メモ

同一 profile のワークスペースを2つ作成した実測では、2個目以降も `vsc-<workspace>-<hash>` イメージタグとコンテナ writable layer が作られるため、約 1.25GB / workspace 程度の増分がありました。

| profile | 2個目作成時の追加増分 | コンテナ writable layer |
|---|---:|---:|
| `base` | Images +630MB / Containers +627MB | 約 627MB / workspace |
| `playwright-cli` | Images +620MB / Containers +626MB | 約 625MB / workspace |

以前のように `postCreateCommand` で Chromium を入れる構成では Playwright 利用時の writable layer が約 1.62GB / workspace まで増えていました。現在は Dockerfile のビルド時に Chromium を入れるため、その増分は抑えられています。
