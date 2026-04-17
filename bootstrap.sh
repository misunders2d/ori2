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
#   --name <name>      Bot name (default: prompts during wizard). Doubles as the
#                      install directory name: `--name Foo` clones into $PWD/Foo/.
#   --dir <path>       Install directory (overrides --name default).
#   --no-systemd       Skip systemd/launchd unit installation prompt.
#   --branch <branch>  Git branch to clone (default: master).
#   --repo <url>       Repo URL (default: hardcoded below — edit before publishing).
#   --keep-upstream    Do NOT detach from the origin repo after cloning. By
#                      default we wipe .git and re-init so every bot has its
#                      own independent git history — evolution lives locally
#                      (or on the operator's own GitHub). Use this flag if
#                      you're the upstream maintainer (you have push rights)
#                      or you actively want to track upstream changes.
#   --help             Show this help.
#
# Environment:
#   ORI2_ASSUME_YES=1  Auto-accept all prompts (for CI / unattended installs).
#                      Without it the script asks before installing Node via
#                      nvm, build tools via apt/brew, and before loading the
#                      systemd/launchd unit.
#

set -euo pipefail

# Edit this when publishing your fork.
REPO="${ORI2_REPO:-https://github.com/misunders2d/ori2.git}"
BRANCH="master"
BOT_NAME=""
INSTALL_DIR=""
SKIP_SYSTEMD=0
KEEP_UPSTREAM=0
DID_CLONE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) BOT_NAME="$2"; shift 2 ;;
        --dir) INSTALL_DIR="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --no-systemd) SKIP_SYSTEMD=1; shift ;;
        --keep-upstream) KEEP_UPSTREAM=1; shift ;;
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

# Prompt-before-install helper. Returns 0 if the user agreed (or
# ORI2_ASSUME_YES=1 is set for unattended installs), 1 if declined.
confirm() {
    if [[ "${ORI2_ASSUME_YES:-0}" == "1" ]]; then
        return 0
    fi
    local prompt="${1:-Proceed?}"
    read -r -p "$prompt [Y/n] " yn </dev/tty || return 1
    [[ -z "$yn" ]] || [[ "$yn" =~ ^[Yy]$ ]]
}

# Detect OS + package manager once. Used by the prereq installers below so we
# don't re-probe per tool.
OS_KIND="unknown"       # linux | macos | unknown
PKG_MGR=""              # apt | dnf | pacman | brew | ""
case "$(uname -s)" in
    Linux)   OS_KIND="linux" ;;
    Darwin)  OS_KIND="macos" ;;
esac
if [[ "$OS_KIND" == "linux" ]]; then
    if command -v apt-get >/dev/null 2>&1; then PKG_MGR="apt"
    elif command -v dnf >/dev/null 2>&1; then PKG_MGR="dnf"
    elif command -v pacman >/dev/null 2>&1; then PKG_MGR="pacman"
    fi
elif [[ "$OS_KIND" == "macos" ]]; then
    if command -v brew >/dev/null 2>&1; then PKG_MGR="brew"; fi
fi

# Install git via the platform package manager, with confirmation.
install_git() {
    case "$PKG_MGR" in
        apt)    confirm "git is required. Install via 'sudo apt install git'?" && sudo apt-get update && sudo apt-get install -y git ;;
        dnf)    confirm "git is required. Install via 'sudo dnf install git'?"  && sudo dnf install -y git ;;
        pacman) confirm "git is required. Install via 'sudo pacman -S git'?"    && sudo pacman -S --noconfirm git ;;
        brew)   confirm "git is required. Install via 'brew install git'?"      && brew install git ;;
        *)      err "git not found and no supported package manager detected. Install git manually and re-run." ;;
    esac
    command -v git >/dev/null 2>&1 || err "git install failed — re-run after fixing, or install git manually."
}

# Install Node v22 LTS via nvm (user-scoped, no sudo, no collision with
# any system Node). Works on Linux + macOS identically.
install_node_via_nvm() {
    echo
    echo "Installing Node.js v22 LTS via nvm (user-scoped, no sudo)."
    echo "This writes to ~/.nvm and adds two lines to your shell rc file."
    echo
    if ! confirm "Proceed with nvm install?"; then
        err "Install Node v22+ manually (https://nodejs.org/en/download) and re-run."
    fi
    # Pinned nvm version — review before bumping. Fetched over HTTPS from
    # the nvm-sh repo's release tag (not master, so the script can't mutate
    # under us between runs).
    local NVM_VERSION="v0.40.1"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
    command -v nvm >/dev/null 2>&1 || err "nvm install failed — see https://github.com/nvm-sh/nvm for manual setup."
    nvm install 22
    nvm use 22
    hash -r
    command -v node >/dev/null 2>&1 || err "Node install via nvm failed unexpectedly."
}

step "Checking prerequisites"

# 1) git — most systems have it, but fresh containers / minimal VPS images
# sometimes don't.
if ! command -v git >/dev/null 2>&1; then
    install_git
fi

# 2) Node — the sharpest edge for non-tech users. Offer nvm install if
# missing OR too old.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
    if [[ "$NODE_MAJOR" -ge 22 ]]; then NODE_OK=1; fi
fi
if [[ "$NODE_OK" -ne 1 ]]; then
    if command -v node >/dev/null 2>&1; then
        echo "Found Node $(node -v), but v22+ is required."
    else
        echo "Node.js not found on PATH."
    fi
    install_node_via_nvm
fi

# 3) npm — bundled with Node, but sanity-check so we fail loud if the Node
# install dropped it.
command -v npm >/dev/null 2>&1 || err "npm not found even after Node install — this is unusual, see https://nodejs.org/en/download/"

# 4) Build tools — better-sqlite3 compiles a C++ native module via node-gyp
# at `npm install` time. Without make + python3 + a C++ compiler, the
# install fails ~30s in with a wall of compiler errors that are
# incomprehensible to non-tech users. Catch it HERE instead.
check_build_tools() {
    if [[ "$OS_KIND" == "linux" ]]; then
        local missing=()
        command -v make >/dev/null 2>&1 || missing+=("make")
        command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || missing+=("a C/C++ compiler")
        command -v python3 >/dev/null 2>&1 || missing+=("python3")
        if [[ ${#missing[@]} -eq 0 ]]; then return 0; fi
        echo "Missing build tools needed by better-sqlite3: ${missing[*]}"
        case "$PKG_MGR" in
            apt)    confirm "Install via 'sudo apt install build-essential python3'?" && sudo apt-get update && sudo apt-get install -y build-essential python3 ;;
            dnf)    confirm "Install via 'sudo dnf groupinstall \"Development Tools\" + python3'?" && sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y python3 ;;
            pacman) confirm "Install via 'sudo pacman -S base-devel python'?" && sudo pacman -S --noconfirm base-devel python ;;
            *)      err "Install build tools manually (C++ compiler + make + python3) and re-run." ;;
        esac
    elif [[ "$OS_KIND" == "macos" ]]; then
        if ! xcode-select -p >/dev/null 2>&1; then
            echo "Xcode Command Line Tools not installed — required by better-sqlite3."
            if confirm "Trigger Apple's install dialog now?"; then
                xcode-select --install || true
                echo
                echo "Complete the install dialog that just opened, then re-run this script."
                exit 0
            else
                err "Install Xcode CLT manually: 'xcode-select --install' and re-run."
            fi
        fi
    fi
}
check_build_tools

echo "Node $(node -v), npm $(npm -v), git $(git --version | head -1)"

# Are we already in the repo?
if [[ -f "package.json" ]] && [[ -d ".pi/extensions" ]] && [[ -f "src/index.ts" ]]; then
    INSTALL_DIR="$(pwd)"
    step "Already in an ori2 checkout at $INSTALL_DIR"
else
    # If neither --dir nor --name was given, prompt for the bot name now so
    # the folder we clone into matches what the user will call the bot —
    # no confusing "install is called ori2/ but my bot is called MyBot"
    # mismatch. The wizard gets the same name pre-fed so the user isn't
    # asked twice.
    if [[ -z "$INSTALL_DIR" ]] && [[ -z "$BOT_NAME" ]]; then
        step "Name your assistant"
        echo "This name doubles as the install-folder name — the bot's code"
        echo "and data will live in \$PWD/<name>/."
        echo
        echo "Letters, numbers, underscores only. Examples: MarketingBot,"
        echo "amazon_helper, ClaireBot. Press ENTER for the default (ori2)."
        echo
        read -r -p "Name: " BOT_NAME </dev/tty || BOT_NAME=""
        BOT_NAME="${BOT_NAME:-ori2}"
        # Sanitize to the wizard's character class so bash-side and node-side
        # always agree on the final name.
        CLEANED="$(printf '%s' "$BOT_NAME" | tr -c 'a-zA-Z0-9_-' '_')"
        if [[ "$CLEANED" != "$BOT_NAME" ]]; then
            echo "(cleaned to: $CLEANED)"
            BOT_NAME="$CLEANED"
        fi
        echo
    fi
    if [[ -z "$INSTALL_DIR" ]]; then
        # --name always controls the folder name now: `--name Foo` → ./Foo/,
        # default (ENTER at the prompt above) → ./ori2/. Never the old
        # "folder = ori2, bot = whatever" mismatch.
        INSTALL_DIR="$(pwd)/${BOT_NAME:-ori2}"
    fi
    # Safety: if the target exists and isn't empty and isn't an ori2 checkout,
    # refuse to clobber. Non-tech users accidentally targeting their dev repo
    # or some other project has been the #1 bootstrap failure mode.
    if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
        if [[ ! -f "$INSTALL_DIR/src/index.ts" ]] || [[ ! -d "$INSTALL_DIR/.pi/extensions" ]]; then
            err "Target $INSTALL_DIR exists and is not an ori2 checkout. Pick a different --name or --dir, or remove the directory first."
        fi
    fi
    step "Cloning $REPO ($BRANCH) into $INSTALL_DIR"
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        # After first-run the repo is detached from upstream (no `origin`
        # remote) — skip the pull in that case instead of failing pipefail.
        if (cd "$INSTALL_DIR" && git remote get-url origin >/dev/null 2>&1); then
            echo "Existing checkout found — pulling latest."
            (cd "$INSTALL_DIR" && git pull --ff-only origin "$BRANCH")
        else
            echo "Existing checkout found (detached — no upstream). Skipping pull."
        fi
    else
        git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
        DID_CLONE=1
    fi
    cd "$INSTALL_DIR"
fi

# Detach from origin so the operator's evolution lives on their own git
# timeline — this is the intended model (see .ori2-baseline below +
# INSTALL.md "Publishing your evolved bot"). --keep-upstream opts out.
# Only detaches freshly-cloned repos: if the operator ran bootstrap inside
# their own checkout we leave their remotes alone.
if [[ "$DID_CLONE" -eq 1 ]] && [[ "$KEEP_UPSTREAM" -ne 1 ]]; then
    step "Detaching from upstream (fresh git history for your fork)"
    UPSTREAM_SHA="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    UPSTREAM_SHORT="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
    UPSTREAM_DESC="$(git -C "$INSTALL_DIR" describe --always --tags 2>/dev/null || echo "$UPSTREAM_SHORT")"
    rm -rf "$INSTALL_DIR/.git"
    # Write the baseline marker BEFORE `git init` so the snapshot commit
    # includes it. scripts/sync-baseline.sh reads this to know which repo +
    # SHA to diff against when pulling upstream updates later.
    cat > "$INSTALL_DIR/.ori2-baseline" <<EOF
# ori2 baseline marker — auto-generated by bootstrap.sh on clone-and-detach.
# scripts/sync-baseline.sh reads this to locate upstream + the SHA you were
# forked from. Update repo= if you migrate to a different upstream.
repo=$REPO
branch=$BRANCH
baseline_sha=$UPSTREAM_SHA
baseline_desc=$UPSTREAM_DESC
cloned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    (
        cd "$INSTALL_DIR"
        git init -q -b "$BRANCH"
        # Don't touch the operator's global git config. If they haven't
        # configured user.name / user.email, supply a local-only fallback
        # just for this initial commit via -c flags.
        GIT_USER_NAME="$(git config --get user.name || echo "${BOT_NAME:-ori2 operator}")"
        GIT_USER_EMAIL="$(git config --get user.email || echo "${USER}@$(hostname -s 2>/dev/null || echo local)")"
        git add -A
        git -c user.name="$GIT_USER_NAME" -c user.email="$GIT_USER_EMAIL" \
            commit -q -m "Initial snapshot from ori2 baseline ${UPSTREAM_DESC}"
        echo "✓ Detached. New repo: $(git rev-parse --short HEAD) on branch $BRANCH."
        echo "  Baseline marker: .ori2-baseline (baseline_sha=${UPSTREAM_SHORT})"
        echo
        echo "  To publish this bot to your own GitHub:"
        echo "    git remote add origin git@github.com:YOU/YOUR-BOT.git"
        echo "    git push -u origin ${BRANCH}"
        echo "  To pull future ori2 baseline updates:"
        echo "    ./scripts/sync-baseline.sh"
    )
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
# Pre-write BOT_NAME to .env whenever --name is given. Without this, if .env
# from a prior install already has a different BOT_NAME, index.ts's
# dotenv.config() loads the OLD name and isSystemConfigured() finds the old
# vault → silently skips the wizard and boots the old bot while pretending
# to install the new one. The wizard itself still rewrites .env at the end.
if [[ -n "$BOT_NAME" ]]; then
    if [[ -f ".env" ]]; then
        grep -v '^BOT_NAME=' .env > .env.tmp 2>/dev/null || true
        mv .env.tmp .env
    fi
    echo "BOT_NAME=$BOT_NAME" >> .env
fi
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

step "🎉  Install complete!"
BOT_LABEL="${BOT_NAME:-your bot}"
cat <<EOF

Your assistant is installed at:
  $INSTALL_DIR

────────────────────────────────────────────────────────────
WHAT TO DO NEXT — pick one:
────────────────────────────────────────────────────────────

▸ TALK TO IT IN YOUR TERMINAL (simplest)
    cd "$INSTALL_DIR"
    npm run start
  Type messages, press ENTER. Type /exit to quit.

▸ CONNECT IT TO TELEGRAM (so you can chat from your phone)
    1. Open Telegram, search for "BotFather" (the official @BotFather).
    2. Send /newbot. It asks for a name, then a @username. Save the token
       it gives you (looks like 123456:AAH...).
    3. Start your bot in terminal:  cd "$INSTALL_DIR" && npm run start
    4. In the terminal bot, type:
         /connect-telegram <paste-your-BotFather-token>
    5. Open your new bot in Telegram, send any message.
    6. It'll show a passcode in the terminal. DM your bot:
         /init <that-passcode>
       You are now admin — from anywhere.

▸ RUN IT 24/7 IN THE BACKGROUND
    Already done if you answered "y" to the service unit prompt above.
    Otherwise see INSTALL.md → "Headless deployment".

────────────────────────────────────────────────────────────
GETTING HELP
────────────────────────────────────────────────────────────
  INSTALL.md       — full deployment guide
  README.md        — what ori2 is and what it can do
  /help  (in bot)  — list commands once the bot is running
  https://github.com/misunders2d/ori2/issues — report problems

Notes:
  • Bot name: $BOT_LABEL (change in .env if needed)
  • Data lives in $INSTALL_DIR/data/$BOT_LABEL/
  • Your vault is in data/$BOT_LABEL/vault.json (file mode 0600 — keep it private)
  • Daemon mode auto-detects no-TTY (systemd, ssh detached, docker)
    Force interactive anywhere with:  ORI2_DAEMON=false npm run start

EOF
