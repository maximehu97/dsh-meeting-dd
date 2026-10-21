#!/bin/bash
# 单独 profile 时用：后台启动 dsh（默认 profile meeting-dd），等节点就绪后打开页面。装进 web profile 的话重启 DSH 网页版即可，不用这个。
#   DSH_MEETING_DD_PORT=4601 ./start.sh   # 同一台电脑再起一个（测试用）：数据 ~/.dsh-meeting-dd-4601
#   DSH_MEETING_DD_LOOP=/tmp/ddloop       # 加上它就用本机假钉钉信箱联调，不联系真人
#   DSH_MEETING_DD_SIM=~/.dsh-meeting-dd-sim DSH_MEETING_DD_LOOP_NAME=刘经理 DSH_MEETING_DD_PORT=4612 ./start.sh
#                                          # 只有一个钉钉账号时：几个节点共用这个账号，消息发到钉钉「我自己」会话里互相协商
set -eu
PROFILE="${DSH_PROFILE:-meeting-dd}"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
NODE_PORT="${DSH_MEETING_DD_PORT:-4600}"

WEB_PORT="${DSH_WEB_PORT:-$((NODE_PORT - 1000))}"
LOOP="${DSH_MEETING_DD_LOOP:-}"
SIM="${DSH_MEETING_DD_SIM:-}"
if [ "${NODE_PORT}" = 4600 ] && [ -z "${LOOP}" ] && [ -z "${SIM}" ]; then RUN="${HOME}/.dsh-meeting-dd"; PATCH=(); else
  RUN="${HOME}/.dsh-meeting-dd-${NODE_PORT}"; mkdir -p "${RUN}"
  node "${DSH_HOME}/profiles/${PROFILE}/node_modules/@maximehu97/dsh-meeting-dd/lib/patch.mjs" --port "${NODE_PORT}" --data-dir "${RUN}" ${LOOP:+--loop-dir "${LOOP}"} ${SIM:+--sim-dir "${SIM}"} --loop-name "${DSH_MEETING_DD_LOOP_NAME:-测试${NODE_PORT}}" > "${RUN}/overlay.yml"
  PATCH=(--patch "${RUN}/overlay.yml")
fi
mkdir -p "${RUN}"
if curl -s -o /dev/null "http://127.0.0.1:${NODE_PORT}/api/state"; then echo "已经在运行：http://127.0.0.1:${NODE_PORT}/"; exit 0; fi
cd "${RUN}"
nohup dsh --profile "${PROFILE}" ${PATCH[@]+"${PATCH[@]}"} "$@" --no-open --port "${WEB_PORT}" > "${RUN}/dsh.log" 2>&1 < /dev/null &
echo $! > "${RUN}/dsh.pid"
echo "dsh 启动中（pid $(cat "${RUN}/dsh.pid")，日志 ${RUN}/dsh.log）"
for i in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:${NODE_PORT}/api/state"; then
    echo "✓ 就绪：http://127.0.0.1:${NODE_PORT}/"
    [ -z "${NO_OPEN:-}" ] && command -v open >/dev/null && open "http://127.0.0.1:${NODE_PORT}/" || true
    exit 0
  fi
  kill -0 "$(cat "${RUN}/dsh.pid")" 2>/dev/null || { echo "✗ dsh 退出了，看日志：${RUN}/dsh.log" >&2; tail -30 "${RUN}/dsh.log" >&2; exit 1; }
  sleep 1
done
echo "✗ 90 秒还没就绪，看日志：${RUN}/dsh.log" >&2; exit 1
