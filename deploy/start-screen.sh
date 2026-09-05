#!/usr/bin/env bash
# 在 screen 里启动排卡服务。
#
# 用法（在项目目录里）：
#   bash deploy/start-screen.sh          启动
#   bash deploy/start-screen.sh status   看状态
#   bash deploy/start-screen.sh stop     停止
#
# 启动后：
#   screen -r arcade    进去看实时日志（离开按 Ctrl+A 然后 D，别按 Ctrl+C）
#   tail -f data/arcade-queue.log        不进 screen 也能看日志
#
# 关于 screen 方式的两个固有缺点，本脚本都处理了：
#   1. 程序崩了不会自动重启 → 用一个 while 循环守护，退出就等 5 秒重来
#   2. 服务器重启后不会自启  → 见脚本末尾提示的 crontab @reboot 办法

set -uo pipefail

SESSION="arcade"
# 用脚本自身位置推出项目根目录，这样从任何地方执行都对。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_DIR" || { echo "进不去项目目录 $PROJECT_DIR"; exit 1; }

# ---------- 前置检查 ----------

if ! command -v screen >/dev/null 2>&1; then
  echo "没装 screen。先执行：apt install -y screen"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没装 node。见 DEPLOY.md 第 2 步"
  exit 1
fi

NODE_PATH_REAL="$(command -v node)"

# ---------- 子命令 ----------

# 只认「活着的」会话。
#
# screen -ls 会把已经死掉的会话也列出来，标成 (Dead) 或 (Remote or dead)。
# 如果把它们当成「正在运行」，用户就会陷入「说在跑但服务其实没了、
# 又启动不了」的死局（实测踩过）。所以先 screen -wipe 清理墓碑，再判断。
session_exists() {
  screen -wipe >/dev/null 2>&1 || true
  # screen -ls 在有死会话时会往输出里塞 "Remove dead screens with 'screen -wipe'."
  # 这类提示，直接展示给用户会让人误以为出了错，所以只取会话行。
  screen -ls 2>/dev/null | grep "[.]${SESSION}[[:space:]]" | grep -qvE "Dead|dead"
}

# 清掉孤儿 socket。
#
# screen 进程被 SIGKILL 或机器断电时，socket 文件会留下来，状态显示成
# "Remote or dead"，而 `screen -wipe` 清不掉这一种（它只处理 Dead）。
# 后果是 start 一直说「已经在跑了」但服务其实没有——用户会彻底卡住（实测踩过）。
# 判据：socket 名字形如 <pid>.<session>，那个 pid 已经不存在了就是孤儿。
reap_orphan_sockets() {
  local dir sock pid candidates
  # 不从 screen -ls 的输出里解析目录：那几行末尾带 \r，正则很容易匹配不上
  # （实测踩过，导致清理静默失效）。直接找标准位置更可靠。
  # 全部用 :- 兜底：crontab @reboot 的执行环境里 HOME/USER 可能都是空的。
  local me="${USER:-$(id -un 2>/dev/null || echo root)}"
  candidates="${SCREENDIR:-} ${HOME:-/root}/.screen /run/screen/S-${me} /var/run/screen/S-${me} /tmp/screens/S-${me}"
  for dir in $candidates; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    for sock in "$dir"/*."${SESSION}"; do
      [ -e "$sock" ] || continue
      pid="${sock##*/}"
      pid="${pid%%.*}"
      case "$pid" in
        '' | *[!0-9]*) continue ;;
      esac
      # kill -0 只探测进程是否存在，不真的发信号。
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$sock"
        echo "已清理残留的 screen socket（$(basename "$sock")，进程 $pid 已不存在）"
      fi
    done
  done
}

# 打印会话行：只显示活着的，死会话对用户没有意义还会造成困惑。
session_line() {
  screen -ls 2>/dev/null | grep "[.]${SESSION}[[:space:]]" | grep -vE "Dead|dead"
}

case "${1:-start}" in
  status)
    if session_exists; then
      echo "screen 会话 '${SESSION}' 正在运行"
      session_line
      echo
      echo "进去看：screen -r ${SESSION}"
    else
      echo "screen 会话 '${SESSION}' 不存在（服务没在跑）"
    fi
    # 不管 screen 在不在，直接问服务本身
    PORT_VAL="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
    PORT_VAL="${PORT_VAL:-8787}"
    if curl -s -m 3 "http://127.0.0.1:${PORT_VAL}/health" >/dev/null 2>&1; then
      echo "服务健康检查通过（127.0.0.1:${PORT_VAL}）"
    else
      echo "服务健康检查失败（127.0.0.1:${PORT_VAL}）"
    fi
    exit 0
    ;;

  stop)
    if session_exists; then
      # 先送 Ctrl+C 让 node 优雅退出（关数据库、WAL 落盘），再收掉会话。
      # screen -X 的提示信息走的是 stdout 而不是 stderr，所以要一并重定向，
      # 否则用户会看到 "Remove dead screens with 'screen -wipe'." 以为报错了。
      screen -S "${SESSION}" -X stuff $'\003' >/dev/null 2>&1 || true
      sleep 2
      screen -S "${SESSION}" -X quit >/dev/null 2>&1 || true
      screen -wipe >/dev/null 2>&1 || true
      echo "已停止 screen 会话 '${SESSION}'"
    else
      echo "会话 '${SESSION}' 本来就不存在"
    fi
    exit 0
    ;;

  start) ;;  # 继续往下走

  *)
    echo "用法：bash deploy/start-screen.sh [start|stop|status]"
    exit 1
    ;;
esac

# ---------- 启动 ----------

# 上次是被强杀或断电的话，先把墓碑清掉，否则下面会误判「已经在跑」。
reap_orphan_sockets

if session_exists; then
  echo "会话 '${SESSION}' 已经在跑了。"
  echo "  看日志：screen -r ${SESSION}"
  echo "  要重启：bash deploy/start-screen.sh stop && bash deploy/start-screen.sh start"
  exit 0
fi

if [ ! -f .env ]; then
  echo "找不到 .env。先执行：cp .env.example .env 然后填好密钥（见 DEPLOY.md 第 6 步）"
  exit 1
fi

# 守护循环：程序退出就重来，避免一次崩溃导致机器人整天下线。
# 单独写成一个内联脚本喂给 screen，比在 screen 里手敲可靠。
GUARD_CMD="
while true; do
  echo \"[守护] \$(date '+%Y-%m-%d %H:%M:%S') 启动服务…\"
  '${NODE_PATH_REAL}' src/main.ts
  CODE=\$?
  if [ \"\$CODE\" -eq 0 ]; then
    echo \"[守护] 服务正常退出（Ctrl+C 或收到 SIGTERM），不再重启。\"
    break
  fi
  echo \"[守护] 服务异常退出（退出码 \$CODE），5 秒后重启。按 Ctrl+C 可终止守护。\"
  sleep 5
done
echo '[守护] 已停止。按回车关闭这个窗口。'
read -r _
"

# -L 开启 screen 自己的日志（作为兜底），-Logfile 指定位置。
# 老版本 screen 不支持 -Logfile，失败就退回不带该参数的写法。
mkdir -p data
if ! screen -dmS "${SESSION}" -L -Logfile data/screen.log bash -c "${GUARD_CMD}" 2>/dev/null; then
  screen -dmS "${SESSION}" bash -c "${GUARD_CMD}"
fi

sleep 3

if ! session_exists; then
  echo "启动失败：screen 会话没建起来。手动跑一次看报什么错：node src/main.ts"
  exit 1
fi

PORT_VAL="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
PORT_VAL="${PORT_VAL:-8787}"

echo "已在 screen 会话 '${SESSION}' 中启动。"
echo

if curl -s -m 5 "http://127.0.0.1:${PORT_VAL}/health" 2>/dev/null | grep -q '"ok":true'; then
  echo "  健康检查通过：http://127.0.0.1:${PORT_VAL}/health"
else
  echo "  健康检查还没通过。进去看看出了什么事：screen -r ${SESSION}"
fi

cat <<EOF

常用命令：
  screen -r ${SESSION}        进去看实时日志
                              （离开时按 Ctrl+A 再按 D；按 Ctrl+C 会停掉服务）
  tail -f data/arcade-queue.log   不进 screen 直接看日志
  bash deploy/start-screen.sh status   看状态
  bash deploy/start-screen.sh stop     停止

要让服务器重启后自动拉起，执行一次：
  (crontab -l 2>/dev/null; echo "@reboot cd ${PROJECT_DIR} && bash deploy/start-screen.sh start") | crontab -
EOF
