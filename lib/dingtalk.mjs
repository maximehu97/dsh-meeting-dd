// 钉钉通道：助理之间、人和人之间的消息都走钉钉单聊（以本人身份发送，带 AI 角标），收信用 DWS 事件长连接。
//  - DwsLink：真实钉钉，调用官方 DingTalk Workspace CLI（dws）。登录用部署者自己的钉钉应用（Client ID / Secret）。
//  - LoopLink：本机测试用的假钉钉（同一个目录当信箱），不联系任何真人，用来在一台电脑上起多个节点联调协议。
//
// 报文格式（一条钉钉文本消息）：
//   第一行起是给人看的自然语言（对方在钉钉里直接能读懂）；
//   最后一行是机器读的：⟦DSHM·1⟧{json}，太长时拆成多条：⟦DSHM·1·<分片id>·i/n⟧<json 片段>
// 普通人在钉钉里直接回复的文字（没有 ⟦DSHM 标记）会当作私聊消息显示在对方的「💭 消息」里，不会触发助理协商。
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const MARK = "⟦DSHM·1";
const CHUNK = 3000; // 单条钉钉文本里机器部分的最大长度（字符）

export function encodeWire(human, obj) {
  const json = JSON.stringify(obj);
  const head = String(human || "").replace(/⟦DSHM[^\n]*/g, "").trim();
  if (json.length <= CHUNK) return [`${head}\n${MARK}⟧${json}`];
  const id = randomBytes(4).toString("hex"), n = Math.ceil(json.length / CHUNK), out = [];
  for (let i = 0; i < n; i++) out.push(`${i === 0 ? head : `（续 ${i + 1}/${n}）`}\n${MARK}·${id}·${i + 1}/${n}⟧${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return out;
}

// 解析一条收到的文本：{ human, obj } / { human, part } / { human }（普通文字）
export function decodeWire(text) {
  const s = String(text ?? "");
  const at = s.lastIndexOf(MARK);
  if (at < 0) return { human: s.trim() };
  const human = s.slice(0, at).trim(), rest = s.slice(at + MARK.length);
  let m;
  if ((m = rest.match(/^⟧([\s\S]*)$/))) { try { return { human, obj: JSON.parse(m[1].trim()) }; } catch { return { human: s.trim() }; } }
  if ((m = rest.match(/^·([0-9a-f]{8})·(\d+)\/(\d+)⟧([\s\S]*)$/))) return { human, part: { id: m[1], i: +m[2], n: +m[3], data: m[4].replace(/\n$/, "") } };
  return { human: s.trim() };
}

// 分片重组
export class Reassembler {
  constructor() { this.parts = new Map(); }
  push(from, part) {
    const k = from + ":" + part.id;
    const e = this.parts.get(k) || { n: part.n, got: {}, t: Date.now() };
    e.got[part.i] = part.data;
    this.parts.set(k, e);
    for (const [kk, v] of this.parts) if (Date.now() - v.t > 30 * 60 * 1000) this.parts.delete(kk);
    if (Object.keys(e.got).length < e.n) return null;
    this.parts.delete(k);
    try { return JSON.parse(Array.from({ length: e.n }, (_, i) => e.got[i + 1]).join("")); } catch { return null; }
  }
}

export const handleKey = (openId) => "dt-" + createHash("sha256").update(String(openId)).digest("hex").slice(0, 16);

/* ============================== 真实钉钉（DWS） ============================== */
export class DwsLink {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg; this.log = log; this.child = null; this.stopping = false; this.state = "off";
  }
  get kind() { return "dws"; }
  // DSH 由 launchd / 桌面程序启动时 PATH 往往不含 npm 全局目录，这里按常见位置找 dws（做法参考 dsh-dingtalk 0.5.2）
  exe() {
    const want = this.cfg.dwsPath || "dws";
    if (want !== "dws") return want;
    if (this._exe) return this._exe;
    const suffix = process.platform === "win32" ? ".exe" : "";
    const dirs = [...(process.env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    this._exe = dirs.map((d) => path.join(d, "dws" + suffix)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } }) || "dws";
    return this._exe;
  }
  env() {
    // 部署者自己的应用凭据只在登录时用（startLogin）；登录成功后 DWS 自己记住用的是哪个应用，
    // 日常调用不再传凭据，免得和用 DWS 自带应用登录的 token 对不上。
    const env = { ...process.env };
    delete env.DWS_CLIENT_ID; delete env.DWS_CLIENT_SECRET;
    return env;
  }
  args(a) { return [...a, ...(this.cfg.dwsProfile ? ["--profile", this.cfg.dwsProfile] : []), "--format", "json"]; }
  async call(a, { timeout } = {}) {
    let stdout = "", failed;
    try {
      ({ stdout } = await execFileAsync(this.exe(), this.args(a), { timeout: timeout || 30000, maxBuffer: 4 << 20, encoding: "utf8", env: this.env() }));
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("本机没装钉钉 CLI（dws）。安装：npm install -g dingtalk-workspace-cli");
      stdout = e.stdout || ""; failed = e;
    }
    let body;
    try { body = JSON.parse(stdout); } catch { throw new Error(`dws ${a.slice(0, 3).join(" ")} 没有返回 JSON${failed ? "：" + String(failed.stderr || failed.message).slice(0, 300) : ""}`); }
    if (failed || body.error || body.ok === false || body.success === false || body.result?.success === false) {
      const err = body.error || body.result?.error || {};
      throw new Error(`钉钉：${err.message || body.errorMsg || body.message || "请求失败"}${err.hint ? "（" + err.hint + "）" : ""}`);
    }
    return body;
  }
  async auth() {
    try {
      const r = await this.call(["auth", "status"]);
      return { authenticated: !!r.authenticated, message: r.message, profile: r.profile || r.current_profile || null, raw: r };
    } catch (e) { return { authenticated: false, message: e.message }; }
  }
  // 本人：{ openId, userId, name, corp }
  async self() {
    const r = await this.call(["contact", "user", "get-self"]);
    const row = Array.isArray(r.result) ? r.result[0] : r.result || r;
    const u = row?.orgEmployeeModel || row?.user || row || {};
    const name = u.orgUserName || u.name || u.nick || "", userId = u.userId || "";
    let openId = u.openDingTalkId || row?.openDingTalkId || "";
    // get-self 不带 openDingTalkId：按本人姓名搜一下，用 userId 对上
    if (!openId && name) openId = (await DwsLink.prototype.search.call(this, name)).find((x) => x.userId && x.userId === userId)?.openId || "";
    return { openId, userId, name, corp: u.orgName || u.corpName || "" };
  }
  // 本人在组织里的部门、职位、主管、角色
  async orgInfo(userId) {
    const r = await this.call(["contact", "user", "get", "--ids", userId]);
    const row = (Array.isArray(r.result) ? r.result : [])[0] || {};
    const o = row.orgEmployeeModel || {};
    const depts = (o.depts || []).map((d) => d.deptName).filter(Boolean);
    return { dept: depts.find((d) => d !== o.orgName) || depts[0] || "", title: o.title || o.position || "", masterUserId: o.orgMasterUserId || null,
      labels: (o.labels || []).map((x) => x.name), hasSubordinate: !!o.hasSubordinate, isAdmin: !!row.isAdmin };
  }
  // 本组织全部成员（从根部门往下遍历）：[{ userId, name }]
  async orgMembers() {
    const seen = new Map(), queue = ["1"], visited = new Set();
    while (queue.length && visited.size < 200) {
      const d = queue.shift();
      if (visited.has(d)) continue; visited.add(d);
      const m = await this.call(["contact", "dept", "list-members", "--dept-id", d]).catch(() => ({}));
      for (const u of m.deptUserList || m.result || []) { const i = u.userInfo || u; if (i.userId && i.name) seen.set(i.userId, { userId: i.userId, name: i.name }); }
      const c = await this.call(["contact", "dept", "list-children", "--dept", d]).catch(() => ({}));
      for (const x of c.result || []) if (x.deptId) queue.push(String(x.deptId));
    }
    return [...seen.values()];
  }
  async search(query) {
    const r = await this.call(["contact", "user", "search", "--query", query]);
    const rows = Array.isArray(r.result) ? r.result : r.result?.items || r.result?.list || r.items || [];
    const out = new Map();
    for (const row of rows) {
      const id = row.openDingTalkId || row.open_dingtalk_id;
      if (typeof id !== "string" || !id.trim()) continue;
      out.set(id, { openId: id, name: row.name || row.nick || row.title || "", dept: typeof row.department === "string" ? row.department : row.deptName || "", title: row.position || row.title || "", userId: row.userId || "" });
    }
    return [...out.values()];
  }
  async send(openId, text, key) {
    const r = await this.call(["chat", "+messages-send", "--as", "user", "--open-dingtalk-id", openId, "--text", text,
      "--idempotency-key", key, `--ai-tag=${this.cfg.aiTag !== false}`, "--yes"]);
    const taskId = r.sendReceipt?.openTaskId ?? r.result?.result?.openTaskId ?? r.result?.openTaskId ?? null;
    return { taskId };
  }
  // 订阅本人收到的所有单聊消息（长连接）。onEvent({ id, from, fromName, text })
  start(onEvent, onState = () => {}) {
    this.stopping = false;
    const spawnOne = () => {
      const a = ["event", "consume", "user_im_message_receive_o2o_all", "--flatten", "--duration", "0", "--ttl", "0",
        ...(this.cfg.dwsProfile ? ["--profile", this.cfg.dwsProfile] : []), "--format", "ndjson"];
      const child = spawn(this.exe(), a, { stdio: ["ignore", "pipe", "pipe"], env: this.env() });
      this.child = child;
      this.state = "connecting"; onState(this.state);
      let buf = "", ebuf = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let end;
        while ((end = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, end); buf = buf.slice(end + 1);
          if (!line.trim()) continue;
          let raw; try { raw = JSON.parse(line); } catch { continue; }
          if (raw.error) { this.state = "error: " + (raw.error.message || "订阅失败"); onState(this.state); continue; }
          if (!/user_im_message_receive_o2o/.test(raw.type || "")) continue;
          const text = typeof raw.content === "string" ? raw.content.slice(0, 32000) : "（对方发来一条非文本消息，请在钉钉里查看）";
          Promise.resolve(onEvent({ id: raw.message_id || raw.event_id, from: raw.sender_open_dingtalk_id, fromName: raw.sender || "", text, conv: raw.conversation_id }))
            .catch((e) => this.log("event handler: " + e.message));
        }
      });
      child.stderr.on("data", (chunk) => {
        ebuf = (ebuf + chunk).slice(-4000);
        if (/\[event\] ready|state[:=] ?connected|"state":"connected"/.test(chunk) && this.state !== "ready") { this.state = "ready"; this.fails = 0; onState(this.state); }
      });
      child.on("error", (e) => { this.state = "error: 启动 dws 失败 " + (e.code || e.message); onState(this.state); });
      child.on("close", (code) => {
        if (this.child === child) this.child = null;
        if (this.stopping) { this.state = "off"; onState(this.state); return; }
        const tail = ebuf.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) || "";
        // 登录 / 权限问题重连也没用：停下来等本人处理；其他断线按 10s、20s、40s… 最长 5 分钟退避重连
        if (/auth|unauthori|permission|forbidden|login|登录|权限/i.test(ebuf.slice(-1500))) { this.state = `error: 钉钉登录或权限失效，请重新登录（${tail}）`; onState(this.state); return; }
        this.fails = (this.fails || 0) + 1;
        const wait = Math.min(300000, 10000 * 2 ** Math.min(5, this.fails - 1));
        this.state = `closed（${code}），${Math.round(wait / 1000)} 秒后重连 ${tail}`; onState(this.state);
        this.retryT = setTimeout(spawnOne, wait);
      });
    };
    spawnOne();
  }
  async stop() {
    this.stopping = true; clearTimeout(this.retryT);
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    await new Promise((r) => { const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} r(); }, 5000); c.once("close", () => { clearTimeout(t); r(); }); c.kill("SIGTERM"); });
  }
}

/* ============================== 本机假钉钉（测试） ============================== */
// 目录结构：<dir>/users.json（openId → { name }），<dir>/inbox/<openId>/<时间>-<随机>.json
export class LoopLink {
  constructor(cfg, log = () => {}) {
    this.dir = cfg.loopDir; this.me = cfg.loopUser; this.log = log; this.state = "off";
    fs.mkdirSync(path.join(this.dir, "inbox", this.me.openId), { recursive: true });
    const users = this.users();
    users[this.me.openId] = { name: this.me.name };
    fs.writeFileSync(path.join(this.dir, "users.json"), JSON.stringify(users, null, 1));
  }
  get kind() { return "loop"; }
  users() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "users.json"), "utf8")); } catch { return {}; } }
  async auth() { return { authenticated: true, message: "本机测试信箱（不是真钉钉）" }; }
  async self() { return { openId: this.me.openId, userId: this.me.openId, name: this.me.name, corp: "本机测试" }; }
  async search(q) { return Object.entries(this.users()).filter(([, u]) => u.name.includes(q)).map(([openId, u]) => ({ openId, name: u.name, dept: "", title: "" })); }
  async send(openId, text, key) {
    const box = path.join(this.dir, "inbox", openId);
    if (!fs.existsSync(box)) throw new Error("测试信箱里没有这个人：" + openId);
    const f = path.join(box, `${Date.now()}-${randomBytes(3).toString("hex")}.json`);
    fs.writeFileSync(f + ".tmp", JSON.stringify({ id: key, from: this.me.openId, fromName: this.me.name, text }));
    fs.renameSync(f + ".tmp", f);
    return { taskId: "loop-" + key };
  }
  start(onEvent, onState = () => {}) {
    const box = path.join(this.dir, "inbox", this.me.openId);
    for (const f of fs.readdirSync(box)) fs.rmSync(path.join(box, f), { force: true }); // 只收启动后的新消息，和钉钉事件流一样
    const tick = () => {
      for (const f of fs.readdirSync(box).filter((x) => x.endsWith(".json")).sort()) {
        const p = path.join(box, f);
        let ev; try { ev = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        fs.rmSync(p, { force: true });
        Promise.resolve(onEvent(ev)).catch((e) => this.log("loop handler: " + e.message));
      }
    };
    this.timer = setInterval(tick, 300);
    this.state = "ready"; onState(this.state);
  }
  async stop() { clearInterval(this.timer); this.state = "off"; }
}

/* ============================== 单账号模拟（真钉钉，一个账号扮演多个人） ============================== */
// 只有一个钉钉账号时用：本机起几个节点（李经理、刘经理…），全部以同一个钉钉账号登录。
// 发信 = 给本人自己发单聊（钉钉里「我自己」那个会话），第一行带路由头 ⟦DSHS 收件节点 发件节点⟧；
// 收信 = 每隔几秒读一次「我自己」会话的最新消息（钉钉不会给自己发的消息推事件），只处理发给本节点的。
// 所有协商报文都真实经过钉钉服务器，本人在钉钉里能看到全过程。节点名册放在本机目录 <simDir>/users.json。
export class SelfChatLink extends DwsLink {
  constructor(cfg, log = () => {}) {
    super(cfg, log);
    this.dir = cfg.simDir; this.me = cfg.simUser; // { id: "self#4611", name: "李经理" }
    fs.mkdirSync(this.dir, { recursive: true });
    const users = this.users(); users[this.me.id] = { name: this.me.name, t: Date.now() };
    fs.writeFileSync(path.join(this.dir, "users.json"), JSON.stringify(users, null, 1));
    this.seen = new Set();
  }
  get kind() { return "selfchat"; }
  users() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "users.json"), "utf8")); } catch { return {}; } }
  async self() {
    const real = await super.self();
    this.realId = real.openId;
    return { openId: this.me.id, userId: real.userId, name: this.me.name, corp: `${real.corp}（${real.name} 的账号模拟）` };
  }
  async search(q) { return Object.entries(this.users()).filter(([id, u]) => id !== this.me.id && u.name.includes(q)).map(([openId, u]) => ({ openId, name: u.name, dept: "", title: "钉钉单账号模拟" })); }
  async send(openId, text, key) {
    if (!this.realId) await this.self();
    return super.send(this.realId, `⟦DSHS ${openId} ${this.me.id}⟧\n${text}`, key);
  }
  start(onEvent, onState = () => {}) {
    this.stopping = false;
    const since = Date.now() - 5000;
    const tick = async () => {
      if (this.stopping) return;
      try {
        if (!this.realId) await this.self();
        const r = await this.call(["chat", "+chat-messages", "--open-dingtalk-id", this.realId, "--limit", "30"]);
        const msgs = (r.messages || []).slice().reverse(); // 旧 → 新
        for (const m of msgs) {
          if (!m.messageId || this.seen.has(m.messageId)) continue;
          this.seen.add(m.messageId);
          if (Date.parse(String(m.createTime).replace(" ", "T") + "+08:00") < since) continue;
          const h = String(m.text || "").match(/^⟦DSHS (\S+) (\S+)⟧\n?/);
          if (!h || h[1] !== this.me.id) continue;
          await Promise.resolve(onEvent({ id: m.messageId, from: h[2], fromName: this.users()[h[2]]?.name || "", text: m.text.slice(h[0].length) })).catch((e) => this.log("selfchat handler: " + e.message));
        }
        if (this.state !== "ready") { this.state = "ready"; onState(this.state); }
      } catch (e) { this.state = "error: " + e.message.slice(0, 160); onState(this.state); }
      if (this.seen.size > 3000) this.seen = new Set([...this.seen].slice(-1500));
      this.timer = setTimeout(tick, this.cfg.pollMs || 2500);
    };
    tick();
  }
  async stop() { this.stopping = true; clearTimeout(this.timer); }
}
