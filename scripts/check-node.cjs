#!/usr/bin/env node
// Fail-fast Node version check. Runs as the "prestart" hook so anyone who
// invokes `npm run start` (or `npm start`) on a too-old Node sees a useful
// message instead of the cryptic regex-flag SyntaxError that pi-tui throws
// on Node < 20 (and other ES2024+ syntax that pi-coding-agent uses on
// Node < 22).
//
// We can't bypass this — package.json's "engines.node" >= 22 is advisory in
// npm by default. This script is the enforcement.

const major = parseInt(process.versions.node.split(".")[0], 10);
if (major >= 22) process.exit(0);

const RED = process.stdout.isTTY ? "\x1b[31m" : "";
const BOLD = process.stdout.isTTY ? "\x1b[1m" : "";
const CYAN = process.stdout.isTTY ? "\x1b[36m" : "";
const DIM = process.stdout.isTTY ? "\x1b[2m" : "";
const RESET = process.stdout.isTTY ? "\x1b[0m" : "";

console.error("");
console.error(`${RED}${BOLD}✖ ori2 requires Node 22+ — you are on ${process.version}.${RESET}`);
console.error("");
console.error("Pick one fix:");
console.error("");
console.error(`  ${BOLD}1. Use the launcher${RESET} ${DIM}(picks up nvm-installed Node automatically)${RESET}`);
console.error(`     ${CYAN}./start.sh${RESET}`);
console.error("");
console.error(`  ${BOLD}2. Switch your shell to nvm Node 22+ first${RESET}`);
console.error(`     ${CYAN}source ~/.nvm/nvm.sh && nvm use 22${RESET}`);
console.error(`     ${CYAN}npm run start${RESET}`);
console.error("");
console.error(`  ${BOLD}3. Open a new terminal${RESET} ${DIM}(if bootstrap.sh just installed nvm — its rc-file source lines fire on new shells)${RESET}`);
console.error("");
process.exit(1);
