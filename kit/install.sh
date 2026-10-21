#!/bin/bash
# dsh-meeting-DD 安装：把插件装进一个 dsh profile（默认 web，也就是 DSH 网页版），侧栏会多一个「约会议·钉钉」按钮。
#   DSH_PROFILE=web ./install.sh          # 装进已有的 DSH 网页版（默认）
#   DSH_PROFILE=meeting-dd ./install.sh   # 或者单独建一个 profile，用 ./start.sh 启动
# 登录钉钉默认用钉钉 CLI 自带的应用，扫码即可。公司要求用自建应用时，可以安装时给凭据（只写进本机 ~/.dsh-meeting-dd/dingtalk.json，权限 600）：
#   DINGTALK_CLIENT_ID=ding... DINGTALK_CLIENT_SECRET=... ./install.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
DIR="${DSH_HOME}/profiles/${PROFILE}"
TGZ="__TGZ__"
PKG="@maximehu97/dsh-meeting-dd"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
case "${PROFILE}" in *[!a-zA-Z0-9_-]*|"") die "DSH_PROFILE 只能是字母数字";; esac

command -v node >/dev/null || die "没有 node：先装 Node.js 22 或更新版本（https://nodejs.org）"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)' || die "Node.js 版本太旧（$(node -v)），需要 20.19 / 22.12 或更新"
command -v pnpm >/dev/null || { say "安装 pnpm（dsh 用它装插件）"; npm install -g pnpm; }
command -v dsh >/dev/null || { say "安装 DeepSeek Harness CLI"; npm install -g @deepseek-ai/dsh; }
command -v dws >/dev/null || { say "安装钉钉 CLI（DingTalk Workspace CLI）"; npm install -g dingtalk-workspace-cli; }
say "dsh $(dsh --version 2>/dev/null | head -1)  dws $(dws --version 2>/dev/null | head -1 | awk '{print $3}')  node $(node -v)"

mkdir -p "${DSH_HOME}/data/dsh-meeting-dd"
cp "${HERE}/${TGZ}" "${DSH_HOME}/data/dsh-meeting-dd/${TGZ}"
if [ ! -f "${DIR}/package.json" ]; then
  say "新建 profile ${PROFILE}（${DIR}）"
  mkdir -p "${DIR}"
  cat > "${DIR}/package.json" <<JSON
{
  "name": "dsh-profile-${PROFILE}",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
JSON
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "${DIR}/pnpm-workspace.yaml"
  # 新 profile 的配置层：模型用本机 dsh 登录的 DeepSeek 账号，会话 / 存储和别的 profile 分开。想用 API Key 就改 provider。
  cat > "${DIR}/cordis.patch.yml" <<'YML'
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('dsh-meeting-dd-sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('dsh-meeting-dd-storages')
YML
fi

say "安装插件 ${TGZ}（依赖已打包在里面）"
if [ -d "${DIR}/node_modules/${PKG}" ]; then dsh plugin --profile "${PROFILE}" remove "${PKG}" < /dev/null >/dev/null || true; fi
dsh plugin --profile "${PROFILE}" add --prefer-offline "file:${DSH_HOME}/data/dsh-meeting-dd/${TGZ}" < /dev/null
node -e '
const fs=require("fs"),f=process.argv[1],p=process.argv[2],j=JSON.parse(fs.readFileSync(f,"utf8"));
const b=((j.dsh??={}).profile??={}).bundles??=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"];
if(!b.includes(p)) b.push(p);
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "${DIR}/package.json" "${PKG}"

# 钉钉应用凭据：只存本机
if [ -n "${DINGTALK_CLIENT_ID:-}" ] && [ -n "${DINGTALK_CLIENT_SECRET:-}" ]; then
  mkdir -p "${HOME}/.dsh-meeting-dd" && chmod 700 "${HOME}/.dsh-meeting-dd"
  ( umask 077; node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({clientId:process.env.DINGTALK_CLIENT_ID,clientSecret:process.env.DINGTALK_CLIENT_SECRET},null,2)+"\n",{mode:0o600})' "${HOME}/.dsh-meeting-dd/dingtalk.json" )
  say "钉钉应用凭据已保存到 ~/.dsh-meeting-dd/dingtalk.json（仅本人可读）"
fi

say "检查配置能否组装"
dsh --profile "${PROFILE}" --dump-config >/dev/null
say "安装完成。"
echo "  1) 重启 profile ${PROFILE} 的 DSH（单独 profile 用 ${HERE}/start.sh）"
echo "  2) DSH 网页侧栏点「约会议·钉钉」→「👥 同事」→「登录钉钉（扫码）」，用钉钉扫码、选公司、点同意"
echo "     （也可以在终端运行 ${HERE}/login.sh）"
echo "  3) 选「我是谁」，按姓名添加钉钉同事，然后对助理说「约 张三 明天下午开半小时会」"
