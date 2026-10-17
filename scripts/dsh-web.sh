#!/bin/sh
mkdir -p "$HOME/dsh-diag/reports" 2>/dev/null
# dsh web 服务:启动/重启 (127.0.0.1:3080)。用法: sh scripts/dsh-web.sh [--print-node]
# 环境变量可覆盖: NODE_BIN / DSH_NODE_BIN(指定 node) DSH_NODE_CANDIDATES(冒号分隔候选)
#                 DSH_DIR(dsh 安装目录) PATCH_YML(适配补丁) PORT HOST LOG START_TIMEOUT
# Node 版本：**不锁定版本**。脚本自动探测本机可用的 node（hnp 自带 v24 / deveco 自带 v22 / PATH 里的），
#   按版本从高到低试，先跑一个 `-e` 冒烟（鸿蒙上 node v24 有 V8 code-range 偶发原生崩），
#   选定后起服务；起不来就自动换下一个候选 —— 用户**不需要为了跑 dsh 去降 node 版本**。
#   想知道会选哪个：`sh scripts/dsh-web.sh --print-node`（只探测、不启动、不动在跑的服务）。
# 补丁默认定位仓库内 harmony.patch.yml；日志采用追加+run 头部, 避免每次重启清空导致无法看崩溃现场。
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIR="${DSH_DIR:-$HOME/dsh-test}"
. "$SCRIPT_DIR/node-runtime.sh"
PATCH="${PATCH_YML:-$SCRIPT_DIR/../harmony.patch.yml}"
PORT="${PORT:-3080}"
HOST="${HOST:-127.0.0.1}"
LOG="${LOG:-$HOME/dsh-web.log}"
PIDF="$HOME/dsh-web.pid"
START_TIMEOUT="${START_TIMEOUT:-30}"     # 每个候选运行时的健康检查窗口（秒）
PRINT_ONLY=0
for a in "$@"; do
  case "$a" in
    --print-node|--print-runtime) PRINT_ONLY=1 ;;
    -h|--help) echo "用法: sh scripts/dsh-web.sh [--print-node]"; echo "  环境变量: NODE_BIN/DSH_NODE_BIN(指定 node) DSH_NODE_CANDIDATES(冒号分隔候选)"; echo "            DSH_DIR PATCH_YML PORT HOST LOG START_TIMEOUT"; exit 0 ;;
  esac
done

is_up() {
  /usr/bin/curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null
}

# ——— 运行时解析：公共段在 scripts/node-runtime.sh（各启动脚本共用；Node 24 优先、22 兜底）———
RUNTIME_DIR="$DIR"

if [ "$PRINT_ONLY" -eq 1 ]; then
  node_runtime_detect; _rc=$?
  node_runtime_print
  exit $_rc
fi

# 已经在跑就直接幂等退出 —— 不探测（省掉「v24 崩三次」那点冒烟开销），也不动在跑的服务
if is_up; then
  echo "dsh-web: already running at http://127.0.0.1:$PORT/ (skip)"
  exit 0
fi

node_runtime_detect || { echo "dsh-web: 找不到能跑起来的 node$RUNTIME_LOG"; node_runtime_hint; exit 1; }
NODE="$RUNTIME_NODE"; NODE_VER="$RUNTIME_VER"; NODE_FLAGS="$RUNTIME_FLAGS"; OK_BINS="$RUNTIME_OK_BINS"
echo "dsh-web: 运行时 $NODE (v$NODE_VER)"

# 孤儿锁清理：dsh 的 atomic-write 从不回收孤儿锁（SIGKILL/崩溃退出会留下 .dsh/profiles/*.lock、
# ~/.dsh/.credentials.yaml.lock），不清下次启动即「timed out waiting for the writer lock」。
# 仅在确认本脚本要拉起服务(无 dsh 在跑)时调用，避免误删在跑进程持有的锁。
clear_stale_locks() {
  for lk in "$HOME/.dsh"/profiles/*.lock "$HOME/.dsh"/profiles/*/*.lock "$HOME/.dsh"/.credentials.yaml.lock; do
    [ -e "$lk" ] && rm -f "$lk"
  done
}

cd "$DIR" || { echo "dsh-web: no dir $DIR"; exit 1; }
if [ ! -d "$DIR/node_modules/@deepseek-ai/dsh" ]; then
  echo "dsh-web: dsh not installed at $DIR"
  exit 1
fi
ps -ef 2>/dev/null | grep -F "dsh/lib/bin.js" | grep -v grep \
  | awk '{print $2}' | while read p; do kill "$p" 2>/dev/null; done
sleep 0.3
clear_stale_locks

# 插件市场目录本地镜像（鸿蒙上 node 直连外网 fetch 不可靠，用 curl 下载到本地再走 127.0.0.1 静态服务）
MC_DIR="$HOME/.dsh/market-catalog"
MC_PORT=3988
MC_LOG="$MC_DIR/server.log"
MC_FETCH_LOG="$MC_DIR/fetch.log"
MC_URL="${MC_URL:-https://awesome-dsh-plugin.com/plugins.json}"
mkdir -p "$MC_DIR"

mc_json_ok() {
  "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null
}
_mc_size() { [ -f "$1" ] && wc -c < "$1" | tr -d ' \t' || echo 0; }

# 目录约 6.8MB、本机下行 ~40KB/s：`curl --max-time 25` 必然截断，而 curl 的返回码**仍是 0**
# → 直接 mv 会落地一个非法 JSON，市场静默失效。改为断点续传补齐 + JSON 校验通过才替换；
# .tmp 跨启动保留，续传进度不丢。本地已有合法目录则跳过（否则每次启动都要白等几分钟）。
mc_fetch() {
  _tmp="$MC_DIR/plugins.json.tmp"
  _try=0
  while [ "$_try" -lt 10 ]; do
    _before=$(_mc_size "$_tmp")
    curl -sS -L -C - --max-time 120 -o "$_tmp" "$MC_URL" >/dev/null 2>&1 || true
    _after=$(_mc_size "$_tmp")
    if [ "$_after" -gt 0 ] && mc_json_ok "$_tmp"; then
      mv "$_tmp" "$MC_DIR/plugins.json" && echo "market-catalog: 已更新 ($_after 字节)"
      return 0
    fi
    [ "$_after" -le "$_before" ] && break   # 无进展：网络断或服务端不支持 Range
    _try=$((_try + 1))
  done
  echo "market-catalog: 拉取未完成，保留旧目录（市场暂用旧数据）"
  return 1
}

if command -v curl >/dev/null 2>&1; then
  if mc_json_ok "$MC_DIR/plugins.json"; then
    echo "market-catalog: 本地目录已存在且合法，跳过下载"
  else
    mc_fetch >> "$MC_FETCH_LOG" 2>&1 &   # 后台续传，不拖慢服务启动
  fi
fi
if ! curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$MC_PORT/plugins.json"; then
  # 鸿蒙上没有 python3（原来的 `python3 -m http.server` 从未起来过，server.log 里只有
  # `exec python3: No such file or directory`），改用已探测到的 node 起个最小静态服务。
  pkill -f "dsh/market-catalog $MC_PORT" 2>/dev/null
  nohup "$NODE" -e '
const http = require("http"), fs = require("fs"), path = require("path");
const dir = path.resolve(process.argv[1]), port = Number(process.argv[2]);
http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
  fs.createReadStream(file).on("error", () => res.writeHead(404).end()).pipe(res);
}).listen(port, "127.0.0.1");
' "$MC_DIR" "$MC_PORT" > "$MC_LOG" 2>&1 &
fi
export DSHM_REGISTRY_URL="http://127.0.0.1:$MC_PORT/plugins.json"

# 逐个候选运行时试：起不来（含 node 24 那类偶发原生崩）就自动换下一个，换完还不行才报失败
STARTED=0
for _bin in $OK_BINS; do
  _flags=$(node_flags_for "$_bin")
  _ver=$("$_bin" --version 2>/dev/null | tr -d 'v')
  echo "===== dsh-web start $(date '+%F %T') runtime=$_bin v$_ver =====" >> "$LOG"
  # shellcheck disable=SC2086
  nohup "$_bin" $_flags \
    --report-on-fatalerror --report-uncaught-exception --report-directory="$HOME/dsh-diag/reports" \
    node_modules/@deepseek-ai/dsh/lib/bin.js \
    --profile web --patch "$PATCH" --host "$HOST" --no-open >> "$LOG" 2>&1 &
  _pid=$!
  echo "$_pid" > "$PIDF"

  _n=0
  while [ "$_n" -lt "$START_TIMEOUT" ]; do
    is_up && break
    kill -0 "$_pid" 2>/dev/null || break      # 进程已退出（原生崩/启动报错），别干等
    _n=$((_n + 1)); sleep 1
  done

  if is_up; then
    STARTED=1
    NODE="$_bin"; NODE_VER="$_ver"; NODE_FLAGS="$_flags"
    echo "dsh-web: http://127.0.0.1:$PORT/ (pid $_pid, $NODE v$NODE_VER)"
    break
  fi

  kill "$_pid" 2>/dev/null
  echo "dsh-web: $_bin (v$_ver) 没起来，换下一个候选运行时" >&2
  tail -n 3 "$LOG" >&2
done

if [ "$STARTED" -eq 0 ]; then
  echo "dsh-web: FAILED to start（候选运行时都试过了，见 $LOG）"
  tail -n 5 "$LOG"
  exit 1
fi
