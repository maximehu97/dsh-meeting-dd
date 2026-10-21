// dsh-meeting-DD 本机节点：每个人一台电脑一个，跑在 dsh 进程里（由 lib/index.js 挂载）。和局域网版 dsh-meeting 的区别：
// 助理之间、人和人之间的通信全部走钉钉（以本人钉钉身份发单聊，DWS 事件长连接收信），不再有局域网 A2A / mDNS / 节点互连。
//  1) 本人的数据：日程 / 偏好 / 原始记录 / 助理档案 / 会议室预订 / 奶茶订单（存 dataDir/state.json）
//  2) MCP 工具（Streamable HTTP，/mcp，只对本机）：本机 dsh 助理通过它读写本人数据、发钉钉协商报文
//  3) 出站：send_ding → 钉钉单聊（报文附在消息末尾 ⟦DSHM·1⟧{json}）；对方节点收到后交给它自己的助理，助理调 reply_ding 回钉钉
//  4) 本机助理：在同一个 dsh 进程里直接调（lib/runner.mjs），不开端口
//  5) 手机页：/（SSE 实时推送，本人说话 / 点按钮），嵌在 DSH 网页侧栏「约会议·钉钉」里
//  6) 人和人的消息：@ 私聊、群聊 → 钉钉单聊，对方本人在钉钉里直接能看到；对方在钉钉里直接回的文字也会显示在「💭 消息」里
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as E from "./engine.mjs";
import { generateProfile } from "./gen.mjs";
import { mcpHandler } from "./mcp.mjs";
import { DwsLink, LoopLink, SelfChatLink, encodeWire, decodeWire, Reassembler, handleKey } from "./dingtalk.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const SEEDS = JSON.parse(fs.readFileSync(path.join(HERE, "seeds.json"), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
const clone = (x) => JSON.parse(JSON.stringify(x));
const nowIso = () => new Date().toISOString();
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const nowTag = () => { const d = new Date(); return `[现在 ${E.ymd(d)} ${WD[d.getDay()]} ${E.F(d.getHours() * 60 + d.getMinutes())}]`; };
const KIND_CN = { busy: "原有", one: "1on1", lead: "上级会", peer: "同级会/已定", up: "上报会", hold: "暂锁", bump: "被挤掉待重约" };
const TYPES = ["NOTICE", "SYN", "PROPOSE", "RELAX", "CONFIRM", "REPORT", "VOTE"];
const RTYPES = ["RCPT", "SYN-ACK", "ACK", "DECIDE", "BALLOT"];
const TYPE_CN = { NOTICE: "通知", SYN: "问空闲", PROPOSE: "提案", RELAX: "请本人松绑", CONFIRM: "定稿", REPORT: "上报", VOTE: "奶茶投票", RCPT: "回执", "SYN-ACK": "回可用时段", ACK: "答复", DECIDE: "拍板", BALLOT: "选票" };

export class MeetingNode {
  constructor(config, runner = null) {
    this.cfg = config;
    this.runner = runner;
    this.dataDir = (config.dataDir || path.join(os.homedir(), ".dsh-meeting-dd")).replace(/^~(?=\/|$)/, os.homedir());
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.file = path.join(this.dataDir, "state.json");
    this.instance = randomBytes(6).toString("hex");
    this.clients = new Set();
    this.waiters = {};
    this.pending = {}; // 出站报文 msgId -> { resolve, reply }
    this.peers = {}; // id -> peer
    this.localBusy = 0;
    this.inboundBusy = 0;
    this.credsFile = (config.credsFile || path.join(os.homedir(), ".dsh-meeting-dd", "dingtalk.json")).replace(/^~(?=\/|$)/, os.homedir());
    this.seen = new Set();
    this.reasm = new Reassembler();
    this.dt = { state: "off" };
    this.load();
    this.link = this.makeLink();
    this.rebuildPeers();
  }

  /* ============================== 状态 ============================== */
  blank(me = null) {
    return { v: 1, me, cal: [], prefs: [], history: "", profile: null, exemptions: [], openers: [], persona: null,
      chat: [], a2a: [], asks: {}, deferred: [], inbound: {}, roomBook: [], order: null, tally: null, board: null,
      contacts: {}, status: { x: "💤 待命", cls: "idle" }, seq: 0, run: Date.now().toString(36),
      dms: {}, groups: {}, outbox: [] };
  }
  load() {
    try { this.S = { ...this.blank(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) }; }
    catch { this.S = this.blank(); }
    // 示例人物的岗位 / 部门 / 上级随版本更新（两个 demo 合并成一家公司），本人的日程和记录不动
    const seed = this.S.persona && SEEDS.personas.find((p) => p.id === this.S.persona);
    if (seed) {
      this.S.me = clone(seed.me);
      if (!this.S.history?.trim() && seed.history) this.S.history = seed.history;
      if (!this.S.cal.length && seed.cal.length) this.S.cal = clone(seed.cal);
      if (!this.S.prefs.length && seed.prefs.length) this.S.prefs = clone(seed.prefs);
      this.S.openers = seed.openers;
    }
    // 重启后没人等的卡片作废
    for (const a of Object.values(this.S.asks)) if (!a.answer) a.answer = "expired";
    this.S.inbound = {};
    this.S.status = { x: "💤 待命", cls: "idle" };
  }
  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.S));
      fs.renameSync(tmp, this.file);
    }, 300);
  }
  emit(type, data = {}) {
    const line = `data: ${JSON.stringify({ type, t: nowIso(), ...data })}\n\n`;
    for (const res of this.clients) res.write(line);
    this.save();
  }
  setStatus(x, cls) { this.S.status = { x, cls }; this.emit("status", { status: this.S.status }); }
  chat(m) {
    const msg = { id: "c" + ++this.S.seq, t: nowIso(), ...m };
    this.S.chat.push(msg);
    if (this.S.chat.length > 400) this.S.chat.splice(0, this.S.chat.length - 400);
    this.emit("chat", { msg });
    return msg;
  }
  logA2A(rec) {
    rec = { id: "a" + ++this.S.seq, t: nowIso(), ...rec };
    this.S.a2a.push(rec);
    if (this.S.a2a.length > 400) this.S.a2a.splice(0, this.S.a2a.length - 400);
    this.emit("a2a", { rec });
    return rec;
  }
  get me() { return this.S.me; }
  info() {
    return { app: "dsh-meeting-dd", version: VERSION, instance: this.instance, me: this.me };
  }
  snapshot() {
    return {
      me: this.me, persona: this.S.persona, cal: this.S.cal, prefs: this.S.prefs, history: this.S.history, profile: this.S.profile,
      exemptions: this.S.exemptions, openers: this.S.openers, chat: this.S.chat, a2a: this.S.a2a, status: this.S.status,
      asks: Object.values(this.S.asks).filter((a) => !a.answer), roomBook: this.S.roomBook, order: this.S.order, tally: this.S.tally, board: this.S.board,
      peers: Object.values(this.peers).map(this.pubPeer), dt: this.pubDt(), run: this.S.run,
      seeds: SEEDS.personas.map((p) => ({ id: p.id, group: p.group, groupName: p.groupName, me: p.me })), rooms: SEEDS.rooms,
      directory: this.directory(), dms: this.S.dms, groups: this.S.groups, outbox: this.S.outbox.map((o) => ({ to: o.to, mid: o.mid })),
      ports: { node: this.cfg.port }, today: E.ymd(new Date()),
    };
  }
  pubPeer = (p) => p && ({ id: p.id, me: p.me, dtName: p.dtName, installed: p.installed, online: p.online, via: p.via, lastSeen: p.lastSeen, clash: p.clash });

  setup(body) {
    let next;
    if (body.persona) {
      const p = SEEDS.personas.find((x) => x.id === body.persona);
      if (!p) throw new Error("没有这个示例人物：" + body.persona);
      next = this.blank(clone(p.me));
      Object.assign(next, { cal: clone(p.cal), prefs: clone(p.prefs), history: p.history, openers: p.openers, persona: p.id });
    } else {
      const c = body.custom || {};
      const n = String(c.n || "").trim();
      if (!n) throw new Error("请填名字");
      const id = String(c.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "u" + randomBytes(3).toString("hex");
      next = this.blank({ id, n, r: c.r || "同事", L: +c.L || 3, dept: c.dept || "", up: c.up || null, c: "#9fe3c8", a: n.slice(0, 1) });
      next.history = c.history || "";
      next.openers = ["约同事明天下午开个半小时的会。", "这周末约大家出去玩半天，顺便团一波奶茶～"];
    }
    next.contacts = this.S.contacts;
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    this.S = next;
    this.save();
    this.emit("reset");
    this.rebuildPeers();
    this.onIdentity();
  }
  // 换了身份：告诉已接入的钉钉同事（他们那边的通讯录会更新）
  onIdentity() {
    for (const c of this.contactList().filter((x) => x.installed))
      this.wireSend(c.openId, `（助理自动消息）我在九派里的身份更新为：${this.me.n}（${this.me.r}）`, { k: "hello", info: this.info() }).catch(() => {});
  }
  resetRound(reseed) {
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    if (reseed && this.S.persona) return this.setup({ persona: this.S.persona });
    Object.assign(this.S, { chat: [], a2a: [], asks: {}, deferred: [], inbound: {}, order: null, tally: null, board: null, run: Date.now().toString(36) });
    this.emit("reset");
  }

  /* ============================== 本机助理 ============================== */
  async deliverLocal(text, contextId) {
    this.localBusy++;
    try {
      if (!this.runner) throw new Error("本机助理不可用（插件没有拿到 dsh 的 agents 服务）");
      return await this.runner.run(contextId, `${nowTag()} ${text}`);
    }
    finally { this.localBusy--; this.kickDeferred(); }
  }
  kickDeferred() {
    setTimeout(() => { if (!this.localBusy && !this.inboundBusy && this.S.deferred.length) this.runDeferred(); }, 500);
  }
  async runDeferred() {
    const job = this.S.deferred.shift();
    if (!job) return;
    this.setStatus("🤖 " + job.title, "run");
    try {
      await this.deliverLocal(`【后台任务】${job.instruction}`, `task-${job.id}__${this.me.id}__${this.S.run}`);
      this.setStatus("✓ 已处理", "ok");
    } catch (e) {
      this.chat({ from: "sys", x: "⚠ 后台任务失败：" + e.message });
      this.setStatus("⚠ 出错", "warn");
    }
  }

  /* ============================== 本人 ============================== */
  async ownerSay(text) {
    if (!this.me) throw new Error("先扫码登录钉钉");
    // 「@A 明天下午开会」= 让我的助理去和 A 的助理办这件事（不是直接给 A 发消息；私聊在「💭 消息」里发）
    const at = this.parseMentions(text);
    this.chat({ from: "me", x: text });
    if (at.ids.length) text += `\n（本人 @ 的同事：${at.ids.map((id) => `${this.nameOf(id)}=${id}`).join("，")}。请你通过 send_ding 和他们的助理协商，不要只转发一句话。）`;
    this.setStatus("🎙 收到指令", "run");
    try {
      const r = await this.deliverLocal(`【本人】${text}`, `owner__${this.me.id}__${this.S.run}`);
      if (r.text?.trim()) this.chat({ from: "bot", x: r.text.trim() });
      this.setStatus("✓ 完成", "ok");
    } catch (e) {
      this.chat({ from: "sys", x: "⚠ " + e.message });
      this.setStatus("⚠ 出错", "warn");
    }
  }
  ownerAnswer(askId, key) {
    const ask = this.S.asks[askId];
    if (!ask) throw new Error("没有这个待决定事项");
    if (ask.answer) return;
    ask.answer = key; ask.at = nowIso();
    const opt = ask.options.find((o) => o.key === key);
    this.chat({ from: "me", x: opt?.label || key, tap: true });
    this.emit("answer", { askId, key });
    this.waiters[askId]?.(key);
    delete this.waiters[askId];
  }

  /* ============================== 钉钉同事 ============================== */
  // 同事 = 钉钉联系人（openDingTalkId）。本人在 👥 页按姓名搜到并添加，或者对方的助理先发来报文。
  // 加好友时发一条 hello（对方钉钉里能看到这条消息），对方节点回 pong 后才算「已接入」，才能发协商报文。
  // 钉钉没有在线状态：online = 对方节点回过消息，且最近一次报文没有超时。
  creds() {
    if (this.cfg.clientId && this.cfg.clientSecret) return { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret };
    try { const c = JSON.parse(fs.readFileSync(this.credsFile, "utf8")); return c.clientId && c.clientSecret ? c : null; } catch { return null; }
  }
  saveCreds(b) {
    const c = { ...(this.creds() || {}) };
    for (const k of ["clientId", "clientSecret", "agentId", "appId"]) if (String(b[k] || "").trim()) c[k] = String(b[k]).trim();
    if (!c.clientId || !c.clientSecret) throw new Error("Client ID 和 Client Secret 都要填");
    fs.mkdirSync(path.dirname(this.credsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.credsFile, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(this.credsFile, 0o600);
    this.link.cfg.creds = c;
  }
  makeLink() {
    const log = (x) => console.error("[dsh-meeting-dd]", x);
    const loop = this.cfg.loopDir || process.env.DSH_MEETING_DD_LOOP;
    if (loop) return new LoopLink({ loopDir: loop, loopUser: { openId: "loop-" + this.cfg.port, name: this.cfg.loopName || process.env.DSH_MEETING_DD_LOOP_NAME || "测试" + this.cfg.port } }, log);
    const sim = this.cfg.simDir || process.env.DSH_MEETING_DD_SIM;
    if (sim) return new SelfChatLink({ simDir: sim, simUser: { id: "self#" + this.cfg.port, name: this.cfg.loopName || process.env.DSH_MEETING_DD_LOOP_NAME || "模拟" + this.cfg.port }, dwsPath: this.cfg.dwsPath || "dws", dwsProfile: this.cfg.dwsProfile || "", aiTag: this.cfg.aiTag !== false, pollMs: +process.env.DSH_MEETING_DD_POLL_MS || 2500 }, log);
    return new DwsLink({ dwsPath: this.cfg.dwsPath || "dws", dwsProfile: this.cfg.dwsProfile || "", aiTag: this.cfg.aiTag !== false, creds: this.creds() }, log);
  }
  async connect() {
    this.dt = { ...this.dt, state: "checking", error: null };
    this.emitDt();
    try {
      const a = await this.link.auth();
      if (!a.authenticated) { this.dt = { ...this.dt, state: "login", error: a.message || "未登录" }; return this.emitDt(); }
      const self = await this.link.self();
      if (!self.openId) throw new Error("没拿到本人的 openDingTalkId（dws contact user get-self）");
      this.dt = { ...this.dt, self: { openId: self.openId, name: self.name, corp: self.corp, userId: self.userId }, state: "connecting" };
      if (this.link.kind === "dws") await this.ensureIdentity(self).catch((e) => console.error("[dsh-meeting-dd] identity:", e.message));
      this.rebuildPeers();
      this.emitDt();
      await this.link.stop();
      this.link.start((ev) => this.onLinkEvent(ev), (st) => {
        this.dt.listen = st;
        if (st === "ready" && this.dt.state !== "ready") { this.dt.state = "ready"; if (this.link.kind === "dws" && this.cfg.autoDiscover !== false) setTimeout(() => this.discover().catch((e) => console.error("[dsh-meeting-dd] discover:", e.message)), 3000); }
        this.emitDt();
      });
    } catch (e) {
      this.dt = { ...this.dt, state: "error", error: e.message };
      this.emitDt();
    }
  }
  // 身份直接来自钉钉：姓名、部门、职位、主管；第一次（或换了钉钉账号）时自动生成一套示例档案
  async ensureIdentity(self) {
    if (this.S.me && !this.S.persona && this.S.me.dt === self.userId) return;
    const org = await this.link.orgInfo(self.userId).catch(() => ({}));
    const id = "dt" + String(self.userId).slice(-6);
    const L = org.labels?.some((x) => /负责人|总经理|CEO/.test(x)) ? 1 : org.hasSubordinate || org.labels?.some((x) => /主管|经理/.test(x)) ? 2 : 3;
    const me = { id, n: self.name, r: org.title || (L === 1 ? "负责人" : L === 2 ? "主管" : "同事"), L, dept: org.dept || self.corp || "", up: org.masterUserId ? "dt" + String(org.masterUserId).slice(-6) : null,
      c: ["#9fe3c8", "#7fc8ff", "#ffc6a8", "#c9b6ff", "#ffd27a", "#a8e6ff", "#ffb3c7", "#d8e58f"][parseInt(String(self.userId).slice(-2), 10) % 8 || 0], a: self.name.slice(0, 1), dt: self.userId };
    // 已经在用的自填身份（旧版）保留日程和记录，只把身份换成钉钉的；示例人物（李经理、小美…）整份换掉
    const keep = !!this.S.me && !this.S.persona;
    const next = keep ? this.S : this.blank(me);
    next.me = me; next.persona = null;
    if (!keep || (!next.cal.length && !next.history?.trim())) {
      const g = generateProfile(self.userId);
      Object.assign(next, { cal: g.cal, prefs: g.prefs, history: g.history, generated: true,
        openers: ["约同事明天下午开个半小时的会。", "这周末约大家出去玩半天，顺便团一波奶茶～", "下周找个时间跟主管汇报一下进展，一小时。"] });
      next.contacts = this.S.contacts || {};
    }
    this.S = next;
    this.save(); this.emit("reset");
    this.onIdentity();
  }
  regenerate() {
    if (!this.me) throw new Error("先扫码登录钉钉");
    const g = generateProfile((this.me.dt || this.me.id) + ":" + Date.now());
    Object.assign(this.S, { cal: g.cal, prefs: g.prefs, history: g.history, profile: null, exemptions: [], generated: true });
    this.calChanged();
  }
  // 自动发现：给本组织的每位同事发一次打招呼。装了插件的同事会自动回应、出现在同事列表里；没装的只收到这一条说明。
  async discover(force = false) {
    if (this.link.kind !== "dws" || this.discovering) return { skipped: true };
    this.discovering = true;
    try {
      const members = await this.link.orgMembers();
      const mine = this.dt.self?.userId;
      const probed = (this.S.probed ||= {});
      const todo = members.filter((m) => m.userId !== mine && (force || !probed[m.userId]) && !this.contactList().some((c) => c.userId === m.userId && c.installed));
      if (members.length > (this.cfg.autoDiscoverMax || 80) && !force) return { members: members.length, skipped: "组织人数较多，请在「👥 同事」里手动发现" };
      let sent = 0;
      for (const m of todo) {
        try {
          const openId = (await this.link.search(m.name)).find((x) => x.userId === m.userId)?.openId;
          if (!openId) continue;
          await this.wireSend(openId, "（九派私人助理自动消息）我装了九派助理（dsh-meeting-DD），用来在钉钉里帮我约会议、排时间、团建投票。你也装了的话，我们的助理会自动连上；没装请忽略这条。", { k: "hello", ask: true, info: this.info() });
          probed[m.userId] = nowIso(); sent++;
        } catch (e) { console.error("[dsh-meeting-dd] discover", m.name, e.message); }
      }
      this.save();
      if (sent) this.chat({ from: "sys", x: `🔎 已向 ${sent} 位钉钉同事打招呼，装了九派助理的同事会自动出现在「👥 同事」里` });
      return { members: members.length, sent };
    } finally { this.discovering = false; }
  }
  emitDt() { this.emit("dt", { dt: this.pubDt() }); }
  pubDt() { return { kind: this.link.kind, state: this.dt.state, listen: this.dt.listen, error: this.dt.error, self: this.dt.self, creds: !!this.creds(), credsFile: this.credsFile, login: this.dt.login }; }
  // 用本机保存的应用凭据跑 dws auth login（会在本机打开浏览器，本人扫码授权）
  // 默认用钉钉 CLI 自带的应用登录（扫码即可，不需要任何凭据）；custom=true 时用部署者自己的企业内部应用
  startLogin(custom = false) {
    if (this.link.kind === "loop") throw new Error("测试信箱不需要登录");
    if (this.loginChild) return { running: true };
    const env = { ...process.env };
    delete env.DWS_CLIENT_ID; delete env.DWS_CLIENT_SECRET;
    if (custom) {
      const c = this.creds();
      if (!c) throw new Error("先填钉钉应用的 Client ID 和 Client Secret");
      Object.assign(env, { DWS_CLIENT_ID: c.clientId, DWS_CLIENT_SECRET: c.clientSecret });
    }
    const child = spawn(this.link.exe ? this.link.exe() : "dws", ["auth", "login"], { env, stdio: ["ignore", "pipe", "pipe"] });
    this.loginChild = child;
    let out = "";
    const grab = (d) => { out = (out + d).slice(-4000); const m = out.match(/https:\/\/login\.dingtalk\.com\/\S+/); this.dt.login = { running: true, url: m?.[0] || null }; this.emitDt(); };
    child.stdout.on("data", grab); child.stderr.on("data", grab);
    child.on("close", (code) => { this.loginChild = null; this.dt.login = { running: false, ok: code === 0, msg: code === 0 ? "登录成功" : (out.match(/"message":\s*"([^"]+)"/g)?.pop()?.replace(/^"message":\s*"|"$/g, "") || out.split("\n").filter(Boolean).slice(-2).join(" ")).slice(0, 300) }; this.emitDt(); if (code === 0) this.connect(); });
    child.on("error", (e) => { this.loginChild = null; this.dt.login = { running: false, ok: false, msg: e.message }; this.emitDt(); });
    return { running: true };
  }
  contactList() { return Object.values(this.S.contacts || {}); }
  // 由联系人表重建 peers（按 persona id 索引）
  rebuildPeers() {
    const peers = {};
    const mine = this.dt?.self?.openId;
    if (mine && this.S.contacts?.[mine]) delete this.S.contacts[mine]; // 本人不能是自己的同事
    for (const c of this.contactList()) {
      const id = c.info?.me?.id || handleKey(c.openId);
      const me = c.info?.me || { id, n: c.dtName || "钉钉同事", r: c.title || "未接入助理", dept: c.dept || "", L: 3, a: (c.dtName || "?").slice(0, 1), c: "#c9d6df" };
      const prev = peers[id];
      peers[id] = { id, me, openId: c.openId, dtName: c.dtName, online: !!c.installed && !c.timeout, installed: !!c.installed, via: c.via, lastSeen: c.lastSeen, clash: !!prev || (this.me && id === this.me.id) };
    }
    this.peers = peers;
    this.emit("peers", { peers: Object.values(peers).map(this.pubPeer) });
  }
  contact(openId) { return (this.S.contacts ||= {})[openId]; }
  upsertContact(openId, patch) {
    const c = (this.S.contacts ||= {})[openId] ||= { openId, t: nowIso() };
    Object.assign(c, patch);
    this.rebuildPeers();
    if (c.installed && this.S.outbox.some((o) => o.openId === openId)) setTimeout(() => this.flushOutbox().catch(() => {}), 300);
    return c;
  }
  async searchDingTalk(q) {
    q = String(q || "").trim();
    if (!q) throw new Error("填要找的同事姓名");
    const list = await this.link.search(q);
    const mine = this.dt.self?.openId;
    return list.filter((x) => x.openId !== mine).map((x) => ({ ...x, added: !!this.contact(x.openId), installed: !!this.contact(x.openId)?.installed }));
  }
  async addContact(x) {
    if (!x?.openId) throw new Error("缺 openId");
    if (x.openId === this.dt.self?.openId) throw new Error("这是你自己");
    this.upsertContact(x.openId, { dtName: x.name || this.contact(x.openId)?.dtName, dept: x.dept, title: x.title, via: this.contact(x.openId)?.via || "manual" });
    this.save();
    await this.wireSend(x.openId, `你好，我的九派私人助理（dsh-meeting-DD）已接入钉钉，之后约会议、排时间、团建投票会由助理和你的助理直接在钉钉里沟通。`, { k: "hello", ask: true, info: this.info() });
    return this.pubPeer(Object.values(this.peers).find((p) => p.openId === x.openId));
  }
  forgetContact(id) {
    const p = this.peers[id];
    if (p) delete this.S.contacts[p.openId];
    this.S.outbox = this.S.outbox.filter((o) => o.openId !== p?.openId);
    this.rebuildPeers(); this.save();
  }
  // 发一条（或几条分片）钉钉消息
  async wireSend(openId, human, obj) {
    if (!openId) throw new Error("对方没有钉钉 openId");
    const parts = encodeWire(human, obj);
    for (const [i, text] of parts.entries()) {
      const key = `dshm-${this.instance}-${++this.S.seq}-${i}-${randomBytes(3).toString("hex")}`;
      await this.link.send(openId, text, key);
    }
    this.dt.sent = (this.dt.sent || 0) + parts.length;
  }
  async onLinkEvent(ev) {
    if (!ev?.from || ev.from === this.dt.self?.openId) return;
    if (ev.id) { if (this.seen.has(ev.id)) return; this.seen.add(ev.id); if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000)); }
    const w = decodeWire(ev.text);
    let obj = w.obj;
    if (w.part) obj = this.reasm.push(ev.from, w.part);
    if (!obj) {
      if (w.part) return; // 等其余分片
      // 普通文字：只收已添加同事的，显示为私聊（不触发助理）
      const c = this.contact(ev.from);
      if (!c || !this.me) return;
      const pid = this.peerIdOf(ev.from);
      this.dmPush(pid, { id: "dt." + (ev.id || randomBytes(4).toString("hex")), from: pid, to: this.me.id, x: w.human, t: nowIso(), dt: true });
      return;
    }
    const c0 = this.contact(ev.from);
    const info = obj.info || obj.sender;
    this.upsertContact(ev.from, { dtName: ev.fromName || c0?.dtName, installed: true, timeout: false, lastSeen: nowIso(), via: c0?.via || "incoming", ...(info?.me ? { info } : {}) });
    const pid = this.peerIdOf(ev.from);
    switch (obj.k) {
      case "hello": if (obj.ask && this.me) await this.wireSend(ev.from, `（助理自动回复）已连上，你的助理现在可以和我的助理在钉钉里协商了。`, { k: "pong", info: this.info() }).catch(() => {}); return;
      case "pong": this.chat({ from: "sys", x: `🔗 ${this.nameOf(pid)} 的助理已接入钉钉协商` }); return;
      case "env": return this.onEnvelope(obj, ev.from);
      case "reply": return this.onReply(obj);
      case "dm": case "group": return this.onPeerMsg(obj, pid);
    }
  }
  peerIdOf(openId) { return Object.values(this.peers).find((p) => p.openId === openId)?.id || handleKey(openId); }
  peerOf(id) {
    const p = this.peers[id] || Object.values(this.peers).find((x) => x.me?.n === id || x.dtName === id);
    if (!p) throw new Error(`钉钉同事里没有 ${id}。已接入：${this.onlinePeers().map((x) => `${x.id}（${x.me.n}）`).join("、") || "无"}。可以用 find_colleague 按姓名在钉钉里找`);
    if (!p.installed) throw new Error(`${p.me.n} 还没装 dsh-meeting-DD 助理（或还没回应），只能先给他发普通消息`);
    return p;
  }
  onlinePeers() { return Object.values(this.peers).filter((p) => p.installed && !p.clash); }
  nameOf(id) { return id === this.me?.id ? this.me.n : this.peers[id]?.me?.n || SEEDS.personas.find((p) => p.id === id)?.me.n || id; }
  // 公司通讯录：钉钉同事（带「已接入」状态）；本人选的是示例人物时，再加上示例公司里的其他人。本人不在内。
  directory() {
    const out = new Map();

    for (const p of Object.values(this.peers)) out.set(p.id, { ...out.get(p.id), ...p.me, dt: p.dtName });
    if (this.me) out.delete(this.me.id);
    return [...out.values()].map((m) => ({ ...m, online: !!this.peers[m.id]?.online && !this.peers[m.id]?.clash, reach: !!this.peers[m.id] }));
  }

  /* ============================== 人和人的消息（@ 私聊 / 群聊），不经过助理 ============================== */
  // 「@小美@阿杰 周五记得带伞」→ { ids: [mei, jie], text: "周五记得带伞" }。名字或 id 都行，最长匹配。
  parseMentions(text) {
    const people = this.directory().flatMap((m) => [[m.n, m.id], [m.id, m.id]]).sort((a, b) => b[0].length - a[0].length);
    const ids = [];
    const rest = String(text).replace(/@\s*([^\s@，,：:]+)/g, (all, word) => {
      const hit = people.find(([k]) => word.toLowerCase().startsWith(k.toLowerCase()));
      if (!hit) return all;
      if (!ids.includes(hit[1])) ids.push(hit[1]);
      return word.slice(hit[0].length);
    });
    return { ids, text: rest.replace(/^[\s，,：:]+/, "").trim() };
  }
  // 通过钉钉单聊发给某个同事（对方即使没装助理，也能在钉钉里看到文字）。钉钉发送失败就进发件箱，每分钟重试。
  humanLine(body) {
    if (body.kind === "dm") return (body.msg.bot ? "（助理代发）" : "") + body.msg.x;
    const g = body.meta, m = body.msg;
    if (!m) return `【群·${g.name}】群成员有变化：${g.members.map((x) => g.names?.[x] || x).join("、")}`;
    return `【群·${g.name}】${m.from === "sys" ? m.x : (m.bot ? "（助理代发）" : "") + m.x}`;
  }
  async postPeer(id, body) {
    const p = this.peers[id];
    if (!p?.openId) throw new Error(`${this.nameOf(id)} 不在钉钉同事里：先在「👥 同事」页按姓名搜索并添加`);
    try { await this.wireSend(p.openId, this.humanLine(body), { k: body.kind, ...body, info: this.info() }); return true; }
    catch (e) {
      this.S.outbox.push({ to: id, openId: p.openId, mid: body.msg?.id, body, t: nowIso(), err: e.message });
      if (this.S.outbox.length > 300) this.S.outbox.splice(0, this.S.outbox.length - 300);
      this.emit("outbox", { outbox: this.S.outbox.map((o) => ({ to: o.to, mid: o.mid })) });
      return false;
    }
  }
  async flushOutbox() {
    if (this.flushing || !this.S.outbox.length || this.dt.state !== "ready") return;
    this.flushing = true;
    try {
      const keep = [];
      for (const o of this.S.outbox) {
        try { await this.wireSend(o.openId, this.humanLine(o.body), { k: o.body.kind, ...o.body, info: this.info() }); }
        catch (e) { o.err = e.message; keep.push(o); }
      }
      if (keep.length !== this.S.outbox.length) { this.S.outbox = keep; this.emit("outbox", { outbox: keep.map((o) => ({ to: o.to, mid: o.mid })) }); }
    } finally { this.flushing = false; }
  }
  dmPush(peerId, msg) {
    const list = (this.S.dms[peerId] ||= []);
    if (list.some((m) => m.id === msg.id)) return false;
    list.push(msg);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.emit("dm", { peer: peerId, msg });
    return true;
  }
  // 私聊：发给一个或多个人（各自一个对话）。byBot = 助理替本人发的
  async sendDM(ids, text, byBot = false) {
    if (!this.me) throw new Error("先选「我是谁」");
    ids = [...new Set(ids)].filter((id) => id && id !== this.me.id);
    if (!ids.length) throw new Error("要发给谁？用 @名字");
    if (!String(text || "").trim()) throw new Error("消息是空的");
    const res = [];
    for (const id of ids) {
      const msg = { id: `${this.me.id}.d${++this.S.seq}.${randomBytes(2).toString("hex")}`, from: this.me.id, to: id, x: String(text).trim(), t: nowIso(), bot: byBot || undefined };
      this.dmPush(id, msg);
      res.push({ to: id, name: this.nameOf(id), delivered: await this.postPeer(id, { kind: "dm", msg }) });
    }
    return res;
  }
  groupMeta(g) { return { id: g.id, name: g.name, owner: g.owner, members: g.members, names: g.names, ver: g.ver }; }
  namesOf(ids) { return Object.fromEntries(ids.map((id) => [id, this.nameOf(id)])); }
  groupSys(g, x) {
    const msg = { id: `${this.me.id}.s${++this.S.seq}.${randomBytes(2).toString("hex")}`, gid: g.id, from: "sys", x, t: nowIso() };
    g.msgs.push(msg);
    return msg;
  }
  async broadcastGroup(g, extra = {}) {
    const res = [];
    for (const id of g.members.filter((x) => x !== this.me.id)) res.push({ to: id, name: this.nameOf(id), delivered: await this.postPeer(id, { kind: "group", meta: this.groupMeta(g), ...extra }) });
    return res;
  }
  async createGroup(name, ids) {
    if (!this.me) throw new Error("先选「我是谁」");
    const members = [this.me.id, ...new Set(ids.filter((x) => x && x !== this.me.id))];
    if (members.length < 2) throw new Error("至少拉一个人进群");
    const g = { id: `g-${this.me.id}-${Date.now().toString(36)}`, name: String(name || "").trim() || members.map((x) => this.nameOf(x)).join("、").slice(0, 20), owner: this.me.id, members, ver: 1, msgs: [], t: nowIso() };
    g.names = this.namesOf(members);
    const sys = this.groupSys(g, `${this.me.n} 创建了群聊，成员：${members.map((x) => g.names[x]).join("、")}`);
    this.S.groups[g.id] = g;
    this.emit("group", { group: g });
    return { group: this.groupMeta(g), sent: await this.broadcastGroup(g, { msg: sys }) };
  }
  async inviteGroup(gid, ids) {
    const g = this.S.groups[gid];
    if (!g) throw new Error("没有这个群");
    const add = [...new Set(ids)].filter((x) => x && !g.members.includes(x));
    if (!add.length) throw new Error("这些人已经在群里了");
    g.members.push(...add); g.ver++; g.names = this.namesOf(g.members);
    const sys = this.groupSys(g, `${this.me.n} 邀请 ${add.map((x) => g.names[x]).join("、")} 加入了群聊`);
    this.emit("group", { group: g });
    return { group: this.groupMeta(g), sent: await this.broadcastGroup(g, { msg: sys }) };
  }
  async leaveGroup(gid) {
    const g = this.S.groups[gid];
    if (!g) return;
    g.members = g.members.filter((x) => x !== this.me.id); g.ver++;
    const sys = this.groupSys(g, `${this.me.n} 退出了群聊`);
    await this.broadcastGroup(g, { msg: sys });
    delete this.S.groups[gid];
    this.emit("group-gone", { gid });
  }
  async sendGroup(gid, text, byBot = false) {
    const g = this.S.groups[gid];
    if (!g) throw new Error(`没有这个群：${gid}。现有群：${Object.values(this.S.groups).map((x) => `${x.id}（${x.name}）`).join("、") || "无"}`);
    if (!String(text || "").trim()) throw new Error("消息是空的");
    const { ids } = this.parseMentions(text);
    const msg = { id: `${this.me.id}.g${++this.S.seq}.${randomBytes(2).toString("hex")}`, gid, from: this.me.id, x: String(text).trim(), t: nowIso(), at: ids.filter((x) => g.members.includes(x)), bot: byBot || undefined };
    g.msgs.push(msg);
    if (g.msgs.length > 500) g.msgs.splice(0, g.msgs.length - 500);
    this.emit("gmsg", { gid, msg });
    return { group: g.name, sent: await this.broadcastGroup(g, { msg }) };
  }
  // 对方节点发来的私聊 / 群消息 / 群成员变化
  onPeerMsg(b, pid) {
    if (!this.me) return;
    if (b.kind === "dm") {
      // 对方用的 persona id 是 msg.from；按钉钉身份归到同一个对话
      this.dmPush(pid, { ...b.msg, from: pid, to: this.me.id });
      return { ok: true };
    }
    if (b.kind === "group") {
      const m = b.meta;
      // 自己已不在群里（退群后的回声）：忽略
      if (!m?.members?.includes(this.me.id)) return { ok: true };
      let g = this.S.groups[m.id];
      if (!g) { g = { ...m, msgs: [], t: nowIso() }; this.S.groups[m.id] = g; this.emit("group", { group: g }); }
      else if (m.ver > g.ver) { Object.assign(g, { name: m.name, members: m.members, names: m.names, ver: m.ver }); this.emit("group", { group: g }); }
      if (b.msg && !g.msgs.some((x) => x.id === b.msg.id)) {
        g.msgs.push(b.msg);
        if (g.msgs.length > 500) g.msgs.splice(0, g.msgs.length - 500);
        this.emit("gmsg", { gid: g.id, msg: b.msg });
      }
      return { ok: true };
    }
  }

  /* ============================== 出站报文（钉钉） ============================== */
  async sendA2A(a) {
    const me = this.me;
    const to = [...new Set([].concat(a.to || []).map(String).filter((x) => x && x !== me.id))];
    if (!to.length) throw new Error("to 为空");
    if (!TYPES.includes(a.type)) throw new Error("type 必须是 " + TYPES.join("/"));
    if (this.dt.state !== "ready") throw new Error("钉钉还没连上（" + (this.dt.error || this.dt.state) + "），请本人在「👥 同事」页登录钉钉");
    const peers = to.map((id) => this.peerOf(id));
    const conv = a.conv || "conv-" + Date.now().toString(36);
    const group = this.logA2A({ dir: "out", conv, from: me.id, to: peers.map((p) => p.id), ty: a.type, x: a.text, p: a.payload || {} });
    this.setStatus(`⏳ 等回复 0/${to.length}`, "wait");
    const waitMs = (+this.cfg.replyTimeoutMin || 30) * 60 * 1000;
    let got = 0;
    const replies = await Promise.all(peers.map(async (p) => {
      const msgId = `${me.id}.${++this.S.seq}.${randomBytes(2).toString("hex")}`;
      const env = { k: "env", msg_id: msgId, from: me.id, to: p.id, type: a.type, conv, text: a.text, payload: a.payload || {}, run: this.S.run };
      const box = { reply: null };
      const replied = new Promise((resolve) => { box.resolve = resolve; });
      this.pending[msgId] = box;
      let reply;
      try {
        await this.wireSend(p.openId, `🤖 ${me.n}的助理 · ${TYPE_CN[a.type] || a.type}：${a.text}`, { ...env, info: this.info() });
        let timer;
        reply = await Promise.race([replied, new Promise((res) => { timer = setTimeout(() => res(null), waitMs); timer.unref?.(); })]);
        clearTimeout(timer);
        if (!reply) {
          this.upsertContact(p.openId, { timeout: true });
          reply = { type: "ERROR", text: `${p.me.n} 的助理 ${Math.round(waitMs / 60000)} 分钟没有回复（对方电脑上的 dsh 可能没开）`, payload: {} };
        }
      } catch (e) {
        reply = { type: "ERROR", text: e.message, payload: {} };
      }
      delete this.pending[msgId];
      got++;
      this.setStatus(got < to.length ? `⏳ 等回复 ${got}/${to.length}` : "🤖 汇总回复", got < to.length ? "wait" : "run");
      this.logA2A({ dir: "in", conv, from: p.id, to: [me.id], ty: reply.type, x: reply.text, p: reply.payload, re: group.id });
      return { from: p.id, name: p.me.n, type: reply.type, text: reply.text, payload: reply.payload };
    }));
    return { conv, replies };
  }

  /* ============================== 入站（钉钉来信） ============================== */
  onEnvelope(env, openId) {
    if (!this.me) return;
    const pid = this.peerIdOf(openId), p = this.peers[pid], sm = p?.me || { n: pid };
    if (this.S.inbound[env.msg_id]) return; // 重复投递
    this.S.inbound[env.msg_id] = { from: pid, openId, type: env.type, conv: env.conv, t: nowIso() };
    this.inboundBusy++;
    const done = () => { const ib = this.S.inbound[env.msg_id]; if (ib && !ib.done) { ib.done = true; this.inboundBusy = Math.max(0, this.inboundBusy - 1); this.kickDeferred(); } };
    setTimeout(done, 15 * 60 * 1000).unref();
    this.logA2A({ dir: "in", conv: env.conv, from: pid, to: [this.me.id], ty: env.type, x: env.text, p: env.payload });
    this.setStatus(`📥 收到 ${sm.n} 的 ${env.type}`, "run");
    const body = `【钉钉来信】
msg_id: ${env.msg_id}
from: ${pid}（${sm.n}的助理${sm.r ? "，" + sm.r : ""}${sm.dept ? "，" + sm.dept : ""}${sm.L ? "，L" + sm.L : ""}${sm.up ? "，上级 " + this.nameOf(sm.up) : ""}）
type: ${env.type}
conv: ${env.conv}
text: ${env.text}
payload: ${JSON.stringify(env.payload || {})}

请按协同规则处理，并调用 reply_ding（reply_to=${env.msg_id}）回复。`;
    this.deliverLocal(body, `${env.conv}__${pid}-${this.me.id}__${env.run || this.S.run}`).then(async (r) => {
      const ib = this.S.inbound[env.msg_id];
      // 助理没调 reply_ding 就结束了：用它最后的话兜底回一个 RCPT，免得对方一直等
      if (ib && !ib.replied) await this.runTool("reply_ding", { reply_to: env.msg_id, type: "RCPT", text: (r.text || "（对方助理未结构化回复）").slice(0, 160), payload: { raw: r.text } }).catch(() => {});
      this.setStatus("✓ 已处理", "ok");
    }).catch((e) => {
      this.chat({ from: "sys", x: `⚠ 处理 ${sm.n} 的 ${env.type} 失败：${e.message}` });
      this.runTool("reply_ding", { reply_to: env.msg_id, type: "RCPT", text: "（对方助理处理出错）" + e.message.slice(0, 120), payload: { error: true } }).catch(() => {});
      this.setStatus("⚠ 出错", "warn");
    }).finally(done);
  }
  onReply(r) {
    const box = this.pending[r.msg_id];
    if (!box) return;
    box.reply = { type: r.type, text: r.text, payload: r.payload || {} };
    box.resolve(box.reply);
  }

  /* ============================== 工具 ============================== */
  findEv(id) {
    const e = this.S.cal.find((x) => x.id === id);
    if (!e) throw new Error(`本人日程里没有 id=${id} 的会。现有：${this.S.cal.map((x) => `${x.id} ${E.dayLabel(x.d)} ${x.s} ${x.t}`).join("；") || "（空）"}`);
    return e;
  }
  pubEv = (e) => ({ id: e.id, date: E.dayLabel(e.d), slot: `${e.s}-${e.e}`, title: e.t, kind: e.k, kind_cn: KIND_CN[e.k],
    organizer: e.org ? this.nameOf(e.org) : undefined, participants: e.who?.map((x) => this.nameOf(x)), room: e.room, note: e.note });
  calChanged() { this.emit("cal", { cal: this.S.cal, prefs: this.S.prefs, exemptions: this.S.exemptions, profile: this.S.profile, roomBook: this.S.roomBook }); }
  datesArg(a) {
    let list = [].concat(a.dates || a.date || []).filter(Boolean);
    if (!list.length) throw new Error("请给 dates，例如 [\"10/22\"] 或 [\"周六\",\"周日\"]");
    return [...new Set(list.flatMap((x) => String(x).split(/[、,，]/)).map((x) => E.normDate(x)))].sort();
  }
  slotArg(a) {
    if (a.slot) return E.parseSlot(a.slot, a.date);
    if (!a.date || !a.start || !a.end) throw new Error("需要 slot（如 10/22(周四) 14:00-15:00），或 date + start + end");
    return { d: E.normDate(a.date), s: E.normTime(a.start), e: E.normTime(a.end) };
  }

  async runTool(name, a) {
    const S = this.S, me = this.me;
    if (!me) throw new Error("本人还没在手机页上选「我是谁」");
    switch (name) {
      case "whoami": {
        const d = new Date();
        return {
          me: { ...me, up: me.up ? `${me.up}（${this.nameOf(me.up)}）` : null }, now: `${E.ymd(d)} ${WD[d.getDay()]} ${E.F(d.getHours() * 60 + d.getMinutes())}`,
          colleagues_online: this.onlinePeers().map((p) => ({ id: p.id, name: p.me.n, role: p.me.r, dept: p.me.dept, level: "L" + p.me.L, up: p.me.up ? this.nameOf(p.me.up) : null })),
          colleagues_offline: Object.values(this.peers).filter((p) => !p.online).map((p) => `${p.id}（${p.me.n}${p.installed ? "，最近没回复" : "，还没接入助理，只能发普通消息"}）`),
          dingtalk: { state: this.dt.state, me: this.dt.self?.name || null },
          company: this.directory().map((m) => `${m.id} ${m.n} ${m.r} · ${m.dept || ""} · L${m.L}${m.up ? " · 上级 " + this.nameOf(m.up) : ""}${m.squad ? " · " + m.squad : ""}${m.online ? "" : " · 不在线"}`),
          groups: Object.values(S.groups).map((g) => ({ id: g.id, name: g.name, members: g.members.map((x) => this.nameOf(x)) })),
          history_available: !!S.history?.trim(), has_profile: !!S.profile,
          hint: "company 是全公司通讯录；只有 colleagues_online 里的人能发 send_ding 协商报文；不在里面的人先 find_colleague。层级：L 数字越小越高；同 L 是同级；dept 不同是跨部门；squad 是跨部门项目组。to 填同事 id。",
        };
      }
      case "my_calendar":
        return { owner: me.n, events: S.cal.map(this.pubEv), preferences: S.prefs.map(({ id, x, s, e, k }) => ({ id, x, slot: s ? `${s}-${e}` : undefined, kind: k || "行为偏好" })),
          exemptions: S.exemptions.map((x) => ({ slot: E.fmtSlot(x), note: x.note })), history_available: !!S.history?.trim(), profile_saved: !!S.profile };
      case "my_history":
        this.setStatus("📖 读本人记录", "run");
        return { owner: me.n, records: S.history || "（没有记录）" };
      case "my_profile":
        return { profile: S.profile && { ...S.profile, schedule: S.profile.schedule.map((x) => ({ ...x, date: E.dayLabel(x.d) })) } };
      case "save_profile": {
        const schedule = (a.schedule || []).map((x, i) => {
          const sl = x.slot ? E.parseSlot(x.slot, x.date || x.day) : { d: E.normDate(x.date || x.day), s: E.normTime(x.start), e: E.normTime(x.end) };
          if (E.T(sl.e) <= E.T(sl.s)) throw new Error(`第 ${i + 1} 条 ${x.what || ""} 结束时间要晚于开始时间`);
          return { ...sl, what: x.what || "", why: x.why || "", flex: ["hard", "owner_exemptible", "tentative"].includes(x.flex) ? x.flex : "hard" };
        });
        S.profile = { schedule, tea: a.tea || {}, diet: { hard: a.diet?.hard || [], soft: a.diet?.soft || [] }, notes: a.notes || "", t: nowIso() };
        this.calChanged();
        return { saved: true, schedule: schedule.map((x) => `${E.fmtSlot(x)} ${x.what}（${x.flex}）`) };
      }
      case "my_availability":
        return E.availability(S, this.datesArg(a), a.ignore || []);
      case "intersect_availability": {
        const parties = (a.parties || []).filter((p) => p.who && p.who !== me.id).map((p) => ({ ...p, ...(p.payload || {}) }));
        let dates = a.dates ? this.datesArg(a) : E.datesOfSlots(parties.flatMap((p) => [p.available, p.tentative, p.owner_exemptible]));
        if (!dates.length) throw new Error("没法从各方 payload 里看出日期，请给 dates");
        const mine = { who: me.id, ...E.availability(S, dates, a.ignore || []) };
        const r = E.intersect([mine, ...parties], +a.duration_min || 60, dates);
        S.board = { t: nowIso(), dates, board: r._board, common: r.common_slots, relax: r.relax_options };
        this.emit("board", { board: S.board });
        delete r._board;
        return r;
      }
      case "calendar_add": {
        const sl = this.slotArg(a);
        const e = { id: a.id, d: sl.d, s: sl.s, e: sl.e, t: a.title, k: a.kind || "busy", org: a.organizer || me.id, who: a.participants, room: a.room };
        if (!e.id || !e.t) throw new Error("需要 id 和 title");
        const booked = S.roomBook.find((b) => b.mid === a.id);
        if (booked) e.room = booked.room;
        S.cal = S.cal.filter((x) => x.id !== e.id);
        const conflicts = S.cal.filter((x) => x.k !== "bump" && E.overlaps(x, e)).map(this.pubEv);
        S.cal.push(e);
        S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
        this.calChanged();
        return { written: this.pubEv(e), conflicts, hint: conflicts.length ? "有冲突：按优先级 上级会 > 同级已定会 / 上报会 > 1on1 处理被挤掉的会" : "无冲突" };
      }
      case "calendar_update": {
        const e = this.findEv(a.id);
        if (a.kind) e.k = a.kind;
        if (a.slot || a.start || a.date) {
          const sl = a.slot ? E.parseSlot(a.slot, e.d) : { d: a.date ? E.normDate(a.date) : e.d, s: a.start ? E.normTime(a.start) : e.s, e: a.end ? E.normTime(a.end) : e.e };
          Object.assign(e, { d: sl.d, s: sl.s, e: sl.e });
        }
        if (a.title) e.t = a.title;
        if (a.room) e.room = a.room;
        if (a.note) e.note = a.note;
        S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
        this.calChanged();
        return { updated: this.pubEv(e) };
      }
      case "calendar_remove": {
        const e = this.findEv(a.id);
        S.cal = S.cal.filter((x) => x.id !== a.id);
        const n = S.roomBook.length;
        S.roomBook = S.roomBook.filter((b) => b.mid !== a.id);
        this.calChanged();
        return { removed: this.pubEv(e), room_released: n !== S.roomBook.length };
      }
      case "grant_exemption": {
        const ok = Object.values(S.asks).some((k) => k.answer && !["no", "expired"].includes(k.answer) && Date.now() - Date.parse(k.at || k.t) < 30 * 60 * 1000);
        if (!ok) throw new Error("本人还没有在手机上同意，不能豁免");
        const sl = this.slotArg(a);
        S.exemptions.push({ ...sl, note: a.note || "" });
        this.calChanged();
        return { exempted: E.fmtSlot(sl), note: a.note };
      }
      case "book_room": {
        const sl = this.slotArg(a), n = +a.attendees || 2;
        S.roomBook = S.roomBook.filter((b) => b.mid !== a.meeting_id);
        const free = [...SEEDS.rooms].filter((r) => r.cap >= n).sort((x, y) => x.cap - y.cap)
          .find((r) => !S.roomBook.some((b) => b.room === r.n && E.overlaps(b, sl)));
        if (!free) return { booked: false, reason: "该时段没有足够大的空会议室" };
        S.roomBook.push({ room: free.n, mid: a.meeting_id, t: a.title, ...sl, by: me.id });
        const ev = S.cal.find((x) => x.id === a.meeting_id);
        if (ev) ev.room = free.n;
        this.calChanged();
        return { booked: true, room: free.n, capacity: free.cap, note: "会议室名写进 CONFIRM / NOTICE 的 payload.room" };
      }
      case "shop_menus":
        return { rule: SEEDS.orderRule, place: SEEDS.place, sugar_levels: SEEDS.sugar, ice_levels: SEEDS.ice, shops: SEEDS.shops };
      case "tally_votes": {
        const ballots = (a.ballots || []).map((b) => ({ ...b, ...(b.payload || {}), who: b.who }));
        const r = E.tally(ballots, SEEDS.shops);
        S.tally = { t: nowIso(), ballots, ...r };
        this.emit("tally", { tally: S.tally });
        return r;
      }
      case "place_order": {
        const shop = SEEDS.shops.find((s) => s.id === String(a.shop || "").trim().toUpperCase()[0] || s.n === a.shop);
        if (!shop) throw new Error("shop 只能是 " + SEEDS.shops.map((s) => s.id).join(" / "));
        const items = (a.items || []).map((it) => ({ who: it.who, name_cn: this.nameOf(it.who), ...E.checkItem(shop, it, SEEDS.sugar, SEEDS.ice) }));
        const free = items.length >= 5;
        S.order = { t: nowIso(), shop: shop.id, shopName: shop.n, deliver_at: a.deliver_at || "", place: a.place || SEEDS.place, items,
          delivery_fee: free ? 0 : 6, total: items.reduce((k, x) => k + x.price, 0) + (free ? 0 : 6) };
        this.emit("order", { order: S.order });
        return { ordered: true, ...S.order, note: free ? "满 5 杯免配送费" : "不满 5 杯，配送费 6 元" };
      }
      case "send_ding": return this.sendA2A(a);
      case "find_colleague": {
        const list = await this.searchDingTalk(a.name);
        let pick = a.open_id ? list.find((x) => x.openId === a.open_id) : list.length === 1 ? list[0] : null;
        if (!pick) return { found: list.length, candidates: list.map((x) => ({ open_id: x.openId, name: x.name, dept: x.dept, title: x.title, added: x.added })),
          note: list.length ? "有多个同名候选：把候选告诉本人，请本人选，再带 open_id 调用" : "钉钉通讯录里没搜到这个名字（不代表这个人不存在），请本人核对" };
        if (!pick.added) await this.addContact(pick);
        const p = Object.values(this.peers).find((x) => x.openId === pick.openId);
        return { added: true, colleague: { id: p.id, name: p.me.n, installed: p.installed },
          note: p.installed ? "已接入，可以 send_ding" : "已在钉钉里向对方打招呼；对方电脑上的助理回应后才能 send_ding（通常几秒）。对方没装助理时，可以用 send_message 给对方本人发普通消息" };
      }
      case "send_message": {
        const text = String(a.text || "").trim();
        if (a.group) {
          const g = S.groups[a.group] || Object.values(S.groups).find((x) => x.name === a.group);
          if (!g) throw new Error(`没有这个群：${a.group}`);
          return this.sendGroup(g.id, text, true);
        }
        return { sent: await this.sendDM([].concat(a.to || []).map(String), text, true) };
      }
      case "my_messages": {
        const n = Math.min(+a.limit || 20, 100);
        const fmt = (m) => `${m.t.slice(5, 16).replace("T", " ")} ${m.from === "sys" ? "【系统】" : this.nameOf(m.from)}：${m.x}`;
        return {
          direct: Object.entries(S.dms).map(([id, list]) => ({ with: `${id}（${this.nameOf(id)}）`, recent: list.slice(-n).map(fmt) })),
          groups: Object.values(S.groups).map((g) => ({ id: g.id, name: g.name, members: g.members.map((x) => this.nameOf(x)), recent: g.msgs.slice(-n).map(fmt) })),
        };
      }
      case "reply_ding": {
        const inb = S.inbound[a.reply_to];
        if (!inb) throw new Error(`没有待回复的来信 ${a.reply_to}`);
        if (inb.replied) throw new Error("这条来信已经回复过了");
        if (!RTYPES.includes(a.type)) throw new Error("type 必须是 " + RTYPES.join("/"));
        inb.replied = true;
        const body = { k: "reply", msg_id: a.reply_to, from: me.id, type: a.type, text: a.text, payload: a.payload || {} };
        try { await this.wireSend(inb.openId, `🤖 ${me.n}的助理 · ${TYPE_CN[a.type] || a.type}：${a.text}`, { ...body, info: this.info() }); }
        catch (e) { inb.replied = false; throw e; }
        this.logA2A({ dir: "out", conv: inb.conv || "", from: me.id, to: [inb.from], ty: a.type, x: a.text, p: a.payload || {} });
        this.setStatus(`↩ 已回 ${a.type}`, "ok");
        return { ok: true, note: "回复已通过钉钉发出，处理完本条来信后结束本轮即可" };
      }
      case "ask_owner": {
        const id = "ask" + ++S.seq;
        const ask = { id, t: nowIso(), toast: a.toast, context: a.context, question: a.question, lines: a.lines || [],
          options: a.options?.length ? a.options : [{ key: "yes", label: "同意" }, { key: "no", label: "不同意" }] };
        S.asks[id] = ask;
        this.chat({ from: "bot", kind: "ask", ask });
        const prev = S.status;
        this.setStatus(`👤 等${me.n}决定`, "human");
        const answer = await new Promise((resolve) => { this.waiters[id] = resolve; });
        this.setStatus(prev.cls === "human" ? "🤖 处理中" : prev.x, prev.cls === "human" ? "run" : prev.cls);
        const opt = ask.options.find((o) => o.key === answer);
        return { owner_answer: answer, label: opt?.label || answer };
      }
      case "tell_owner":
        this.chat({ from: "bot", x: a.text, toast: a.toast, card: a.card });
        return { shown: true };
      case "defer_task": {
        const job = { id: "j" + ++S.seq, title: a.title, instruction: a.instruction };
        S.deferred.push(job);
        this.chat({ from: "sys", x: "🗓 助理安排了后台任务：" + a.title });
        return { scheduled: true, note: "会在你回复完当前来信后自动开始" };
      }
    }
    throw new Error("未知工具 " + name);
  }

  /* ============================== HTTP ============================== */
  async listen() {
    const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
    const readBody = (req) => new Promise((res, rej) => {
      const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { res(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { rej(e); } });
    });
    const mcp = mcpHandler(this);
    this.server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://x");
      const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }); res.end(JSON.stringify(o)); };
      const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      const isLocal = remote === "127.0.0.1" || remote === "::1";
      try {
        if (u.pathname === "/mcp") {
          if (!isLocal) return json({ error: "MCP 只对本机开放" }, 403);
          return mcp(req, res);
        }
        // ---- 手机页 ----
        if (u.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
          this.clients.add(res);
          const hb = setInterval(() => res.write(": hb\n\n"), 15000);
          req.on("close", () => { this.clients.delete(res); clearInterval(hb); });
          return;
        }
        if (u.pathname === "/api/state") return json(this.snapshot());
        if (req.method === "POST") {
          // 防跨站：只接受本机页面（或 DSH 网页里的 iframe）发起的写操作
          const origin = req.headers.origin;
          if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin) && !(this.cfg.allowOrigins || []).includes(origin)) return json({ error: "不接受来自 " + origin + " 的请求" }, 403);
          const b = await readBody(req);
          switch (u.pathname) {
            case "/api/setup": this.setup(b); return json({ ok: true });
            case "/api/say": if (!b.text) return json({ error: "空消息" }, 400); if (!this.me) return json({ error: "先选「我是谁」" }, 400); this.ownerSay(b.text); return json({ ok: true });
            case "/api/answer": this.ownerAnswer(b.askId, b.key); return json({ ok: true });
            case "/api/dm": return json({ ok: true, sent: await this.sendDM([].concat(b.to || []), b.text) });
            case "/api/group/create": return json({ ok: true, ...(await this.createGroup(b.name, [].concat(b.members || []))) });
            case "/api/group/invite": return json({ ok: true, ...(await this.inviteGroup(b.gid, [].concat(b.members || []))) });
            case "/api/group/leave": await this.leaveGroup(b.gid); return json({ ok: true });
            case "/api/group/send": return json({ ok: true, ...(await this.sendGroup(b.gid, b.text)) });
            case "/api/reset": this.resetRound(!!b.reseed); return json({ ok: true });
            case "/api/dt/search": return json({ ok: true, list: await this.searchDingTalk(b.q) });
            case "/api/dt/add": return json({ ok: true, peer: await this.addContact(b) });
            case "/api/dt/discover": return json({ ok: true, ...(await this.discover(true)) });
            case "/api/me": { if (!this.me) throw new Error("先登录"); for (const k of ["n", "r", "dept"]) if (typeof b[k] === "string" && b[k].trim()) this.S.me[k] = b[k].trim(); if ([1, 2, 3].includes(+b.L)) this.S.me.L = +b.L; this.S.me.a = this.S.me.n.slice(0, 1); this.emit("reset"); this.onIdentity(); return json({ ok: true }); }
            case "/api/regen": this.regenerate(); return json({ ok: true });
            case "/api/dt/ping": { const p = this.peers[b.id]; if (!p) throw new Error("没有这个同事"); await this.wireSend(p.openId, "（助理自动消息）检查助理是否在线", { k: "hello", ask: true, info: this.info() }); return json({ ok: true }); }
            case "/api/dt/creds": this.saveCreds(b); return json({ ok: true });
            case "/api/dt/login": return json({ ok: true, ...this.startLogin(!!b.custom) });
            case "/api/dt/connect": await this.connect(); return json({ ok: true, dt: this.pubDt() });
            case "/api/peers/forget": this.forgetContact(b.id); return json({ ok: true });
            case "/api/history": this.S.history = String(b.text || ""); this.S.profile = null; this.calChanged(); return json({ ok: true });
            case "/api/cal/add": { const sl = this.slotArg(b); this.S.cal.push({ id: "m" + ++this.S.seq, ...sl, t: b.title || "忙", k: "busy", org: this.me?.id }); this.S.cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s)); this.calChanged(); return json({ ok: true }); }
            // 测试 / 演示用：整份替换本人日程和会议室预订（只有本机能访问）
            case "/api/dev/cal": if (Array.isArray(b.cal)) this.S.cal = b.cal; if (Array.isArray(b.roomBook)) this.S.roomBook = b.roomBook; if (Array.isArray(b.prefs)) this.S.prefs = b.prefs; this.S.exemptions = []; this.calChanged(); return json({ ok: true });
            case "/api/cal/remove": this.S.cal = this.S.cal.filter((x) => x.id !== b.id); this.calChanged(); return json({ ok: true });
          }
        }
        // 静态文件
        const p = u.pathname === "/" ? "/index.html" : u.pathname;
        const file = path.join(WEB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
        if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
          return fs.createReadStream(file).pipe(res);
        }
        json({ error: "not found" }, 404);
      } catch (e) {
        json({ error: e.message }, 500);
      }
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.cfg.port, this.cfg.host, resolve); });
    console.log(`[dsh-meeting-dd] 手机页 http://127.0.0.1:${this.cfg.port}/  钉钉通道：${this.link.kind === "loop" ? "本机测试信箱 " + (this.cfg.loopDir || process.env.DSH_MEETING_DD_LOOP) : "DWS"}`);
  }
  async start() {
    await this.listen();
    this.connect();
    this.flushT = setInterval(() => this.flushOutbox().catch(() => {}), 60000);
  }
  async stop() {
    clearInterval(this.flushT);
    for (const k of Object.keys(this.waiters)) { this.waiters[k]("no"); delete this.waiters[k]; }
    for (const res of this.clients) res.end();
    try { this.loginChild?.kill(); } catch {}
    await this.link.stop().catch(() => {});
    await this.runner?.stop?.().catch(() => {});
    this.server?.closeAllConnections?.();
    await new Promise((r) => this.server ? this.server.close(() => r()) : r());
    clearTimeout(this._saveT);
    try { fs.writeFileSync(this.file, JSON.stringify(this.S)); } catch {}
  }
}
