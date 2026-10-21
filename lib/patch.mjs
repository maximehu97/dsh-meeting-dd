#!/usr/bin/env node
// dsh 配置片段：
//  - bundlePatch()：插件自己的 bundle patch（scripts/build.mjs 写成 cordis.patch.yml）
//  - overlay()：换端口 / 团队码 / 数据目录时用的 --patch 叠加层。dsh 的 patch 按 id 整份替换 config，
//    所以叠加层要把节点和 preset（里面的 MCP 地址）两个条目完整重写一遍。
// 命令行：node lib/patch.mjs --port 4601 --data-dir ~/.dsh-meeting-dd-4601 [--loop-dir DIR --loop-name 名字] > overlay.yml
import { PROMPT } from "./prompt.mjs";

const q = (s) => JSON.stringify(s);
const ind = (s, n) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");

// 助理用所在 profile 的默认模型。
function entries({ port = 4600, dataDir = "", loopDir = "", loopName = "", simDir = "" }) {
  return `- id: meeting-dd
  name: '@maximehu97/dsh-meeting-dd'
  config:
    port: ${port}
    host: 127.0.0.1
    preset: meeting-dd${dataDir ? `\n    dataDir: ${q(dataDir)}` : ""}${loopDir ? `\n    loopDir: ${q(loopDir)}` : ""}${simDir ? `\n    simDir: ${q(simDir)}` : ""}${loopName ? `\n    loopName: ${q(loopName)}` : ""}
- id: preset-meeting-dd
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: meeting-dd
    order: 0
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          complete: true
          includeRuntimeContext: false
          prefix: ${q(PROMPT)}
      - id: meeting-dd-tools
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          transport: streamable-http
          serverName: meeting-dd
          url: http://127.0.0.1:${port}/mcp
          toolCallTimeoutMs: 3600000
          failOnStartupError: false
`;
}

// bundle 只插入自己的三个条目，不动所在 profile 的模型、会话目录等（插件也可能装进别人的 web / desktop profile）。
// 独立 profile「meeting-dd」里的模型和会话目录由 kit/install.sh 写进 profile 自己的 cordis.patch.yml。
export function bundlePatch() {
  return `# dsh-meeting-dd bundle patch（由 scripts/build.mjs 生成，别手改；要改端口等用 lib/patch.mjs 生成 --patch 叠加层）
- insert:
${ind(entries({}), 4)}
`;
}

export function overlay(o) {
  const dirs = o.dataDir ? `
- id: session-persistence-jsonl
  config:
    root: ${q(o.dataDir + "/sessions")}
- id: storage-json
  config:
    root: ${q(o.dataDir + "/storages")}` : "";
  return `# dsh-meeting-dd 叠加层（node lib/patch.mjs 生成）：端口 ${o.port}
${entries(o)}${dirs}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const home = process.env.HOME || "";
  const dataDir = arg("--data-dir", "").replace(/^~/, home);
  process.stdout.write(overlay({ port: +arg("--port", 4600), dataDir, loopDir: arg("--loop-dir", "").replace(/^~/, home), loopName: arg("--loop-name", ""), simDir: arg("--sim-dir", "").replace(/^~/, home) }));
}
