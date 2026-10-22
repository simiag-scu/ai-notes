#!/bin/zsh
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "请先安装 Node.js 22 或更新版本。"
  read -r "reply?按回车关闭"
  exit 1
fi
if curl --silent --fail http://127.0.0.1:17861/api/health >/dev/null; then
  open http://127.0.0.1:17861
  exit 0
fi
node server/index.mjs &
shiye_pid=$!
trap 'kill "$shiye_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..40}; do
  if curl --silent --fail http://127.0.0.1:17861/api/health >/dev/null; then
    open http://127.0.0.1:17861
    break
  fi
  sleep 0.25
done
wait "$shiye_pid"
