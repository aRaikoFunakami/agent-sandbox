#!/bin/bash
# Copy host auth credentials into container user's home directory.
# This script runs as postCreateCommand inside the container.
# Source files are staged by initializeCommand into .devcontainer/.host-auth/

set -e
AUTH_SRC="$(pwd)/.devcontainer/.host-auth"
HOME_DIR="$HOME"

if [ ! -d "$AUTH_SRC" ]; then
  echo "[setup-auth] No host auth found at $AUTH_SRC, skipping."
  exit 0
fi

# GitHub Copilot CLI: ~/.config/github-copilot/
if [ -d "$AUTH_SRC/github-copilot" ]; then
  mkdir -p "$HOME_DIR/.config/github-copilot"
  cp -r "$AUTH_SRC/github-copilot/." "$HOME_DIR/.config/github-copilot/"
  chmod 600 "$HOME_DIR/.config/github-copilot/"*.json 2>/dev/null || true
  echo "[setup-auth] GitHub Copilot CLI auth configured."
fi

# Copilot CLI session/config: ~/.copilot/
if [ -d "$AUTH_SRC/dot-copilot" ]; then
  mkdir -p "$HOME_DIR/.copilot"
  cp -r "$AUTH_SRC/dot-copilot/." "$HOME_DIR/.copilot/"
  chmod 600 "$HOME_DIR/.copilot/config.json" 2>/dev/null || true
  echo "[setup-auth] Copilot CLI config configured."
fi

# GitHub CLI: ~/.config/gh/
if [ -d "$AUTH_SRC/gh" ]; then
  mkdir -p "$HOME_DIR/.config/gh"
  cp -r "$AUTH_SRC/gh/." "$HOME_DIR/.config/gh/"
  chmod 600 "$HOME_DIR/.config/gh/hosts.yml" 2>/dev/null || true
  # If token was exported from host keyring, log in with it
  if [ -f "$AUTH_SRC/gh-token" ]; then
    GH_TOKEN=$(cat "$AUTH_SRC/gh-token")
    if [ -n "$GH_TOKEN" ]; then
      echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
    fi
  fi
  echo "[setup-auth] GitHub CLI auth configured."
fi

# Claude Code: ~/.claude/
if [ -d "$AUTH_SRC/dot-claude" ]; then
  mkdir -p "$HOME_DIR/.claude"
  # Copy only auth-related files, not session data
  for f in config.json settings.json credentials.json mcp-config.json; do
    if [ -f "$AUTH_SRC/dot-claude/$f" ]; then
      cp "$AUTH_SRC/dot-claude/$f" "$HOME_DIR/.claude/$f"
    fi
  done
  chmod 600 "$HOME_DIR/.claude/"*.json 2>/dev/null || true
  echo "[setup-auth] Claude Code config configured."
fi

# Clean up staged auth (it's in workspace mount, remove from host via container)
rm -rf "$AUTH_SRC"
echo "[setup-auth] Done. Staged auth files cleaned up."
