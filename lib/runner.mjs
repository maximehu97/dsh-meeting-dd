// 在同一个 dsh 进程里直接跑本机助理（preset meeting-dd），不经过 HTTP / A2A。
// 局域网版靠 bundle 里再起一个 dsh-a2a 来调本机助理；但一个 profile 里只能有一个 dsh-a2a（它注册全局服务 a2aTasks），
// DSH 网页版本来就带了 dsh-a2a，局域网版也占了一个，再起就会让整个 DSH 起不来。所以这里照 dsh-a2a 的 bridge 写一个最小版：
//   agents.create / resume（挂上 preset）→ agent.followup(用户消息) → 收 session/event 里的 assistant/message，直到 turn/end。
// 同一个 contextId 复用同一个会话（助理记得这一场协商的上下文），同一会话的多条输入排队执行。
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

export class AgentRunner {
  constructor(ctx, { preset, cwd, turnTimeoutMs = 60 * 60 * 1000 }) {
    this.ctx = ctx; this.preset = preset; this.cwd = cwd; this.turnTimeoutMs = turnTimeoutMs;
    this.handles = new Map(); // contextId -> Promise<handle>
    this.queues = new Map(); // contextId -> Promise
    this.turns = new Map(); // sessionId -> { text, resolve, reject }
    ctx.on("session/event", (session, event) => this.onEvent(session, event));
  }
  onEvent(session, event) {
    const t = this.turns.get(String(session.id));
    if (!t) return;
    if (event.type === "assistant/message") {
      for (const b of event.data?.message?.content || []) if (b.type === "text") t.text += b.text;
    } else if (event.type === "turn/end") {
      const kind = event.data?.reason?.kind;
      if (kind === "error" || kind === "blocked") t.reject(new Error(`助理这一轮出错（${kind}）：${event.data?.reason?.message || event.data?.reason?.error?.message || ""}`));
      else t.resolve({ state: kind === "aborted" ? "canceled" : "completed", text: t.text });
    }
  }
  async handle(contextId) {
    if (!this.handles.has(contextId)) {
      const p = (async () => {
        const sessionId = SessionId(contextId);
        const presets = this.ctx.get("agentPresets");
        const presetId = presets ? (await presets.resolve(this.preset)).id : undefined;
        // 模型：用所在 profile 的默认模型（DSH 设置里选的那个）
        const d = this.ctx.get("agentDefaultModel")?.currentSelection?.();
        const selection = d?.provider && d?.model ? { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort } : undefined;
        const agentOptions = selection ? { provider: selection.provider, model: selection.model } : undefined;
        const setup = async (agentCtx) => {
          if (selection) installModelSelection(agentCtx, { current: selection, assembled: undefined }); // 语句，不能 return（返回值会被当成 setup 的 commit）
          if (presetId) await presets.mount(agentCtx, presetId);
        };
        const persisted = await this.ctx.get("sessionPersistence")?.stat(sessionId);
        return persisted
          ? this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
          : this.ctx.agents.create({ sessionId, meta: { cwd: this.cwd, ...(presetId ? { agentPreset: presetId } : {}) }, agentOptions, setup });
      })();
      this.handles.set(contextId, p);
      p.catch(() => this.handles.delete(contextId));
    }
    return this.handles.get(contextId);
  }
  // 发一条用户消息，等这一轮结束，返回助理最后说的话
  run(contextId, text) {
    const prev = this.queues.get(contextId) || Promise.resolve();
    const job = prev.catch(() => {}).then(() => this.runOne(contextId, text));
    this.queues.set(contextId, job);
    job.finally(() => { if (this.queues.get(contextId) === job) this.queues.delete(contextId); }).catch(() => {});
    return job;
  }
  async runOne(contextId, text) {
    const h = await this.handle(contextId);
    const sid = String(h.agent?.session?.id ?? h.session?.id ?? SessionId(contextId));
    let timer;
    const done = new Promise((resolve, reject) => {
      this.turns.set(sid, { text: "", resolve, reject });
      timer = setTimeout(() => { reject(new Error("助理一轮超时")); try { h.agent.cancel({ kind: "user" }); } catch {} }, this.turnTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.resolve(h.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })));
      return await done;
    } finally { clearTimeout(timer); this.turns.delete(sid); }
  }
  async stop() {
    for (const p of this.handles.values()) { try { const h = await p; await h.agent?.cancel?.({ kind: "user" }); } catch {} }
  }
}
