#!/bin/bash
# 一条命令安装 dsh-meeting-DD（从 GitHub 最新发布版下载安装包，再运行包里的 install.sh）：
#   curl -fsSL https://raw.githubusercontent.com/maximehu97/dsh-meeting-dd/main/install.sh | bash
# 装到别的 profile：  curl -fsSL …/install.sh | DSH_PROFILE=meeting-dd bash
# 指定版本：          curl -fsSL …/install.sh | DSH_MEETING_DD_VERSION=0.3.0 bash
set -eu
REPO="maximehu97/dsh-meeting-dd"
VER="${DSH_MEETING_DD_VERSION:-}"
DIR="${HOME}/.dsh-meeting-dd-kit"
command -v curl >/dev/null || { echo "需要 curl" >&2; exit 1; }
command -v unzip >/dev/null || { echo "需要 unzip" >&2; exit 1; }
if [ -z "${VER}" ]; then
  VER="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
  [ -n "${VER}" ] || { echo "查不到最新版本，请用 DSH_MEETING_DD_VERSION=版本号 重试" >&2; exit 1; }
fi
mkdir -p "${DIR}"
ZIP="${DIR}/dsh-meeting-dd-kit-${VER}.zip"
echo "==> 下载 dsh-meeting-DD ${VER}"
curl -fL --retry 3 -o "${ZIP}" "https://github.com/${REPO}/releases/download/v${VER}/dsh-meeting-dd-kit-${VER}.zip"
rm -rf "${DIR}/dsh-meeting-dd-kit-${VER}"
unzip -q -o "${ZIP}" -d "${DIR}"
exec bash "${DIR}/dsh-meeting-dd-kit-${VER}/install.sh" < /dev/null
