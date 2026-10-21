#!/bin/bash
# 登录钉钉 CLI（会打开浏览器：用钉钉扫码、选公司、点同意）。
#   ./login.sh            用钉钉 CLI 自带的应用登录（推荐，不需要任何凭据）
#   ./login.sh --custom   用公司自建的企业内部应用登录（凭据只存本机 ~/.dsh-meeting-dd/dingtalk.json）
set -eu
F="${DSH_MEETING_DD_CREDS:-${HOME}/.dsh-meeting-dd/dingtalk.json}"
command -v dws >/dev/null || { echo "先安装钉钉 CLI：npm install -g dingtalk-workspace-cli" >&2; exit 1; }
if [ "${1:-}" != "--custom" ]; then unset DWS_CLIENT_ID DWS_CLIENT_SECRET; exec dws auth login "$@"; fi
shift
if [ ! -f "${F}" ]; then
  read -r -p "钉钉应用 Client ID（原 AppKey）: " CID
  read -r -s -p "Client Secret（不回显）: " CSEC; echo
  mkdir -p "$(dirname "${F}")" && chmod 700 "$(dirname "${F}")"
  ( umask 077; CID="${CID}" CSEC="${CSEC}" node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({clientId:process.env.CID,clientSecret:process.env.CSEC},null,2)+"\n",{mode:0o600})' "${F}" )
fi
export DWS_CLIENT_ID="$(node -p 'require(process.argv[1]).clientId' "${F}")"
export DWS_CLIENT_SECRET="$(node -p 'require(process.argv[1]).clientSecret' "${F}")"
exec dws auth login "$@"
