#!/bin/bash
set -eu
export DISPLAY=:99
node_pid=''
display_pid=''
cleanup() {
    trap - EXIT TERM INT
    # 先让 Node 清理浏览器，再停止显示器；25 秒后强制结束仍未退出的子进程。
    if [ -n "$node_pid" ]; then
        kill -TERM "$node_pid" 2>/dev/null || true
        (sleep 25; kill -KILL "$node_pid" 2>/dev/null || true) &
        guard_pid=$!
        wait "$node_pid" 2>/dev/null || true
        kill "$guard_pid" 2>/dev/null || true
        wait "$guard_pid" 2>/dev/null || true
    fi
    if [ -n "$display_pid" ]; then
        kill -TERM "$display_pid" 2>/dev/null || true
        wait "$display_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > /tmp/katabump-xvfb.log 2>&1 &
display_pid=$!
for attempt in {1..10}; do
    if [ -S /tmp/.X11-unix/X99 ]; then break; fi
    kill -0 "$display_pid" 2>/dev/null || { cat /tmp/katabump-xvfb.log >&2; exit 1; }
    sleep 0.2
done
[ -S /tmp/.X11-unix/X99 ] || { echo '等待 Xvfb 超时' >&2; cat /tmp/katabump-xvfb.log >&2; exit 1; }
node /app/index.js "$@" &
node_pid=$!
status=0
wait -n -p finished "$display_pid" "$node_pid" || status=$?
if [ "$finished" = "$display_pid" ]; then
    display_pid=''
    echo 'Xvfb 已退出，结束容器以便 Docker 重启恢复' >&2
    exit 1
fi
node_pid=''
exit "$status"
