#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22.13 或更新版本，然后重试。'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)' || { echo 'Node.js 版本过旧，需要 22.13+。'; exit 1; }
mkdir -p "$HOME/.local/share/gpuq-console" "$HOME/.local/bin"
origin='__GPUQ_PUBLIC_ORIGIN__'
case "$origin" in https://*) ;; *) echo 'Download this installer from your running GPUQ portal.'; exit 1;; esac
temporary=$(mktemp "$HOME/.local/share/gpuq-console/.client.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
curl -fsSL "$origin/gpuctl.mjs" -o "$temporary"
node --input-type=module --check < "$temporary"
mv "$temporary" "$HOME/.local/share/gpuq-console/gpuctl.mjs"
chmod 700 "$HOME/.local/share/gpuq-console/gpuctl.mjs"
ln -sf "$HOME/.local/share/gpuq-console/gpuctl.mjs" "$HOME/.local/bin/gpuctl"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc";; *) profile="$HOME/.bashrc";; esac
     line='export PATH="$HOME/.local/bin:$PATH"'
     grep -Fqx "$line" "$profile" 2>/dev/null || printf '\n%s\n' "$line" >> "$profile"
     echo '请重新打开终端以加载 gpuctl 命令。';;
esac
echo '安装完成：gpuctl login → gpuctl state → gpuctl use 机器名 → gpuctl ssh'
