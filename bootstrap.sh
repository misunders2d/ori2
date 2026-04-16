#!/usr/bin/env bash
#
# ori2 bootstrap — install + first-run setup on a fresh VPS or workstation.
#
# Usage (one-liner):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/<USER>/ori2/master/bootstrap.sh)" -- \
#       --name MyBot
#
# Or after cloning:
#   ./bootstrap.sh --name MyBot
#
# Flags:
#   --name <name>      Bot name (default: prompts during wizard)
#   --dir <path>       Install directory (default: $PWD/ori2 if not in repo)
#   --no-systemd       Skip systemd unit installation prompt
#   --branch <branch>  Git branch to clone (default: master)
#   --repo <url>       Repo URL (default: hardcoded below — edit before publishing)
#   --help             Show this help
#

set -euo pipefail

# Edit this when publishing your fork.
REPO="${ORI2_REPO:-https://github.com/misunders2d/ori2.git}"
BRANCH="master"
BOT_NAME=""
INSTALL_DIR=""
SKIP_SYSTEMD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) BOT_NAME="$2"; shift 2 ;;
        --dir) INSTALL_DIR="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --no-systemd) SKIP_SYSTEMD=1; shift ;;
        --help|-h)
            sed -n 's/^# \?//p' "$0" | head -25
            exit 0 ;;
        *)
            echo "Unknown flag: $1" >&2
            exit 1 ;;
    esac
done

step() {
    echo
    echo "=== $* ==="
}

err() {
    echo "ERROR: $*" >&2
    exit 1
}

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "$1 is required but not installed. Install it first and re-run."
    fi
}

step "Checking prerequisites"
require git
require node
require npm
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
# Node 22 is current LTS (Oct 2024); CI runs the suite on 22 + 24. Older
# versions hit subtle differences in node:test runner globbing and --import.
if [[ "$NODE_MAJOR" -lt 22 ]]; then
    err "Node.js v22+ required (found v$(node -v)). Install via nvm: 'nvm install --lts'"
fi
echo "Node $(node -v), npm $(npm -v), git $(git --version | head -1)"

# Are we already in the repo?
if [[ -f "package.json" ]] && [[ -d ".pi/extensions" ]] && [[ -f "src/index.ts" ]]; then
    INSTALL_DIR="$(pwd)"
    step "Already in an ori2 checkout at $INSTALL_DIR"
else
    if [[ -z "$INSTALL_DIR" ]]; then
        INSTALL_DIR="$(pwd)/ori2"
    fi
    step "Cloning $REPO ($BRANCH) into $INSTALL_DIR"
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        echo "Existing checkout found — pulling latest."
        (cd "$INSTALL_DIR" && git pull --ff-only origin "$BRANCH")
    else
        git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

step "Installing npm dependencies"
npm install --no-fund --no-audit

# Run the test suite before any first-run setup so a broken baseline never
# reaches the wizard or systemd unit. Halt loudly on failure — never silently
# proceed to register a service unit pointing at code that fails its own
# regression suite.
step "Running baseline test suite"
if ! npm test --silent; then
    echo
    echo "❌ Baseline tests failed. Aborting bootstrap."
    echo "   Inspect the failures above. Re-run the bootstrap once they are green."
    echo "   To skip (NOT recommended; bypasses the safety net): export ORI2_SKIP_TESTS=1"
    if [[ "${ORI2_SKIP_TESTS:-0}" != "1" ]]; then
        exit 1
    fi
    echo "   ORI2_SKIP_TESTS=1 set — proceeding despite failures (you've been warned)."
fi

step "First-run setup"
if [[ -f ".env" ]] && [[ -f "data/${BOT_NAME:-Test_bot}/vault.json" ]]; then
    echo "Already configured (vault + .env present). Skipping wizard."
else
    if [[ -n "$BOT_NAME" ]]; then
        echo "Bot name from CLI: $BOT_NAME"
        # The wizard reads from stdin; pre-fill the BOT_NAME line via expect-style
        # printf. Other prompts will block for interactive input.
        echo
        echo "The wizard will prompt for: admin IDs (optional, ENTER to skip),"
        echo "and a primary AI provider key. Have your Anthropic / Google /"
        echo "OpenAI API key ready."
        echo
        # Pre-feed bot name; rest is interactive. printf with newline lets
        # readline accept the value, then the wizard awaits the next prompt.
        ( printf '%s\n' "$BOT_NAME"; cat ) | npm run start
    else
        echo "Launching interactive wizard..."
        npm run start
    fi
fi

# Service-manager unit (optional). systemd on Linux, launchd on macOS.
# Combined under one --no-systemd flag because both are "auto-install the
# headless service unit" — keeping a single skip flag avoids a confusing
# --no-systemd-but-yes-launchd matrix.
if [[ "$SKIP_SYSTEMD" -ne 1 ]] && command -v systemctl >/dev/null 2>&1; then
    step "Optional: install systemd user unit for headless deployment"
    echo "This installs ~/.config/systemd/user/ori2-${BOT_NAME:-yourname}.service"
    echo "to run the bot under your user account, auto-restart on crash, and"
    echo "survive logout (with linger enabled)."
    echo
    read -r -p "Install systemd user unit? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
        if [[ -z "$BOT_NAME" ]]; then
            read -r -p "Bot name for the unit (matches BOT_NAME in .env): " BOT_NAME
        fi
        NPM_PATH="$(command -v npm)"
        if [[ -z "$NPM_PATH" ]]; then
            err "npm not found on PATH — required to render systemd unit."
        fi
        # Bake an explicit PATH so nvm/asdf/volta-installed Node resolves
        # under systemd's minimal env. Mirror the launchd block.
        PATH_ENV="$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin"
        UNIT_DIR="$HOME/.config/systemd/user"
        mkdir -p "$UNIT_DIR"
        # Pre-create the per-bot Pi-state dir so PI_CODING_AGENT_DIR points at
        # something Pi can immediately read/write.
        mkdir -p "$INSTALL_DIR/data/${BOT_NAME}/.pi-state"
        UNIT_FILE="$UNIT_DIR/ori2-${BOT_NAME}.service"
        sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
            -e "s|@BOT_NAME@|$BOT_NAME|g" \
            -e "s|@USER@|$USER|g" \
            -e "s|@NPM_PATH@|$NPM_PATH|g" \
            -e "s|@PATH@|$PATH_ENV|g" \
            "$INSTALL_DIR/systemd/ori2.service" > "$UNIT_FILE"
        chmod 0644 "$UNIT_FILE"
        echo "Installed: $UNIT_FILE"
        systemctl --user daemon-reload
        echo
        echo "To start now:   systemctl --user start ori2-${BOT_NAME}"
        echo "To enable boot: systemctl --user enable ori2-${BOT_NAME}"
        echo "To survive logout: sudo loginctl enable-linger $USER"
        echo "Logs:           journalctl --user -u ori2-${BOT_NAME} -f"
    fi
elif [[ "$SKIP_SYSTEMD" -ne 1 ]] && [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    step "Optional: install launchd user agent for headless deployment"
    echo "This installs ~/Library/LaunchAgents/dev.ori2.${BOT_NAME:-MyBot}.plist"
    echo "to run the bot under your user account and auto-restart on crash."
    echo "Logs go to /tmp/ori2-${BOT_NAME:-MyBot}.log."
    echo
    read -r -p "Install launchd user agent? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
        if [[ -z "$BOT_NAME" ]]; then
            read -r -p "Bot name for the agent (matches BOT_NAME in .env): " BOT_NAME
        fi
        NPM_PATH="$(command -v npm)"
        if [[ -z "$NPM_PATH" ]]; then
            err "npm not found on PATH — required to render launchd plist."
        fi
        # launchd jobs run with a minimal PATH; bake the dir holding npm
        # into PATH= so node + tsx + git resolve. Append the standard dirs
        # in case the agent shells out.
        PATH_ENV="$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin"
        AGENT_DIR="$HOME/Library/LaunchAgents"
        mkdir -p "$AGENT_DIR"
        # Pre-create the per-bot Pi-state dir so PI_CODING_AGENT_DIR points at
        # something Pi can immediately read/write.
        mkdir -p "$INSTALL_DIR/data/${BOT_NAME}/.pi-state"
        AGENT_LABEL="dev.ori2.${BOT_NAME}"
        AGENT_FILE="$AGENT_DIR/${AGENT_LABEL}.plist"
        sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
            -e "s|@BOT_NAME@|$BOT_NAME|g" \
            -e "s|@USER@|$USER|g" \
            -e "s|@NPM_PATH@|$NPM_PATH|g" \
            -e "s|@PATH@|$PATH_ENV|g" \
            "$INSTALL_DIR/launchd/dev.ori2.plist.template" > "$AGENT_FILE"
        chmod 0644 "$AGENT_FILE"
        echo "Installed: $AGENT_FILE"
        # Reload if already loaded (idempotent re-run); ignore failure on
        # first install where the label isn't loaded yet.
        launchctl unload "$AGENT_FILE" 2>/dev/null || true
        if launchctl load "$AGENT_FILE"; then
            echo "Loaded:    $AGENT_LABEL"
        else
            echo "WARNING: launchctl load failed — inspect the plist with:"
            echo "  plutil -lint $AGENT_FILE"
        fi
        echo
        echo "To start now:   launchctl start ${AGENT_LABEL}"
        echo "To stop:        launchctl stop  ${AGENT_LABEL}"
        echo "To restart:     launchctl kickstart -k gui/\$(id -u)/${AGENT_LABEL}"
        echo "To uninstall:   launchctl unload $AGENT_FILE && rm $AGENT_FILE"
        echo "Logs:           tail -f /tmp/ori2-${BOT_NAME}.log"
    fi
fi

step "Done"
echo "Repo:  $INSTALL_DIR"
echo "Start: cd $INSTALL_DIR && npm run start"
echo "Daemon (no TTY) auto-detected. Force interactive with ORI2_DAEMON=false."
echo
echo "See INSTALL.md for systemd / launchd / Docker deployment notes."
