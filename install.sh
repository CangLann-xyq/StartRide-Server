#!/usr/bin/env bash
set -u

APP_NAME="StartRide Relay Server"
APP_ID="start-ride-relay"
DEFAULT_INSTALL_DIR="/opt/start-ride"
DEFAULT_TCP_PORT=7777
DEFAULT_HTTP_PORT=7788
DEFAULT_HOST_GRACE_MS=30000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="$SCRIPT_DIR/payload"

INSTALL_DIR="$DEFAULT_INSTALL_DIR"
TCP_PORT=$DEFAULT_TCP_PORT
HTTP_PORT=$DEFAULT_HTTP_PORT
HOST_GRACE_MS=$DEFAULT_HOST_GRACE_MS

ROOM_NAME="我的联机服务器"
ROOM_MODE="free_drive"
ROOM_MODE_LABEL="自由驾驶"
ROOM_MAP="west_coast_usa"
ROOM_MAP_LABEL="美国西海岸"
ROOM_SPAWN=""
ROOM_SPAWN_LABEL="默认出生点"
ROOM_CAP=8

IS_TTY=1
AUTO=0
[ -t 0 ] && [ -t 1 ] || IS_TTY=0
[ "${1:-}" = "--auto" ] && AUTO=1
command -v tput >/dev/null 2>&1 && COLS=$(tput cols 2>/dev/null || echo 78) || COLS=78
[ "${COLS:-78}" -lt 60 ] 2>/dev/null && COLS=78
W=$((COLS > 90 ? 90 : COLS))

if [ "$IS_TTY" = 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_BLUE=$'\033[38;5;33m'; C_LBLUE=$'\033[38;5;75m'
  C_WHITE=$'\033[97m'; C_GREY=$'\033[38;5;245m'
  C_GREEN=$'\033[38;5;114m'; C_RED=$'\033[38;5;203m'
  C_YEL=$'\033[38;5;179m'; C_BAR=$'\033[38;5;33m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_BLUE=""; C_LBLUE=""; C_WHITE=""
  C_GREY=""; C_GREEN=""; C_RED=""; C_YEL=""; C_BAR=""
fi

draw_hline() {
  local s="" i; for ((i=0;i<$1;i++)); do s+="$2"; done; printf '%s' "$s"
}

ui_clear() { [ "$IS_TTY" = 1 ] && printf '\033[2J\033[H' || true; }

visual_width() {
  local n=$(printf '%s' "$1" | grep -o '[^\x00-\x7F]' 2>/dev/null | wc -l)
  echo $(( ${#1} + n ))
}

ui_header() {
  ui_clear
  local title="  StartRide 联机服务器安装器  "
  local vw=$(visual_width "$title")
  local rest=$(( W - 2 - vw - 2 ))
  [ $rest -lt 4 ] && rest=4
  printf '\n'
  printf '%b  ╔%s%s%s╗%b\n' "$C_BLUE" "$(draw_hline 2 '═')" "$title" "$(draw_hline $rest '═')" "$C_RESET"
  printf '\n'
}

ui_section() {
  printf '%b ▌%b %b%s%b\n' "$C_BAR" "$C_RESET" "$C_WHITE$C_BOLD" "$1" "$C_RESET"
}

ui_kv() {
  printf '   %b%-26s%b %b%s%b\n' "$C_GREY" "$1" "$C_RESET" "${3:-$C_LBLUE}" "$2" "$C_RESET"
}

ui_ok()   { printf '   %b[ ✓ ]%b %s\n' "$C_GREEN" "$C_RESET" "$1"; }
ui_fail() { printf '   %b[ ✗ ]%b %s\n' "$C_RED" "$C_RESET" "$1"; }
ui_warn() { printf '   %b[ ! ]%b %s\n' "$C_YEL" "$C_RESET" "$1"; }
ui_info() { printf '   %b· %s%b\n' "$C_GREY" "$1" "$C_RESET"; }
ui_line() { printf '%b  %s%b\n' "$C_GREY" "$(draw_hline $((W-4)) '·')" "$C_RESET"; }

ui_wait() {
  [ "$IS_TTY" = 1 ] && [ "$AUTO" = 0 ] && { printf '\n%b按回车继续...%b' "$C_DIM" "$C_RESET"; read -r _; printf '\n'; }
  return 0
}

progress() {
  local cur=$1 total=$2 label=$3
  local bw=$((W-30)); [ $bw -lt 20 ] && bw=20
  local filled=$(( cur * bw / total )); [ $filled -gt $bw ] && filled=$bw
  local bar="" rest="" i
  for ((i=0;i<filled;i++)); do bar+="━"; done
  for ((i=filled;i<bw;i++)); do rest+="╌"; done
  printf '\r\033[2K   %b%s%s%b %3d%%  %b%s%b' "$C_BAR" "$bar" "$rest" "$C_RESET" \
    $(( cur * 100 / total )) "$C_GREY" "$label" "$C_RESET"
  [ "$cur" -ge "$total" ] && printf '\n'
  return 0
}

menu_pick() {
  local title="$1"; shift
  local opts=("$@") sel=0 i n=${#opts[@]}
  if [ "$IS_TTY" = 0 ] || [ "$AUTO" = 1 ]; then MENU_RET=1; return 0; fi
  while true; do
    ui_section "$title"
    for ((i=0;i<n;i++)); do
      if [ $i -eq $sel ]; then
        printf '   %b❯ %s%b\n' "$C_BLUE$C_BOLD" "${opts[$i]}" "$C_RESET"
      else
        printf '     %b%s%b\n' "$C_GREY" "${opts[$i]}" "$C_RESET"
      fi
    done
    printf '   %b[↑/↓ 选择 · 回车确认]%b' "$C_DIM" "$C_RESET"
    local k; read -rsn1 k || { MENU_RET=1; return 0; }
    if [ "$k" = $'\x1b' ]; then
      read -rsn2 k
      case "$k" in
        '[A') (( sel-- )); [ $sel -lt 0 ] && sel=$((n-1)) ;;
        '[B') (( sel++ )); [ $sel -ge $n ] && sel=0 ;;
      esac
    elif [ "$k" = "" ]; then
      MENU_RET=$((sel+1)); printf '\n'; return 0
    fi
    printf '\033[%dA\033[J' $((n+2))
  done
}

ask() {
  local label="$1" def="${2:-}" in
  if [ "$AUTO" = 1 ]; then ASK_RET="$def"; return 0; fi
  if [ "$IS_TTY" = 0 ]; then
    printf '   %s [%s]: ' "$label" "$def"
    read -r in || in=""
    ASK_RET="${in:-$def}"; return 0
  fi
  printf '   %b%s%b %b[%s]%b: ' "$C_WHITE" "$label" "$C_RESET" "$C_DIM" "$def" "$C_RESET"
  read -r in || in=""
  ASK_RET="${in:-$def}"
  printf '\n'
}

DISTRO="未知"; PKG=""; ARCH="$(uname -m 2>/dev/null || echo x86_64)"
HAS_SYSTEMD=0; HAS_NODE=0; NODE_VER=""; PORT_TCP_FREE=1; PORT_HTTP_FREE=1
HAS_XZ=1; HAS_CURL=1
PUBLIC_IP=""
NIC_NAMES=(); NIC_IPS=(); NIC_COUNT=0
CPU_MODEL="?"
CPU_CORES="?"
MEM_TOTAL="?"
DISK_FREE="?"

detect_hardware() {
  if command -v lscpu >/dev/null 2>&1; then
    CPU_MODEL="$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -1)"
  fi
  [ -z "$CPU_MODEL" ] && CPU_MODEL="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //')"
  [ -z "$CPU_MODEL" ] && CPU_MODEL="未知"
  CPU_CORES="$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo '?')"
  if [ -r /proc/meminfo ]; then
    local kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
    MEM_TOTAL="$(( kb / 1024 / 1024 )).$(( (kb / 1024 % 1024) * 10 / 1024 )) GB"
  fi
  DISK_FREE="$(df -h "$DEFAULT_INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
  [ -z "$DISK_FREE" ] && DISK_FREE="?"
}

detect_nics() {
  NIC_NAMES=(); NIC_IPS=(); NIC_COUNT=0
  if command -v ip >/dev/null 2>&1; then
    while read -r ifname ipaddr; do
      [ "$ipaddr" = "127.0.0.1" ] && continue
      NIC_NAMES+=("$ifname"); NIC_IPS+=("$ipaddr"); NIC_COUNT=$((NIC_COUNT+1))
    done < <(ip -o -4 addr show 2>/dev/null | awk '{print $2, $4}' | awk -F/ '{print $1, $2}')
  elif command -v ifconfig >/dev/null 2>&1; then
    local cur=""
    while read -r line; do
      case "$line" in
        *[0-9]:*|*[a-z0-9]:*) cur="$(printf '%s' "$line" | sed 's/:.*//;s/^ *//')" ;;
        *"inet "*)
          local a="$(printf '%s' "$line" | awk '{print $2}')"
          [ "$a" = "127.0.0.1" ] && continue
          [ -n "$cur" ] && { NIC_NAMES+=("$cur"); NIC_IPS+=("$a"); NIC_COUNT=$((NIC_COUNT+1)); } ;;
      esac
    done < <(ifconfig 2>/dev/null)
  fi
}

detect_env() {
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    DISTRO="${PRETTY_NAME:-${NAME:-未知}}"
  fi
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && HAS_SYSTEMD=1
  command -v node >/dev/null 2>&1 && { HAS_NODE=1; NODE_VER="$(node -v 2>/dev/null || echo ?)"; }
  command -v xz >/dev/null 2>&1 || HAS_XZ=0
  command -v curl >/dev/null 2>&1 || HAS_CURL=0
  case "$DISTRO" in
    *Ubuntu*|*Debian*|*Deepin*|*UOS*) PKG="apt" ;;
    *CentOS*|*RHEL*|*Red\ Hat*|*Rocky*|*Alma*|*Alibaba*|*Anolis*|*Fedora*|*openEuler*) PKG="dnf"; command -v dnf >/dev/null 2>&1 || PKG="yum" ;;
    *Arch*) PKG="pacman" ;;
    *) PKG="" ;;
  esac
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:.]$DEFAULT_TCP_PORT$" >/dev/null && PORT_TCP_FREE=0
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:.]$DEFAULT_HTTP_PORT$" >/dev/null && PORT_HTTP_FREE=0
  fi
  if [ "$HAS_CURL" = 1 ]; then
    PUBLIC_IP="$(curl -4 -s --max-time 3 https://ip.3322.net 2>/dev/null || true)"
    [ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(curl -4 -s --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    PUBLIC_IP="$(printf '%s' "$PUBLIC_IP" | tr -d '[:space:]')"
  fi
  detect_hardware
  detect_nics
  [ -z "$PUBLIC_IP" ] && [ "$NIC_COUNT" -gt 0 ] && PUBLIC_IP="${NIC_IPS[0]}"
  [ -z "$PUBLIC_IP" ] && PUBLIC_IP="<服务器IP>"
}

show_env_page() {
  ui_header
  ui_section "环境检测"
  ui_kv "操作系统" "$DISTRO"
  ui_kv "处理器架构" "$ARCH"
  if [ "$(id -u)" = 0 ]; then ui_ok "root 权限"; else ui_fail "需要 root（请用 sudo bash install.sh 重新运行）"; fi
  if [ "$HAS_SYSTEMD" = 1 ]; then ui_ok "systemd 可用（开机自启 + 崩溃自动拉起）"
  else ui_warn "未检测到 systemd，将退化为 nohup 后台运行"; fi
  if [ "$ARCH" = "x86_64" ]; then
    ui_ok "使用安装包内置 Node.js v22（离线可用）"
  elif [ "$HAS_NODE" = 1 ]; then
    ui_ok "使用系统 Node.js $NODE_VER"
  else
    ui_warn "非 x86_64 且无系统 Node.js，将尝试用 $PKG 安装 nodejs"
  fi
  if [ "$HAS_XZ" = 1 ]; then ui_ok "解压工具 (tar+xz)"
  else ui_warn "缺少 xz，安装时会尝试用 $PKG 补装 xz-utils"; fi
  if [ "$PORT_TCP_FREE" = 1 ]; then ui_ok "端口 $DEFAULT_TCP_PORT (游戏数据) 空闲"
  else ui_fail "端口 $DEFAULT_TCP_PORT 已被占用，安装时需改端口"; fi
  if [ "$PORT_HTTP_FREE" = 1 ]; then ui_ok "端口 $DEFAULT_HTTP_PORT (WebSocket/公告板) 空闲"
  else ui_fail "端口 $DEFAULT_HTTP_PORT 已被占用，安装时需改端口"; fi
  ui_line
  ui_section "硬件概览"
  ui_kv "处理器" "$CPU_MODEL (${CPU_CORES} 核)"
  ui_kv "内存" "$MEM_TOTAL"
  ui_kv "安装目录可用空间" "$DISK_FREE"
  ui_line
  ui_section "网卡 / 地址"
  local i
  if [ "$NIC_COUNT" -gt 0 ]; then
    for ((i=0;i<NIC_COUNT;i++)); do
      ui_kv "${NIC_NAMES[$i]}" "${NIC_IPS[$i]}"
    done
  else
    ui_warn "未识别到网卡，稍后请手动输入地址"
  fi
  ui_kv "公网出口地址" "$PUBLIC_IP"
  ui_line
  ui_wait
}

pick_nic() {
  ui_header
  if [ "$NIC_COUNT" -eq 0 ]; then
    ask "未识别到网卡，请手动输入服务器地址" "$PUBLIC_IP"
    PUBLIC_IP="$ASK_RET"
    return
  fi
  local opts=() i
  for ((i=0;i<NIC_COUNT;i++)); do
    opts+=("${NIC_NAMES[$i]}  →  ${NIC_IPS[$i]}")
  done
  opts+=("手动输入地址")
  local pick=1
  if [ "$AUTO" = 0 ] && [ "$IS_TTY" = 1 ]; then
    menu_pick "选择对外网卡（大厅地址用它，云服一般选公网网卡或用出口地址）" "${opts[@]}"
    pick=$MENU_RET
    printf '\n'
  fi
  if [ "$pick" -le "$NIC_COUNT" ]; then
    PUBLIC_IP="${NIC_IPS[$((pick-1))]}"
  else
    ask "手动输入服务器地址（IP 或域名）" "$PUBLIC_IP"
    PUBLIC_IP="$ASK_RET"
  fi
}

MODE_IDS=(free_drive hide_seek cops_robber derby track_day)
MODE_LABELS=("自由驾驶 · 没有规则想去哪去哪" "捉迷藏 · 一人抓其他人藏" "警察抓强盗 · 分队追捕逃逸" "德比 · 场内互撞最后站着赢" "赛道日 · 刷圈速比谁快")
MAP_IDS=(west_coast_usa east_coast_usa utah italy johnson_valley small_island gridmap automation_test_track)
MAP_LABELS=("美国西海岸 (west_coast_usa)" "美国东海岸 (east_coast_usa)" "美国犹他 (utah)" "意大利 (italy)" "约翰逊谷越野 (johnson_valley)" "小岛 (small_island)" "网格地图 (gridmap)" "自动化赛道 (automation_test_track)")

show_room_wizard() {
  ui_header
  ui_section "建房向导（大厅里常驻展示的房间档）"
  ui_info "像客户端建房一样定好模式、地图、出生点、人数；"
  ui_info "装好后玩家一打开大厅就能看到这个房间，人数上限也会在服务端封顶。"
  printf '\n'
  ask "服务器名称" "$ROOM_NAME"; ROOM_NAME="$ASK_RET"

  local pick=1
  if [ "$AUTO" = 0 ] && [ "$IS_TTY" = 1 ]; then
    menu_pick "玩法模式" "${MODE_LABELS[@]}"
    pick=$MENU_RET
    printf '\n'
    ROOM_MODE="${MODE_IDS[$((pick-1))]}"
    ROOM_MODE_LABEL="$(printf '%s' "${MODE_LABELS[$((pick-1))]}" | cut -d' ' -f1)"
    menu_pick "地图" "${MAP_LABELS[@]}"
    pick=$MENU_RET
    printf '\n'
  fi
  if [ "$pick" -le "${#MAP_IDS[@]}" ]; then
    ROOM_MAP="${MAP_IDS[$((pick-1))]}"
    ROOM_MAP_LABEL="${MAP_LABELS[$((pick-1))]}"
  else
    ask "地图 id（BeamNG 关卡目录名）" "$ROOM_MAP"
    ROOM_MAP="$ASK_RET"; ROOM_MAP_LABEL="$ASK_RET (手输)"
  fi

  ask "出生点（scenetree 对象名，留空 = 地图默认出生点）" "$ROOM_SPAWN"
  ROOM_SPAWN="$ASK_RET"
  if [ -n "$ROOM_SPAWN" ]; then ROOM_SPAWN_LABEL="$ROOM_SPAWN"; else ROOM_SPAWN_LABEL="默认出生点"; fi
  ask "人数上限 (2-16)" "$ROOM_CAP"
  case "$ASK_RET" in
    ''|*[!0-9]*) ROOM_CAP=8 ;;
    *) ROOM_CAP="$ASK_RET" ;;
  esac
  [ "$ROOM_CAP" -lt 2 ] 2>/dev/null && ROOM_CAP=2
  [ "$ROOM_CAP" -gt 16 ] 2>/dev/null && ROOM_CAP=16
}

show_config_page() {
  ui_header
  ui_section "基础配置（直接回车 = 使用默认值）"
  [ "$PORT_TCP_FREE" = 0 ] && ui_warn "7777 被占用，请改用其它端口"
  [ "$PORT_HTTP_FREE" = 0 ] && ui_warn "7788 被占用，请改用其它端口"
  printf '\n'
  ask "游戏数据直连端口 (TCP)" "$TCP_PORT"; TCP_PORT="$ASK_RET"
  ask "WebSocket/公告板端口" "$HTTP_PORT"; HTTP_PORT="$ASK_RET"
  ask "房主掉线宽限（毫秒，超时自动关房）" "$HOST_GRACE_MS"; HOST_GRACE_MS="$ASK_RET"
  ask "安装目录" "$INSTALL_DIR"; INSTALL_DIR="$ASK_RET"

  case "$TCP_PORT$HTTP_PORT" in
    *[!0-9]*) ui_fail "端口必须是数字"; ui_wait; show_config_page; return ;;
  esac
  case "$HOST_GRACE_MS" in
    ''|*[!0-9]*) HOST_GRACE_MS=$DEFAULT_HOST_GRACE_MS ;;
  esac
  if [ "$TCP_PORT" = "$HTTP_PORT" ]; then
    ui_fail "两个端口不能相同"; ui_wait; show_config_page; return
  fi
}

show_confirm_page() {
  ui_header
  ui_section "确认安装"
  ui_kv "网卡 / 对外地址" "$PUBLIC_IP"
  ui_kv "安装目录" "$INSTALL_DIR"
  ui_kv "游戏数据端口 (TCP)" "$TCP_PORT"
  ui_kv "WebSocket 端口" "$HTTP_PORT"
  ui_kv "房主掉线宽限" "${HOST_GRACE_MS} ms"
  ui_kv "进程管理" "$([ "$HAS_SYSTEMD" = 1 ] && echo "systemd ($APP_ID.service)" || echo "nohup")"
  ui_kv "防火墙放行" "TCP $TCP_PORT + TCP $HTTP_PORT（尽力自动放行）"
  printf '\n'
  ui_section "建房档"
  ui_kv "服务器名称" "$ROOM_NAME"
  ui_kv "玩法模式" "$ROOM_MODE_LABEL ($ROOM_MODE)"
  ui_kv "地图" "$ROOM_MAP_LABEL"
  ui_kv "出生点" "$ROOM_SPAWN_LABEL"
  ui_kv "人数上限" "$ROOM_CAP"
  printf '\n'
  ui_line
  local pick=1
  if [ "$AUTO" = 0 ] && [ "$IS_TTY" = 1 ]; then
    menu_pick "开始安装吗？" "开始安装" "重新配置" "退出"
    pick=$MENU_RET
    printf '\n'
  fi
  case $pick in
    1) return 0 ;;
    2) pick_nic; show_config_page; show_room_wizard; show_confirm_page ;;
    *) exit 0 ;;
  esac
}

FIREWALL_NOTE=""

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$TCP_PORT/tcp" >/dev/null 2>&1 && ufw allow "$HTTP_PORT/tcp" >/dev/null 2>&1 \
      && FIREWALL_NOTE="ufw 已放行 $TCP_PORT/$HTTP_PORT"; return
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$TCP_PORT/tcp" >/dev/null 2>&1
    firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1 \
      && FIREWALL_NOTE="firewalld 已放行 $TCP_PORT/$HTTP_PORT"; return
  fi
  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "$TCP_PORT" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT -p tcp --dport "$TCP_PORT" -j ACCEPT 2>/dev/null
    iptables -C INPUT -p tcp --dport "$HTTP_PORT" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT -p tcp --dport "$HTTP_PORT" -j ACCEPT 2>/dev/null
    FIREWALL_NOTE="iptables 已放行（重启后如失效请自行持久化）"; return
  fi
  FIREWALL_NOTE="未发现防火墙工具，请确认云安全组已放行"
}

INSTALL_HEALTH=""

write_room_profile() {
  local spawn_json='""'
  [ -n "$ROOM_SPAWN" ] && spawn_json="\"$ROOM_SPAWN\""
  cat > /etc/start-ride/room.json <<EOF
{
  "roomId": "SERVER",
  "name": "$ROOM_NAME",
  "gameMode": "$ROOM_MODE",
  "map": "$ROOM_MAP",
  "spawn": $spawn_json,
  "capacity": $ROOM_CAP,
  "hostName": "服务器"
}
EOF
}

do_install() {
  local STEP=0 TOTAL=10
  ui_header
  ui_section "正在安装"

  progress $((++STEP)) $TOTAL "准备工作"
  mkdir -p "$INSTALL_DIR" /etc/start-ride
  if [ "$ARCH" = "x86_64" ] && [ "$HAS_XZ" = 0 ]; then
    case "$PKG" in
      apt) DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils >/dev/null 2>&1 || true ;;
      dnf|yum) "$PKG" install -y xz >/dev/null 2>&1 || true ;;
      pacman) pacman -Sy --noconfirm xz >/dev/null 2>&1 || true ;;
    esac
  fi

  progress $((++STEP)) $TOTAL "复制中继服务"
  if [ ! -f "$PAYLOAD_DIR/relay-server.js" ]; then
    ui_fail "找不到 payload/relay-server.js —— 请把整个安装目录完整拷贝过来"
    exit 1
  fi
  cp -f "$PAYLOAD_DIR/relay-server.js" "$INSTALL_DIR/relay-server.js"

  progress $((++STEP)) $TOTAL "准备 Node.js 运行时"
  local NODE_BIN=""
  if [ "$ARCH" = "x86_64" ]; then
    local tarball="$(ls "$PAYLOAD_DIR"/node-v*-linux-x64.tar.xz 2>/dev/null | head -1)"
    if [ -n "$tarball" ] && tar -tf "$tarball" >/dev/null 2>&1; then
      rm -rf "$INSTALL_DIR/node"
      tar -xJf "$tarball" -C "$INSTALL_DIR" || true
      local topdir="$(basename "$tarball" .tar.xz)"
      [ -d "$INSTALL_DIR/$topdir" ] && mv "$INSTALL_DIR/$topdir" "$INSTALL_DIR/node"
      NODE_BIN="$INSTALL_DIR/node/bin/node"
    fi
  fi
  if [ -z "$NODE_BIN" ]; then
    if [ "$HAS_NODE" = 1 ]; then
      NODE_BIN="$(command -v node)"
    else
      case "$PKG" in
        apt) DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null 2>&1 || true ;;
        dnf|yum) "$PKG" install -y nodejs >/dev/null 2>&1 || true ;;
        pacman) pacman -Sy --noconfirm nodejs >/dev/null 2>&1 || true ;;
      esac
      command -v node >/dev/null 2>&1 && NODE_BIN="$(command -v node)"
    fi
  fi
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    ui_fail "没有可用的 Node.js 运行时（内置包仅支持 x86_64）"; exit 1
  fi

  progress $((++STEP)) $TOTAL "写入配置与建房档"
  cat > /etc/start-ride/relay.env <<EOF
PORT=$TCP_PORT
HTTP_PORT=$HTTP_PORT
SR_HTTP_HOST=0.0.0.0
SR_HOST_GRACE_MS=$HOST_GRACE_MS
SR_ROOM_CONFIG=/etc/start-ride/room.json
EOF
  SR_PUBLIC_URL=""
  case "$PUBLIC_IP" in
    *"<"*) : ;;
    *) SR_PUBLIC_URL="http://$PUBLIC_IP:$HTTP_PORT" ;;
  esac
  if [ -n "$SR_PUBLIC_URL" ] && [ "$HAS_SYSTEMD" = 1 ]; then
    echo "SR_PUBLIC_URL=$SR_PUBLIC_URL" >> /etc/start-ride/relay.env
  fi
  write_room_profile

  progress $((++STEP)) $TOTAL "停止旧实例"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    systemctl stop "$APP_ID" >/dev/null 2>&1 || true
  else
    pkill -f "$INSTALL_DIR/relay-server.js" 2>/dev/null || true
  fi
  sleep 1

  progress $((++STEP)) $TOTAL "注册系统服务"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    cat > /etc/systemd/system/$APP_ID.service <<EOF
[Unit]
Description=$APP_NAME
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=/etc/start-ride/relay.env
ExecStart=$NODE_BIN $INSTALL_DIR/relay-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$APP_ID" >/dev/null 2>&1
  else
    cat > "$INSTALL_DIR/start.sh" <<EOF
#!/usr/bin/env bash
SR_ROOM_CONFIG=/etc/start-ride/room.json SR_PUBLIC_URL=$SR_PUBLIC_URL nohup $NODE_BIN $INSTALL_DIR/relay-server.js >> $INSTALL_DIR/relay.log 2>&1 &
EOF
    chmod +x "$INSTALL_DIR/start.sh"
  fi

  progress $((++STEP)) $TOTAL "放行防火墙端口"
  open_firewall

  progress $((++STEP)) $TOTAL "启动服务"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    systemctl restart "$APP_ID"
  else
    "$INSTALL_DIR/start.sh"
  fi
  sleep 2

  progress $((++STEP)) $TOTAL "健康检查"
  local HEALTH="" i
  for i in 1 2 3 4 5; do
    if [ "$HAS_CURL" = 1 ]; then
      HEALTH="$(curl -s --max-time 3 "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null || true)"
    else
      HEALTH="$("$NODE_BIN" -e "fetch('http://127.0.0.1:$HTTP_PORT/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>{})" 2>/dev/null || true)"
    fi
    case "$HEALTH" in *'"ok":true'*) break ;; esac
    sleep 1
  done
  INSTALL_HEALTH="$HEALTH"

  progress $((++STEP)) $TOTAL "核对建房档"
  local BOARD=""
  if [ "$HAS_CURL" = 1 ]; then
    BOARD="$(curl -s --max-time 3 "http://127.0.0.1:$HTTP_PORT/api/startride/rooms" 2>/dev/null || true)"
  fi
  case "$BOARD" in
    *'"persistent":true'*) BOARD_OK=1 ;;
    *) BOARD_OK=0; sleep 2 ;;
  esac
}

BOARD_OK=0

show_result_page() {
  local relay_ver="?" rooms="0"
  case "$INSTALL_HEALTH" in
    *'"version":"'*) relay_ver="$(printf '%s' "$INSTALL_HEALTH" | sed 's/.*"version":"\([^"]*\)".*/\1/')" ;;
  esac
  case "$INSTALL_HEALTH" in
    *'"rooms":'*) rooms="$(printf '%s' "$INSTALL_HEALTH" | sed 's/.*"rooms":\([0-9]*\).*/\1/')" ;;
  esac

  ui_header
  ui_section "安装完成"
  if [ -n "$INSTALL_HEALTH" ]; then
    ui_ok "中继服务已在后台运行（版本 $relay_ver · 房间 $rooms）"
  else
    ui_warn "服务已启动但健康检查未返回，请稍后执行: curl http://127.0.0.1:$HTTP_PORT/health"
  fi
  if [ "$BOARD_OK" = 1 ]; then
    ui_ok "建房档已生效，大厅列表常驻房间「$ROOM_NAME」"
  else
    ui_warn "建房档尚未核对成功，请稍后执行: curl http://127.0.0.1:$HTTP_PORT/api/startride/rooms"
  fi
  [ -n "$FIREWALL_NOTE" ] && ui_info "$FIREWALL_NOTE"
  printf '\n'
  ui_section "在 Windows 启动器里这样填（设置 → 联机延迟）"
  printf '\n'
  ui_kv "中继服务器地址" "$PUBLIC_IP" "$C_GREEN$C_BOLD"
  ui_kv "直连端口（TCP）" "$TCP_PORT" "$C_GREEN$C_BOLD"
  ui_kv "WebSocket 端口" "$HTTP_PORT" "$C_GREEN$C_BOLD"
  ui_kv "WebSocket 路径" "/relay-ws" "$C_GREEN$C_BOLD"
  printf '\n'
  ui_line
  ui_info "填好后用「测试延迟」验证，随后建房 / 直接加入大厅里的「$ROOM_NAME」。"
  ui_warn "云服务器还需在控制台安全组放行 TCP $TCP_PORT 和 $HTTP_PORT。"
  ui_line
  printf '\n'
  ui_section "服务管理"
  ui_info "状态:  systemctl status $APP_ID"
  ui_info "重启:  systemctl restart $APP_ID"
  ui_info "日志:  journalctl -u $APP_ID -f"
  ui_info "卸载:  bash $SCRIPT_DIR/install.sh（菜单选卸载）"

  SUMMARY_FILE="$INSTALL_DIR/INSTALL-SUMMARY.txt"
  cat > "$SUMMARY_FILE" <<EOF
StartRide 联机服务器 · 安装摘要（$(date '+%Y-%m-%d %H:%M')）
=============================================================
网卡 / 对外地址  = $PUBLIC_IP
直连端口（TCP）  = $TCP_PORT
WebSocket 端口   = $HTTP_PORT
WebSocket 路径   = /relay-ws

建房档（大厅常驻房间）
  服务器名称 = $ROOM_NAME
  玩法模式   = $ROOM_MODE_LABEL ($ROOM_MODE)
  地图       = $ROOM_MAP_LABEL
  出生点     = $ROOM_SPAWN_LABEL
  人数上限   = $ROOM_CAP

Windows 启动器：设置 → 联机延迟 → 填上面四项 → 测试延迟。
云服务器请在安全组放行 TCP $TCP_PORT 与 TCP $HTTP_PORT。

服务管理:
  systemctl status/restart $APP_ID
  journalctl -u $APP_ID -f
建房档位置:
  /etc/start-ride/room.json（改完 systemctl restart $APP_ID）
卸载:
  bash $SCRIPT_DIR/install.sh（菜单选卸载）
EOF
  ui_line
  ui_info "本摘要已保存: $SUMMARY_FILE"
  ui_wait
}

do_uninstall() {
  ui_header
  ui_section "卸载 StartRide 联机服务器"
  printf '\n'
  if [ "$HAS_SYSTEMD" = 1 ]; then
    systemctl disable --now "$APP_ID" >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/$APP_ID.service
    systemctl daemon-reload
    ui_ok "systemd 服务已停止并移除"
  else
    pkill -f "$INSTALL_DIR/relay-server.js" 2>/dev/null || true
    ui_ok "后台进程已结束"
  fi
  rm -rf "$INSTALL_DIR" /etc/start-ride
  ui_ok "已删除 $INSTALL_DIR 与 /etc/start-ride（含建房档）"
  ui_info "防火墙放行规则与云安全组请按需自行回收"
  printf '\n'
}

do_status() {
  echo "== $APP_NAME =="
  if [ "$HAS_SYSTEMD" = 1 ] && systemctl is-active "$APP_ID" >/dev/null 2>&1; then
    echo "服务状态: 运行中"
    systemctl --no-pager -l status "$APP_ID" | head -6
  else
    echo "服务状态: 未运行"
  fi
  if [ -r /etc/start-ride/relay.env ]; then
    . /etc/start-ride/relay.env
  fi
  if [ "$HAS_CURL" = 1 ]; then
    echo "健康检查: $(curl -s --max-time 3 "http://127.0.0.1:${HTTP_PORT:-7788}/health" || echo 无响应)"
    echo "建房档:   $(curl -s --max-time 3 "http://127.0.0.1:${HTTP_PORT:-7788}/api/startride/rooms" || echo 无响应)"
  fi
  [ -f /opt/start-ride/INSTALL-SUMMARY.txt ] && echo "--- 安装摘要 ---" && cat /opt/start-ride/INSTALL-SUMMARY.txt
}

main_menu() {
  ui_header
  ui_section "主菜单"
  printf '\n'
  local pick=1
  if [ "$AUTO" = 0 ] && [ "$IS_TTY" = 1 ]; then
    menu_pick "要做什么？" "全新安装 / 升级" "卸载" "查看运行状态" "退出"
    pick=$MENU_RET
    printf '\n'
  fi
  case $pick in
    1)
      show_env_page; pick_nic; show_config_page; show_room_wizard; show_confirm_page
      do_install; show_result_page
      printf '\n%b完成，祝联机愉快。%b\n\n' "$C_GREEN" "$C_RESET" ;;
    2) do_uninstall ;;
    3) do_status; printf '\n' ;;
    *) exit 0 ;;
  esac
}

case "${1:-}" in
  --uninstall)
    [ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }
    detect_env; do_uninstall; exit 0 ;;
  --status)
    detect_env; do_status; exit 0 ;;
esac

[ "$(id -u)" = 0 ] || { echo "需要 root 权限：sudo bash install.sh"; exit 1; }
[ -f "$PAYLOAD_DIR/relay-server.js" ] || { echo "找不到 payload/relay-server.js，请完整拷贝安装目录"; exit 1; }

detect_env
main_menu
