/**
 * dsh-meeting-DD — 九派多智能体协商（约会议 / 协调排时间 / 团建投票）的 dsh 插件，钉钉版。
 *
 * 每个人在自己的电脑上跑一个 dsh（profile 里装这个插件），插件在 dsh 进程里起一个本机节点：
 * 手机页 + MCP 工具（Streamable HTTP，供 preset「meeting-dd」里的助理使用）+ 钉钉通道（DWS）。
 * 助理之间的协商报文、人和人的消息都通过钉钉单聊收发，不再需要同一局域网。
 * 本机助理在同一个 dsh 进程里直接调用（lib/runner.mjs），不再起 dsh-a2a，所以能和 DSH 网页版自带的 a2a、局域网版 dsh-meeting 同时装。
 *
 * 钉钉应用凭据（Client ID / Secret）只存在本机凭据文件（默认 ~/.dsh-meeting-dd/dingtalk.json，权限 600），不写进配置和插件包。
 */
import Schema from "@deepseek-ai/schemastery";
import { MeetingNode } from "./node.mjs";
import { AgentRunner } from "./runner.mjs";

export const name = "dsh-meeting-dd";
/** 本机助理通过 agents 服务创建（和 dsh-a2a 一样）。 */
export const inject = ["agents"];

export const Config = Schema.object({
  port: Schema.natural().default(4600).description("手机页 / 节点端口"),
  host: Schema.string().default("127.0.0.1").description("手机页监听地址（默认只给本机；DSH 网页侧栏里打开）"),
  preset: Schema.string().default("meeting-dd").description("本机助理用的 agent preset"),
  dataDir: Schema.string().default("").description("本人数据目录，默认 ~/.dsh-meeting-dd"),
  credsFile: Schema.string().default("").description("钉钉应用凭据文件，默认 ~/.dsh-meeting-dd/dingtalk.json（也可以在手机页「👥 同事」里填）"),
  dwsPath: Schema.string().default("dws").description("钉钉 CLI（DingTalk Workspace CLI）可执行文件"),
  dwsProfile: Schema.string().default("").description("DWS 组织 profile（多组织时填 corpId:userId，默认用当前组织）"),
  aiTag: Schema.boolean().default(true).description("助理发出的钉钉消息带 AI 标识"),
  replyTimeoutMin: Schema.natural().default(30).description("等对方助理回复的最长分钟数"),
  loopDir: Schema.string().default("").description("测试用：填一个目录就改用本机假钉钉信箱（不联系真人）"),
  loopName: Schema.string().default("").description("测试 / 模拟节点的显示名"),
  simDir: Schema.string().default("").description("单账号模拟：填一个目录，本机几个节点共用一个钉钉账号（给自己发消息）互相协商"),
});

export function apply(ctx, config) {
  let ready;
  ctx.effect(() => {
    const node = new MeetingNode(config, new AgentRunner(ctx, { preset: config.preset || "meeting-dd", cwd: config.dataDir || undefined }));
    ready = node.start();
    return ready.then(() => async () => { await node.stop(); });
  });
  return ready;
}
