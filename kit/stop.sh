#!/bin/bash
# 停止 start.sh 起的 dsh（DSH_MEETING_DD_PORT=4601 ./stop.sh 停测试用的第二个）
NODE_PORT="${DSH_MEETING_DD_PORT:-4600}"
RUN="${HOME}/.dsh-meeting-dd"; { [ "${NODE_PORT}" = 4600 ] && [ -z "${DSH_MEETING_DD_LOOP:-}" ] && [ -z "${DSH_MEETING_DD_SIM:-}" ]; } || RUN="${HOME}/.dsh-meeting-dd-${NODE_PORT}"
if [ -f "${RUN}/dsh.pid" ] && kill "$(cat "${RUN}/dsh.pid")" 2>/dev/null; then echo "已停止"; else echo "没有在运行"; fi
rm -f "${RUN}/dsh.pid"
