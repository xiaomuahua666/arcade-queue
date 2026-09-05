#!/usr/bin/env bash
# 部署自检脚本：把「群里没反应」这类问题定位到具体某一步。
#
# 用法（在服务器上，项目目录里执行）：
#   bash deploy/doctor.sh
#
# 它只做只读检查，不改任何东西。

set -uo pipefail

PASS=0
FAIL=0
WARN=0

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mX\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; WARN=$((WARN+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "1. 运行环境"

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/^v\([0-9]*\).*/\1/')
  NODE_MINOR=$(echo "$NODE_VER" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -gt 22 ] 2>/dev/null || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; } 2>/dev/null; then
    ok "Node 版本 $NODE_VER"
  else
    bad "Node 版本 $NODE_VER 太低" "需要 22.5+（内置 node:sqlite）。见 DEPLOY.md 第 2 步"
  fi
else
  bad "没装 Node" "见 DEPLOY.md 第 2 步"
fi

if node -e 'require("node:sqlite")' 2>/dev/null; then
  ok "node:sqlite 可用"
else
  bad "node:sqlite 不可用" "Node 版本不够，见 DEPLOY.md 第 2 步"
fi

section "2. 配置文件"

if [ -f .env ]; then
  ok ".env 存在"
  # shellcheck disable=SC1091
  set -a; . ./.env 2>/dev/null || true; set +a

  if [ -n "${CONSOLE_TOKEN:-}" ]; then
    if [ ${#CONSOLE_TOKEN} -ge 16 ]; then
      ok "CONSOLE_TOKEN 已设置（${#CONSOLE_TOKEN} 字符）"
    else
      warn "CONSOLE_TOKEN 只有 ${#CONSOLE_TOKEN} 字符" "公网暴露时容易被猜，建议用 openssl rand -hex 24 换一个"
    fi
  else
    bad "CONSOLE_TOKEN 没设置" "控制台将完全无法登录。见 DEPLOY.md 第 6 步"
  fi

  if [ -n "${ONEBOT_SECRET:-}" ]; then
    ok "ONEBOT_SECRET 已设置（${#ONEBOT_SECRET} 字符）"
  else
    warn "ONEBOT_SECRET 没设置" "任何人都能伪造消息操纵人数。见 DEPLOY.md 第 6 步"
  fi

  PERM=$(stat -c '%a' .env 2>/dev/null || echo '?')
  if [ "$PERM" = "600" ] || [ "$PERM" = "400" ]; then
    ok ".env 权限 $PERM（其他用户不可读）"
  else
    warn ".env 权限是 $PERM" "里面是密码，建议 chmod 600 .env"
  fi
else
  bad ".env 不存在" "执行 cp .env.example .env 后填写。见 DEPLOY.md 第 6 步"
fi

PORT="${PORT:-8787}"

section "3. 本服务状态"

if systemctl is-active --quiet arcade-queue 2>/dev/null; then
  ok "systemd 服务 arcade-queue 正在运行"
elif systemctl list-unit-files 2>/dev/null | grep -q arcade-queue; then
  bad "服务已安装但没在运行" "看原因：journalctl -u arcade-queue -n 50 --no-pager"
else
  warn "还没装成 systemd 服务" "见 DEPLOY.md 第 8 步（手动 node src/main.ts 也能跑，但关终端就停）"
fi

HEALTH=$(curl -s -m 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo '')
if [ "$HEALTH" = '{"ok":true}' ]; then
  ok "健康检查通过（127.0.0.1:${PORT}）"
else
  bad "健康检查失败（127.0.0.1:${PORT}）" "服务没起来或端口不对。看日志：journalctl -u arcade-queue -n 50 --no-pager"
fi

if [ -f "${DB_PATH:-./data/arcade-queue.db}" ]; then
  DB_SIZE=$(du -h "${DB_PATH:-./data/arcade-queue.db}" 2>/dev/null | cut -f1)
  ok "数据库文件存在（$DB_SIZE）"
else
  warn "数据库文件还不存在" "服务首次启动时会自动创建，属正常"
fi

section "4. NapCat 状态"

if command -v docker >/dev/null 2>&1; then
  ok "Docker 已安装"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx napcat; then
    ok "napcat 容器正在运行"

    # 检查 NapCat 的上报配置是否指向本服务
    CFG_DIR=/opt/napcat/config
    if [ -d "$CFG_DIR" ]; then
      MATCHED=$(grep -l "127.0.0.1:${PORT}/onebot" "$CFG_DIR"/onebot11*.json 2>/dev/null | head -1)
      if [ -n "$MATCHED" ]; then
        ok "找到指向本服务的上报配置：$(basename "$MATCHED")"

        if grep -q '"enable"[[:space:]]*:[[:space:]]*true' "$MATCHED"; then
          ok "该上报配置已启用"
        else
          bad "上报配置存在但没启用" "把 enable 改成 true，然后 docker restart napcat"
        fi

        # token 是否与 .env 一致——这是最常见的错误
        if [ -n "${ONEBOT_SECRET:-}" ]; then
          if grep -q "\"token\"[[:space:]]*:[[:space:]]*\"${ONEBOT_SECRET}\"" "$MATCHED"; then
            ok "上报 token 与 .env 的 ONEBOT_SECRET 一致"
          else
            bad "上报 token 与 ONEBOT_SECRET 不一致" "这会导致所有消息被拒（401）。两边必须一字不差，见 DEPLOY.md 第 12 步"
          fi
        fi

        if grep -q '"reportSelfMessage"[[:space:]]*:[[:space:]]*true' "$MATCHED"; then
          warn "reportSelfMessage 是开着的" "机器人会响应自己发的消息，建议关掉"
        else
          ok "reportSelfMessage 已关闭"
        fi
      else
        bad "没找到指向 127.0.0.1:${PORT}/onebot 的上报配置" "见 DEPLOY.md 第 12 步"
      fi
    else
      warn "找不到 NapCat 配置目录 $CFG_DIR" "如果你的挂载路径不同，请手工核对上报配置"
    fi

    # 是否登录了 QQ
    if docker logs napcat 2>&1 | tail -200 | grep -qiE '登录成功|login success|已登录'; then
      ok "QQ 似乎已登录"
    else
      warn "日志里没看到登录成功的记录" "可能已掉线。检查：docker logs napcat --tail 30"
    fi
  else
    bad "napcat 容器没在运行" "启动：docker start napcat（或见 DEPLOY.md 第 10 步）"
  fi
else
  bad "没装 Docker" "见 DEPLOY.md 第 3 步"
fi

section "5. 网络可达性"

if [ "${HOST:-0.0.0.0}" = "0.0.0.0" ]; then
  PUBLIC_IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || echo '')
  if [ -n "$PUBLIC_IP" ]; then
    ok "公网 IP：$PUBLIC_IP → 控制台地址 http://${PUBLIC_IP}:${PORT}/"
    printf '      注意：云服务商的「安全组」也要放通 %s 端口，那是在网页控制台里配的\n' "$PORT"
  else
    warn "拿不到公网 IP" "服务器可能不能出网，Nearcade 与天气功能会不可用"
  fi
else
  ok "HOST=${HOST}（仅本机监听，控制台需用 SSH 隧道访问）"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw status 2>/dev/null | grep -q "${PORT}"; then
    ok "ufw 已放通 ${PORT} 端口"
  else
    warn "ufw 开着但没放通 ${PORT}" "执行：ufw allow ${PORT}/tcp"
  fi
fi

printf '\n\033[1m结果：\033[0m \033[32m%d 项通过\033[0m，\033[33m%d 项提醒\033[0m，\033[31m%d 项失败\033[0m\n' "$PASS" "$WARN" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf '\n先解决上面标 \033[31mX\033[0m 的项。每条后面都写了对应的 DEPLOY.md 步骤。\n'
  exit 1
fi

printf '\n检查通过。去群里发「排卡列表」试试。\n'
printf '还是没反应就实时看日志：journalctl -u arcade-queue -f\n'
