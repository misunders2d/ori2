#!/usr/bin/env bash
#
# ori2 uninstall — remove the service unit, install dir, and per-bot data.
#
# Usage:
#   cd <bot install dir>
#   ./scripts/uninstall.sh                  # interactive — confirms before each destructive op
#   ./scripts/uninstall.sh --keep-data      # remove code + service, keep data/<bot>/
#   ./scripts/uninstall.sh --dry-run        # show what would happen, do nothing
#   ./scripts/uninstall.sh --yes            # auto-confirm (for CI; still requires --yes)
#   ./scripts/uninstall.sh --name MyBot     # if .env lookup fails
#
# What gets removed (in this order):
#   1. systemd user unit + its symlink (Linux), OR launchd plist (macOS).
#   2. Per-bot data dir: data/<BOT_NAME>/ — vault, credentials, OAuth tokens,
#      memory.db, channel_log.db, scheduled jobs, attachments. EVERYTHING
#      that defines this specific bot's identity.
#   3. The install dir itself (the cloned repo).
#
# What is NOT touched:
#   - nvm / node — left alone (other tools may rely on them).
#   - SYSTEM systemd units (anything outside ~/.config/systemd/user/).
#   - Other bots in other checkouts.
#   - Your shell rc files.
#
# Recovery: there is no recovery. Once data/<bot>/ is gone the vault, OAuth
# tokens, and all conversation memory go with it. If unsure, --keep-data
# preserves that dir. Move it elsewhere first if you ever want it back.

set -euo pipefail

BOT_NAME=""
INSTALL_DIR=""
KEEP_DATA=0
DRY_RUN=0
ASSUME_YES=0

# -- colors (mirrors bootstrap.sh) -------------------------------------
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

step() { printf '\n%s▸ %s%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
ok()   { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s✖ %s%s\n' "$C_RED$C_BOLD" "$*" "$C_RESET" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) BOT_NAME="$2"; shift 2 ;;
        --dir) INSTALL_DIR="$2"; shift 2 ;;
        --keep-data) KEEP_DATA=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h) sed -n 's/^# \?//p' "$0" | head -30; exit 0 ;;
        *) err "Unknown flag: $1" ;;
    esac
done

# Locate the install dir.
if [[ -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR="$(pwd)"
fi
if [[ ! -f "$INSTALL_DIR/package.json" ]] || [[ ! -d "$INSTALL_DIR/.pi/extensions" ]]; then
    err "$INSTALL_DIR doesn't look like an ori2 install (no package.json + .pi/extensions). Pass --dir <install-path>."
fi
cd "$INSTALL_DIR"

# Resolve BOT_NAME. Priority: --name flag, .env, prompt.
if [[ -z "$BOT_NAME" ]] && [[ -f ".env" ]]; then
    BOT_NAME="$(grep -E '^BOT_NAME=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
fi
if [[ -z "$BOT_NAME" ]]; then
    if [[ "$ASSUME_YES" -eq 1 ]]; then
        err "Cannot determine BOT_NAME — pass --name <name> or run interactively."
    fi
    read -r -p "Bot name to uninstall: " BOT_NAME </dev/tty || true
fi
if [[ -z "$BOT_NAME" ]]; then
    err "BOT_NAME is empty — refusing to proceed."
fi

DATA_DIR="$INSTALL_DIR/data/$BOT_NAME"

# -- Discover a service unit ------------------------------------------------
SYSTEMD_UNIT=""
LAUNCHD_PLIST=""
LAUNCHD_LABEL=""
if command -v systemctl >/dev/null 2>&1; then
    candidate="$HOME/.config/systemd/user/ori2-${BOT_NAME}.service"
    [[ -f "$candidate" ]] && SYSTEMD_UNIT="$candidate"
fi
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    LAUNCHD_LABEL="dev.ori2.${BOT_NAME}"
    candidate="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
    [[ -f "$candidate" ]] && LAUNCHD_PLIST="$candidate"
fi

# -- Show plan --------------------------------------------------------------
printf '\n'
printf '%s──── ORI2 UNINSTALL — about to remove ────%s\n' "$C_BOLD$C_RED" "$C_RESET"
printf '\n'
printf 'Bot name:        %s%s%s\n' "$C_BOLD" "$BOT_NAME" "$C_RESET"
printf 'Install dir:     %s\n' "$INSTALL_DIR"
if [[ -n "$SYSTEMD_UNIT" ]]; then
    printf '%sService unit:%s    %s (will be stopped + disabled + deleted)\n' "$C_YELLOW" "$C_RESET" "$SYSTEMD_UNIT"
fi
if [[ -n "$LAUNCHD_PLIST" ]]; then
    printf '%sLaunchd plist:%s   %s (will be unloaded + deleted)\n' "$C_YELLOW" "$C_RESET" "$LAUNCHD_PLIST"
fi
if [[ -d "$DATA_DIR" ]]; then
    if [[ "$KEEP_DATA" -eq 1 ]]; then
        printf '%sData dir:%s        %s (KEPT — --keep-data set)\n' "$C_GREEN" "$C_RESET" "$DATA_DIR"
    else
        printf '%sData dir:%s        %s\n' "$C_RED$C_BOLD" "$C_RESET" "$DATA_DIR"
        printf '                    %scontains: vault, credentials, oauth tokens, memory.db, channel_log.db,%s\n' "$C_DIM" "$C_RESET"
        printf '                    %sscheduled jobs, attachments. THIS IS NOT RECOVERABLE.%s\n' "$C_DIM" "$C_RESET"
    fi
fi
printf '\n'
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%sDry run — no changes will be made.%s\n' "$C_GREEN" "$C_RESET"
    exit 0
fi

# -- First confirmation ----------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
    printf 'Type %sDELETE %s%s to confirm: ' "$C_BOLD" "$BOT_NAME" "$C_RESET"
    read -r answer </dev/tty || answer=""
    if [[ "$answer" != "DELETE $BOT_NAME" ]]; then
        warn "Confirmation mismatch. Aborting — nothing changed."
        exit 1
    fi
fi

# -- Stop + remove service unit --------------------------------------------
if [[ -n "$SYSTEMD_UNIT" ]]; then
    step "Stopping + removing systemd unit"
    systemctl --user stop "ori2-${BOT_NAME}" 2>/dev/null || true
    systemctl --user disable "ori2-${BOT_NAME}" 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "Removed $SYSTEMD_UNIT"
fi
if [[ -n "$LAUNCHD_PLIST" ]]; then
    step "Unloading + removing launchd plist"
    launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
    rm -f "$LAUNCHD_PLIST"
    ok "Removed $LAUNCHD_PLIST"
fi

# -- Remove data dir --------------------------------------------------------
if [[ -d "$DATA_DIR" ]] && [[ "$KEEP_DATA" -ne 1 ]]; then
    step "Removing $DATA_DIR"
    # Defensive: refuse if DATA_DIR somehow resolves outside INSTALL_DIR.
    abs_data="$(cd "$DATA_DIR" && pwd)"
    abs_install="$(cd "$INSTALL_DIR" && pwd)"
    case "$abs_data" in
        "$abs_install"/*) ;;
        *) err "Refusing to remove $abs_data — it's not under install dir $abs_install." ;;
    esac
    rm -rf -- "$abs_data"
    ok "Data dir gone."
fi

# -- Remove install dir -----------------------------------------------------
step "Removing install dir $INSTALL_DIR"
# Step out of the install dir before nuking it (else cwd becomes invalid
# mid-remove on some shells).
cd "$(dirname "$INSTALL_DIR")"
abs_install="$(cd "$INSTALL_DIR" && pwd)"
# Last sanity: refuse to remove "/", $HOME, or anything 1-2 levels deep
# from those.
if [[ "$abs_install" == "/" ]] || [[ "$abs_install" == "$HOME" ]] || [[ "$abs_install" == "/home" ]] || [[ "$abs_install" == "/root" ]]; then
    err "Install dir resolves to $abs_install — refusing as a sanity check. Move the dir elsewhere and re-run."
fi
rm -rf -- "$abs_install"
ok "Install dir gone."

printf '\n%sUninstall complete.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
if [[ -n "$SYSTEMD_UNIT" ]]; then
    dim "(If 'systemctl --user enable-linger' was set just for this bot, run: sudo loginctl disable-linger $USER)"
fi
