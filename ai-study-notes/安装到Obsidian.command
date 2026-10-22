#!/bin/zsh
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/install-obsidian.mjs
read -r "reply?按回车关闭"
