// dsh-meeting 手机页：状态全部来自本机节点（/api/state + SSE）。
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const T = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dayLabel = (s) => { const d = fromYmd(s); return `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`; };
const winOf = (s) => ([0, 6].includes(fromYmd(s).getDay()) ? ["09:00", "21:00"] : ["09:00", "18:00"]);
const TY = {
  NOTICE: { c: "#b69cff", n: "通知" }, RCPT: { c: "#9fb8b5", n: "回执" }, SYN: { c: "#5ad1ff", n: "① 请求" },
  "SYN-ACK": { c: "#ffb85c", n: "② 回可用" }, PROPOSE: { c: "#ff8fc8", n: "③ 提案" }, ACK: { c: "#7fe3c0", n: "确认" },
  RELAX: { c: "#ff9a5c", n: "松绑请求" }, CONFIRM: { c: "#4fd69c", n: "定稿" }, ERROR: { c: "#ff7f6e", n: "错误" },
  REPORT: { c: "#5aaeff", n: "上报" }, DECIDE: { c: "#4fd69c", n: "拍板" }, VOTE: { c: "#ffd27a", n: "投票" }, BALLOT: { c: "#d8e58f", n: "选票" },
};
const KIND = { busy: "原有", one: "1on1", lead: "上级会", peer: "已定", up: "上报会", hold: "暂锁", bump: "被挤掉" };
const FLEX = { hard: "走不开", owner_exemptible: "本人点头可让", tentative: "勉强" };

let S = null, tab = "chat", day = null, sel = null, lastChat = 0, toastT;
let thread = null, groupForm = null, inviting = false, lastThreadLen = 0; // thread: "dm:<id>" | "g:<gid>"
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "HTTP " + r.status);
  return j;
};
const person = (id) => (id === S.me?.id ? S.me : S.directory.find((m) => m.id === id) || S.peers.find((p) => p.id === id)?.me || { id, n: id, a: "?", c: "#ddd" });
const nameOf = (id) => person(id).n;

async function load() {
  S = await (await fetch("/api/state")).json();
  S.dms ||= {}; S.groups ||= {}; S.directory ||= []; S.outbox ||= [];
  if (thread && !threadMsgs(thread).length && thread.startsWith("g:") && !S.groups[thread.slice(2)]) thread = null;
  render();
}
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (!S) return;
    switch (ev.type) {
      case "hello": case "reset": return load();
      case "chat": S.chat.push(ev.msg); if (ev.msg.ask) S.asks.push(ev.msg.ask); notifyChat(ev.msg); break;
      case "status": S.status = ev.status; break;
      case "cal": Object.assign(S, { cal: ev.cal, prefs: ev.prefs, exemptions: ev.exemptions, profile: ev.profile, roomBook: ev.roomBook }); break;
      case "a2a": S.a2a.push(ev.rec); break;
      case "peers": S.peers = ev.peers; refreshDirectory(); break;
      case "dt": S.dt = ev.dt; break;
      case "answer": { const a = S.asks.find((x) => x.id === ev.askId); if (a) a.answer = ev.key; break; }
      case "board": S.board = ev.board; break;
      case "tally": S.tally = ev.tally; break;
      case "order": S.order = ev.order; break;
      case "dm": { const l = (S.dms[ev.peer] ||= []); if (!l.some((m) => m.id === ev.msg.id)) l.push(ev.msg); notifyMsg("dm:" + ev.peer, ev.msg); break; }
      case "gmsg": { const g = S.groups[ev.gid]; if (g && !g.msgs.some((m) => m.id === ev.msg.id)) g.msgs.push(ev.msg); notifyMsg("g:" + ev.gid, ev.msg); break; }
      case "group": S.groups[ev.group.id] = { ...S.groups[ev.group.id], ...ev.group }; break;
      case "group-gone": delete S.groups[ev.gid]; if (thread === "g:" + ev.gid) { thread = null; syncInput(); } break;
      case "outbox": S.outbox = ev.outbox; break;
      default: return;
    }
    render();
  };
  es.onerror = () => { $(".st").textContent = "⚠ 连不上本机节点"; $(".st").className = "st warn"; };
}

function toast(title, sub) {
  const t = $(".toast");
  t.innerHTML = `<b>${esc(title)}</b>${esc(sub || "")}`;
  t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 4000);
  try { if (document.hidden && Notification.permission === "granted") new Notification(title, { body: sub || "" }); } catch {}
}
function notifyChat(m) {
  if (m.ask) toast(m.ask.toast || "👤 需要你决定", m.ask.question);
  else if (m.toast) toast(m.toast, m.x?.slice(0, 40));
}


/* ---------------- 消息：私聊 / 群聊 ---------------- */
function refreshDirectory() {
  const on = new Set(S.peers.filter((p) => p.online && !p.clash).map((p) => p.id));
  for (const m of S.directory) m.online = on.has(m.id);
  for (const m of S.directory) m.reach = S.peers.some((p) => p.id === m.id);
  for (const p of S.peers) if (!S.directory.some((m) => m.id === p.id) && p.id !== S.me?.id) S.directory.push({ ...p.me, online: on.has(p.id), reach: true });
}
const seenKey = () => "dsh-meeting:seen:" + (S.me?.id || "");
function seenMap() { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}"); } catch { return {}; } }
function markSeen(key) {
  const m = seenMap(), list = threadMsgs(key);
  if (!list.length) return;
  m[key] = list[list.length - 1].t;
  try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch {}
}
function threadMsgs(key) {
  if (key.startsWith("dm:")) return S.dms[key.slice(3)] || [];
  return S.groups[key.slice(2)]?.msgs || [];
}
function unreadOf(key, seen = seenMap()) {
  const t = seen[key] || "";
  return threadMsgs(key).filter((m) => m.t > t && m.from !== S.me?.id && m.from !== "sys").length;
}
function threads() {
  const seen = seenMap();
  const list = [
    ...Object.keys(S.dms).map((id) => ({ key: "dm:" + id, title: nameOf(id), p: person(id) })),
    ...Object.values(S.groups).map((g) => ({ key: "g:" + g.id, title: g.name, group: g })),
  ];
  for (const x of list) { const m = threadMsgs(x.key); x.last = m[m.length - 1]; x.unread = unreadOf(x.key, seen); }
  return list.sort((a, b) => (b.last?.t || b.group?.t || "").localeCompare(a.last?.t || a.group?.t || ""));
}
function notifyMsg(key, m) {
  if (m.from === S.me?.id) return;
  if (tab === "msg" && thread === key && !document.hidden) { markSeen(key); return; }
  const g = key.startsWith("g:") ? S.groups[key.slice(2)] : null;
  if (m.from === "sys") return;
  const atMe = (m.at || []).includes(S.me?.id);
  toast(g ? (atMe ? `📣 ${nameOf(m.from)} 在「${g.name}」里@了你` : `💭 ${g.name} · ${nameOf(m.from)}`) : `💭 ${nameOf(m.from)}`, m.x.slice(0, 60));
}
// 把 @名字 高亮
function richText(x) {
  const names = [S.me, ...S.directory].filter(Boolean).map((m) => m.n).sort((a, b) => b.length - a.length);
  let out = esc(x);
  if (names.length) out = out.replace(new RegExp("@(" + names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g"), '<span class="at">@$1</span>');
  return out;
}
function avHtml(p, cls = "") { return `<span class="av ${cls}" style="background:${esc(p.c || "#ddd")}">${esc(p.a || "?")}</span>`; }
function pickHtml(exclude = []) {
  const ppl = S.directory.filter((m) => !exclude.includes(m.id));
  const depts = [...new Set(ppl.map((m) => m.dept || "其他"))];
  return `<div class="pick">${depts.map((d) => `<div class="dp">${esc(d)}</div>` + ppl.filter((m) => (m.dept || "其他") === d).sort((a, b) => b.online - a.online || a.L - b.L)
    .map((m) => `<label><input type="checkbox" value="${esc(m.id)}"><span class="pd ${m.online ? "on" : ""}"></span>${avHtml(m)}${esc(m.n)} <span class="dim">${esc(m.r)}</span></label>`).join("")).join("")}</div>`;
}
function renderMsg() {
  const v = $(".v-msg");
  if (v.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "checkbox") return;
  if (groupForm) {
    v.innerHTML = `<div class="th-hdr"><button class="back">‹</button><b>新建群聊</b></div>
      <div class="pcard"><div class="row2"><input class="g-name" placeholder="群名（可不填）" value="${esc(groupForm.name || "")}"></div>
      <div class="row2 dim">拉谁进群（不在线的人上线后会收到）</div>${pickHtml()}
      <div class="row2"><button class="pbtn g-ok">创建</button><span class="err g-err"></span></div></div>`;
    $(".back", v).onclick = () => { groupForm = null; syncInput(); renderMsg(); };
    $(".g-name", v).oninput = (e) => (groupForm.name = e.target.value);
    $(".g-ok", v).onclick = () => {
      const members = $$(".pick input:checked", v).map((x) => x.value);
      post("/api/group/create", { name: $(".g-name", v).value, members })
        .then((r) => { S.groups[r.group.id] ||= { ...r.group, msgs: [] }; openThread("g:" + r.group.id); })
        .catch((e) => ($(".g-err", v).textContent = e.message));
    };
    return;
  }
  if (!thread) {
    const list = threads();
    v.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><button class="pbtn g-new" style="white-space:nowrap">➕ 新建群聊</button><span style="font-size:10.5px;color:var(--phone-dim);line-height:1.35">私聊：助理页输入 @名字，或在 👥 通讯录点「私聊」</span></div>`
      + (list.length ? list.map((x) => `<div class="thr" data-k="${esc(x.key)}">${x.group ? '<span class="av gav">👥</span>' : avHtml(x.p)}
        <div class="tx"><div class="tt">${esc(x.title)}${x.group ? ` <span class="dim" style="font-weight:400;font-size:11px">${x.group.members.length} 人</span>` : ""}<small>${x.last ? esc(new Date(x.last.t).toTimeString().slice(0, 5)) : ""}</small></div>
        <div class="lm">${x.last ? esc((x.last.from === "sys" ? "" : x.last.from === S.me?.id ? "我：" : nameOf(x.last.from) + "：") + x.last.x) : "（还没有消息）"}</div></div>${x.unread ? `<span class="ub">${x.unread}</span>` : ""}</div>`).join("")
        : `<div class="empty" style="color:var(--phone-dim)">还没有消息。<br>在助理页输入「@小美 周五记得带伞」就直接发给小美；@A@B 就是同时发给两个人。</div>`);
    $(".g-new", v).onclick = () => { groupForm = { name: "" }; syncInput(); renderMsg(); };
    $$(".thr", v).forEach((t) => (t.onclick = () => openThread(t.dataset.k)));
    return;
  }
  const isG = thread.startsWith("g:"), g = isG ? S.groups[thread.slice(2)] : null;
  if (isG && !g) { thread = null; return renderMsg(); }
  const peerId = isG ? null : thread.slice(3), p = peerId && person(peerId);
  const pend = new Set((S.outbox || []).map((o) => o.mid));
  const msgs = threadMsgs(thread);
  let h = `<div class="th-hdr"><button class="back">‹</button><b>${isG ? esc(g.name) + ` <small>${g.members.length} 人</small>` : esc(p.n) + ` <small>${esc(p.r || "")}${S.directory.find((m) => m.id === peerId)?.online ? " · 在线" : " · 不在线"}</small>`}</b>
    ${isG ? '<button class="pbtn g g-inv">＋拉人</button><button class="pbtn g g-quit">退出</button>' : ""}</div>`;
  if (isG && inviting) h += `<div class="pcard"><h4>拉人进「${esc(g.name)}」</h4>${pickHtml(g.members)}<div class="row2"><button class="pbtn i-ok">邀请</button><button class="pbtn g i-no">取消</button><span class="err i-err"></span></div></div>`;
  if (isG) h += `<div class="msg sys">成员：${g.members.map((x) => esc(g.names?.[x] || nameOf(x))).join("、")}</div>`;
  h += msgs.map((m) => {
    if (m.from === "sys") return `<div class="msg sys">${esc(m.x)}</div>`;
    const mine = m.from === S.me?.id, who = person(m.from);
    const atMe = (m.at || []).includes(S.me?.id);
    return `<div class="pm ${mine ? "mine" : "theirs"}">${!mine && isG ? `<span class="who">${esc(who.n)}</span>` : ""}<div class="msg ${mine ? "me" : "bot"} ${atMe ? "atme" : ""}">${richText(m.x)}</div>
      <span class="meta">${esc(new Date(m.t).toTimeString().slice(0, 5))}${m.bot ? " · 助理代发" : ""}${mine && pend.has(m.id) ? " · ⏳ 对方不在线，上线后送达" : ""}</span></div>`;
  }).join("") || `<div class="msg sys">说点什么吧</div>`;
  const near = v.scrollHeight - v.scrollTop - v.clientHeight < 80;
  v.innerHTML = h;
  if (near || msgs.length !== lastThreadLen) v.scrollTop = v.scrollHeight;
  lastThreadLen = msgs.length;
  markSeen(thread);
  $(".back", v).onclick = () => { thread = null; inviting = false; syncInput(); render(); };
  if (isG) {
    $(".g-inv", v).onclick = () => { inviting = !inviting; renderMsg(); };
    $(".g-quit", v).onclick = () => confirm(`退出「${g.name}」？`) && post("/api/group/leave", { gid: g.id }).then(() => { thread = null; syncInput(); render(); });
    const ok = $(".i-ok", v);
    if (ok) {
      ok.onclick = () => post("/api/group/invite", { gid: g.id, members: $$(".pick input:checked", v).map((x) => x.value) }).then(() => { inviting = false; render(); }).catch((e) => ($(".i-err", v).textContent = e.message));
      $(".i-no", v).onclick = () => { inviting = false; renderMsg(); };
    }
  }
}
function openThread(key) {
  thread = key; inviting = false; groupForm = null; lastThreadLen = 0;
  switchTab("msg");
}
function renderBadge() {
  const seen = seenMap();
  const n = [...Object.keys(S.dms).map((id) => "dm:" + id), ...Object.keys(S.groups).map((g) => "g:" + g)].reduce((k, key) => k + (tab === "msg" && thread === key ? 0 : unreadOf(key, seen)), 0);
  const b = $(".badge"); b.hidden = !n; b.textContent = n > 99 ? "99+" : n;
}

/* ---------------- @ 选人 ---------------- */
let menIdx = 0;
function mentionCands() {
  if (tab === "msg" && thread?.startsWith("g:")) {
    const g = S.groups[thread.slice(2)];
    return (g?.members || []).filter((x) => x !== S.me?.id).map((x) => person(x));
  }
  return [...S.directory].sort((a, b) => b.online - a.online);
}
function updateMention() {
  const box = $(".mention"), inp = $(".inp input");
  const m = inp.value.slice(0, inp.selectionStart).match(/@([^\s@]*)$/);
  if (!m) { box.hidden = true; return; }
  const q = m[1].toLowerCase();
  const list = mentionCands().filter((p) => !q || p.n.toLowerCase().includes(q) || p.id.toLowerCase().startsWith(q) || (p.dept || "").includes(q)).slice(0, 30);
  if (!list.length) { box.hidden = true; return; }
  menIdx = Math.min(menIdx, list.length - 1);
  box.innerHTML = list.map((p, i) => `<div data-id="${esc(p.id)}" class="${i === menIdx ? "on" : ""}">${avHtml(p)}${esc(p.n)}<small>${esc(p.r || "")}${p.dept ? " · " + esc(p.dept) : ""}${p.online ? "" : " · 不在线"}</small></div>`).join("");
  box.hidden = false;
  $$("div", box).forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); pickMention(d.dataset.id); }));
}
function pickMention(id) {
  const inp = $(".inp input"), pos = inp.selectionStart;
  const before = inp.value.slice(0, pos).replace(/@([^\s@]*)$/, "@" + nameOf(id) + " ");
  inp.value = before + inp.value.slice(pos);
  inp.setSelectionRange(before.length, before.length);
  $(".mention").hidden = true; menIdx = 0;
  inp.focus();
}

/* ---------------- 手机 ---------------- */
function renderHeader() {
  const me = S.me;
  const d = new Date();
  $(".clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const av = $(".hdr .av");
  av.textContent = me?.a || "?"; av.style.background = me?.c || "#ddd";
  $(".nm").textContent = me ? `${me.n}的助理` : "九派私人助理";
  $(".rl").textContent = me ? `${me.r}${me.dept ? " · " + me.dept : ""}${S.dt?.self?.corp ? " · " + S.dt.self.corp : ""}` : "扫码登录钉钉后开始";
  const st = $(".st"); st.textContent = S.status.x; st.className = "st " + S.status.cls;
  document.title = me ? `九派 · ${me.n}的助理` : "九派 · 私人助理";
}

function msgHtml(m) {
  if (m.from === "me") return `<div class="msg me${m.tap ? " tap" : ""}">${esc(m.x)}</div>`;
  if (m.from === "sys") return `<div class="msg sys">${esc(m.x)}</div>`;
  if (m.kind === "ask") {
    const a = S.asks.find((x) => x.id === m.ask.id) || m.ask;
    const ans = a.answer || (S.asks.some((x) => x.id === a.id) ? null : "（已处理）");
    return `<div class="msg bot">${esc(a.context || "")}<div class="mcard ask" data-ask="${a.id}">
      <div class="q">${esc(a.question)}</div>${(a.lines || []).map((l) => `<div class="ln">${esc(l)}</div>`).join("")}
      <div class="btns">${a.options.map((o, i) => `<button data-k="${esc(o.key)}" class="${i === 0 ? "p" : ""}" ${ans ? "disabled" : ""}>${esc(o.label)}</button>`).join("")}</div>
      ${ans ? `<div class="done">✓ ${a.answer === "expired" ? "已失效" : "已选择：" + esc(a.options.find((o) => o.key === a.answer)?.label || ans)}</div>` : ""}</div></div>`;
  }
  const c = m.card;
  return `<div class="msg bot">${esc(m.x)}${c ? `<div class="mcard"><b>📅 ${esc(c.title)}</b>${esc(c.when || "")}${c.who ? `<br>👥 ${esc(c.who)}` : ""}${c.room ? `<br>📍 ${esc(c.room)}` : ""}${c.note ? `<br><span style="color:#6c7f80">${esc(c.note)}</span>` : ""}</div>` : ""}</div>`;
}
function renderChat() {
  const body = $(".v-chat");
  const near = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const items = S.chat.map((m) => ({ t: m.t, html: msgHtml(m) }));
  for (const r of S.a2a) {
    const ty = TY[r.ty]?.n || r.ty;
    const peer = r.dir === "out" ? "→ " + r.to.map(nameOf).join("、") : "← " + nameOf(r.from);
    items.push({ t: r.t, html: `<div class="msg sys">📡 ${esc(r.ty)} ${esc(ty)} ${esc(peer)}：${esc(r.x)}</div>` });
  }
  items.sort((a, b) => a.t.localeCompare(b.t));
  let html = items.map((i) => i.html).join("");
  if (!S.chat.some((m) => m.from === "me")) {
    html += `<div class="msg sys">${S.dt?.state !== "ready" ? "钉钉还没连上：先去 👥 页登录钉钉。" : S.peers.filter((p) => p.online).length ? `有 ${S.peers.filter((p) => p.online).length} 位同事的助理已接入钉钉协商（👥 页）。` : "还没有发现装了助理的同事：在 👥 页搜索或「重新发现」，也可以直接对助理说「约 张三 …」。"}在下面直接说，或用「@某人 …」让助理去找他的助理办。比如：</div>`;
    html += (S.openers || []).map((o) => `<div class="chip">🎙 ${esc(o)}</div>`).join("");
  }
  if (["run", "wait"].includes(S.status.cls)) html += `<div class="typing">${esc(S.status.x)} …</div>`;
  body.innerHTML = html;
  $$(".chip", body).forEach((c) => (c.onclick = () => say(c.textContent.replace(/^🎙 /, ""))));
  $$(".ask", body).forEach((card) => $$("button", card).forEach((b) => (b.onclick = () => {
    $$("button", card).forEach((x) => (x.disabled = true));
    post("/api/answer", { askId: card.dataset.ask, key: b.dataset.k });
  })));
  if (near || items.length !== lastChat) body.scrollTop = body.scrollHeight;
  lastChat = items.length;
}

function calDays() {
  const s = new Set(S.cal.map((e) => e.d));
  const base = new Date();
  for (let i = 0; i < 7; i++) { const d = new Date(base); d.setDate(d.getDate() + i); s.add(ymd(d)); }
  for (const x of S.profile?.schedule || []) s.add(x.d);
  return [...s].sort().filter((d) => d >= ymd(base));
}
function renderCal() {
  const days = calDays();
  if (!day || !days.includes(day)) day = S.cal.find((e) => e.d >= ymd(new Date()))?.d || days[0];
  const [ws, we] = winOf(day).map(T), H = Math.max(520, ((we - ws) / 60) * 58), y = (m) => ((T(m) - ws) / (we - ws)) * H;
  let h = `<div class="days">${days.map((d) => `<span data-d="${d}" class="${d === day ? "on" : ""} ${S.cal.some((e) => e.d === d) ? "has" : ""}">${esc(dayLabel(d))}</span>`).join("")}</div>`;
  const legend = `<div class="legend">${["lead", "peer", "up", "one", "hold", "bump", "busy"].map((k) => `<span><i class="k-${k}"></i>${KIND[k]}</span>`).join("")}<span><i style="background:#ffd9ec"></i>偏好/档案</span></div>`;
  h += `<div class="calwrap"><div class="calmain"><div class="cal" style="height:${H}px">`;
  for (let m = ws; m <= we; m += 60) h += `<div class="hr" style="top:${((m - ws) / (we - ws)) * H}px"><span>${pad(m / 60)}:00</span></div>`;
  const weekend = [0, 6].includes(fromYmd(day).getDay());
  for (const p of S.prefs) if (p.s && p.k && !(p.days === "weekday" && weekend)) h += `<div class="pf ${p.k}" style="top:${y(p.s)}px;height:${y(p.e) - y(p.s)}px">${esc(p.x)}</div>`;
  for (const x of S.profile?.schedule || []) if (x.d === day) h += `<div class="pf ${x.flex === "hard" ? "" : x.flex === "owner_exemptible" ? "human" : "soft"}" style="top:${y(x.s)}px;height:${Math.max(14, y(x.e) - y(x.s))}px">${esc(x.what)}（${FLEX[x.flex]}）</div>`;
  for (const x of S.exemptions) if (x.d === day) h += `<div class="pf exempt" style="top:${y(x.s)}px;height:${y(x.e) - y(x.s)}px">✓ 本人同意让出 · ${esc(x.note)}</div>`;
  for (const e of S.cal.filter((e) => e.d === day)) {
    h += `<div class="ev k-${e.k}" style="top:${y(e.s)}px;height:${Math.max(16, y(e.e) - y(e.s) - 1)}px" title="${esc(e.id)}">${esc(e.s)}–${esc(e.e)} ${esc(e.t)}<small>${esc(KIND[e.k] || "")}${e.room ? " · " + esc(e.room) : ""}${e.who?.length ? " · " + esc(e.who.map(nameOf).join("、")) : ""}</small></div>`;
  }
  const list = S.cal.filter((e) => e.d === day);
  h += `</div></div><div class="calside"><div class="pcard"><h4>${esc(dayLabel(day))} · ${list.length} 项</h4>${list.map((e) => `<div class="row2"><span style="flex:1">${esc(e.s)}–${esc(e.e)} ${esc(e.t)} <span class="dim">${esc(KIND[e.k] || "")}${e.room ? " · " + esc(e.room) : ""}</span></span>${e.k === "busy" ? `<button class="pbtn g" data-rm="${esc(e.id)}">删</button>` : ""}</div>`).join("") || `<div class="dim">这天没有安排</div>`}</div>
    <div class="pcard"><h4>➕ 加一条忙碌</h4>
    <div class="row2"><input class="c-t" placeholder="事情，如 看牙"></div>
    <div class="row2"><input class="c-s" placeholder="开始 14:00"><input class="c-e" placeholder="结束 15:00"></div>
    <div class="row2"><button class="pbtn c-add">加到 ${esc(dayLabel(day))}</button><span class="dim">助理排时间时会避开</span></div></div>
    <div class="pcard">${legend}</div></div></div>`;
  const v = $(".v-cal");
  const st = v.scrollTop;
  v.innerHTML = h; v.scrollTop = st;
  $$(".days span", v).forEach((s) => (s.onclick = () => { day = s.dataset.d; renderCal(); }));
  $$("[data-rm]", v).forEach((b) => (b.onclick = () => post("/api/cal/remove", { id: b.dataset.rm })));
  $(".c-add", v).onclick = () => post("/api/cal/add", { date: day, start: $(".c-s", v).value, end: $(".c-e", v).value, title: $(".c-t", v).value }).catch((e) => alert(e.message));
}

function renderMem() {
  const v = $(".v-mem"), p = S.profile;
  if (v.contains(document.activeElement)) return;
  let h = "";
  if (S.prefs.length) h += `<div class="pcard"><h4>⚙️ 本人偏好</h4>${S.prefs.map((x) => `<div class="row2">${esc(x.x)}${x.k ? ` <span class="tag">${{ hard: "硬约束", human: "仅本人可豁免", soft: "勉强" }[x.k]}</span>` : ""}</div>`).join("")}</div>`;
  h += `<div class="pcard"><h4>🧠 助理从记录里提取的档案</h4>${p ? `
    ${p.schedule.map((x) => `<div class="row2"><span>${esc(dayLabel(x.d))} ${esc(x.s)}-${esc(x.e)} ${esc(x.what)}</span><span class="tag flex-${x.flex}" style="margin-left:auto">${FLEX[x.flex]}</span></div>`).join("")}
    ${p.tea ? `<div class="row2">🧋 ${esc([p.tea.usual, (p.tea.likes || []).length ? "喜欢 " + p.tea.likes.join("、") : "", (p.tea.dislikes || []).length ? "不要 " + p.tea.dislikes.join("、") : ""].filter(Boolean).join("；"))}</div>` : ""}
    ${(p.diet?.hard || []).length ? `<div class="row2">⛔ 不能碰：${esc(p.diet.hard.join("、"))}</div>` : ""}
    ${p.notes ? `<div class="row2 dim">${esc(p.notes)}</div>` : ""}` : `<div class="dim">还没有。助理第一次需要了解你（比如有人约周末、投票奶茶）时，会自己读下面的记录并整理出来。</div>`}</div>`;
  h += `<div class="pcard"><h4>📒 我的原始记录 <span class="dim">（只有我的助理能读）</span></h4><textarea class="hist">${esc(S.history)}</textarea>
    <div class="row2"><button class="pbtn h-save">保存（档案会重新提取）</button></div></div>`;
  if (S.order) h += `<div class="pcard"><h4>🧋 团单 · ${esc(S.order.shopName)}</h4>${S.order.items.map((x) => `<div class="row2">${esc(x.name_cn)}：${esc(x.name)} ${esc(x.sugar)} ${esc(x.ice)} ${esc((x.mods || []).join(" "))}<span style="margin-left:auto">¥${x.price}</span></div>`).join("")}<div class="row2 dim">送达 ${esc(S.order.deliver_at)} · ${esc(S.order.place)} · 合计 ¥${S.order.total}</div></div>`;
  h += `<div class="pcard"><h4>👤 我的资料 <span class="dim">（来自钉钉，可改；同事的助理会看到职位、部门和层级）</span></h4>
    <div class="row2"><input class="m-n" value="${esc(S.me?.n)}" placeholder="名字"><input class="m-r" value="${esc(S.me?.r)}" placeholder="职位"></div>
    <div class="row2"><input class="m-d" value="${esc(S.me?.dept || "")}" placeholder="部门"><select class="m-l">${[1, 2, 3].map((l) => `<option value="${l}" ${+S.me?.L === l ? "selected" : ""}>L${l} ${["负责人", "经理/主管", "员工"][l - 1]}</option>`).join("")}</select></div>
    <div class="row2"><button class="pbtn m-save">保存资料</button><button class="pbtn g re-gen">重新生成示例日程和记录</button><span class="dim">id ${esc(S.me?.id)}</span></div></div>`;
  v.innerHTML = h;
  $(".h-save", v).onclick = () => post("/api/history", { text: $(".hist", v).value }).then(() => toast("已保存", "助理下次会重新读"));
  $(".m-save", v).onclick = () => post("/api/me", { n: $(".m-n", v).value, r: $(".m-r", v).value, dept: $(".m-d", v).value, L: +$(".m-l", v).value }).then(() => toast("已保存", "同事的助理下次会看到新资料"));
  $(".re-gen", v).onclick = (e) => { if (e.target.dataset.sure) post("/api/regen", {}).then(() => toast("已重新生成", "日程和原始记录换了一套")); else { e.target.dataset.sure = 1; e.target.textContent = "再点一次确认（会覆盖现在的日程和记录）"; } };
}

const DT_STATE = { off: "未连接", checking: "检查中…", login: "未登录钉钉", connecting: "连接中…", ready: "已连接", error: "出错" };
function dtHtml(compact) {
  const d = S.dt || {};
  const ok = d.state === "ready";
  let h = `<div class="${compact ? "me-addr" : "pcard"}">${compact ? "" : "<h4>💬 钉钉连接</h4>"}
    <span class="pd ${ok ? "on" : ""}"></span> ${esc(DT_STATE[d.state] || d.state)}${d.self ? ` · 本人 <b>${esc(d.self.name)}</b>${d.self.corp ? " · " + esc(d.self.corp) : ""}` : ""}${d.kind === "loop" ? ' · <span class="tag">本机测试信箱</span>' : ""}
    ${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}${d.listen && d.listen !== "ready" && ok ? `<div class="dim">收信：${esc(d.listen)}</div>` : ""}
    ${d.login?.running ? `<div class="dim">请在浏览器里用钉钉扫码授权${d.login.url ? `：<a href="${esc(d.login.url)}" target="_blank" rel="noopener">打开授权页</a>` : "…"}</div>` : d.login?.msg ? `<div class="dim">${esc(d.login.msg)}</div>` : ""}`;
  if (!compact && d.kind !== "loop") {
    h += `<div class="row2" style="flex-wrap:wrap">${!ok ? `<button class="pbtn dt-login">登录钉钉（扫码）</button>` : `<button class="pbtn g dt-login">切换账号 / 重新登录</button>`}<button class="pbtn g dt-connect">重新连接</button><button class="pbtn g dt-creds-t">高级：用自己的钉钉应用</button></div>
      ${!ok ? `<div class="dim" style="font-size:12px">点登录后浏览器会打开钉钉授权页：用钉钉扫码，选公司（九派科技），点同意。第一次用时公司可能要求申请「CLI 数据访问权限」，选管理员提交，管理员批准后自动连上。</div>` : ""}
      <div class="dt-creds" ${!credsOpen ? "hidden" : ""}><div class="dim" style="font-size:12px">一般不需要。只有公司要求用自建的企业内部应用时才填：开放平台复制 Client ID 和 Client Secret，应用「安全设置」加重定向地址 http://127.0.0.1 和 https://login.dingtalk.com，并发布应用。凭据只保存在本机 <code>${esc(d.credsFile || "")}</code>。</div>
      <div class="row2"><input class="dt-id" placeholder="Client ID（原 AppKey）"><input class="dt-sec" type="password" placeholder="Client Secret"></div>
      <div class="row2"><button class="pbtn dt-save">保存</button>${d.creds ? `<button class="pbtn g dt-login-custom">用这个应用登录</button>` : ""}</div></div>`;
  }
  return h + `<div class="err dt-err"></div></div>`;
}
let credsOpen = false, dtFound = [];
function peersHtml(compact) {
  let h = dtHtml(compact);
  const list = S.peers.map((p) => `<div class="${compact ? "peer" : "row2"}"><span class="pd ${p.online ? "on" : ""}"></span><span class="av" style="width:24px;height:24px;font-size:11px;background:${esc(p.me.c)}">${esc(p.me.a)}</span>
      <span>${esc(p.me.n)} <span class="${compact ? "sm" : "dim"}">${esc(p.me.r)}${p.me.dept ? " · " + esc(p.me.dept) : ""}${p.clash ? " · ⚠ 身份重复" : ""}</span><br><span class="${compact ? "sm" : "dim"}">钉钉 ${esc(p.dtName || "")} · ${p.installed ? (p.online ? "助理已接入" : "助理最近没回复") : "还没接入助理（可发普通消息）"}</span></span>
      ${compact ? "" : `<button class="pbtn g x" data-ping="${esc(p.id)}" title="检查助理">↻</button>`}<button class="pbtn g x" data-forget="${esc(p.id)}" title="移除">✕</button></div>`).join("");
  h += compact ? list || `<div class="empty">还没有钉钉同事</div>` : `<div class="pcard"><h4>👥 钉钉同事 <span class="dim">${S.peers.filter((p) => p.online).length} 位助理已接入</span></h4>${list || `<div class="dim">还没有。按姓名在钉钉通讯录里搜同事并添加；对方也装了 dsh-meeting-DD 的话，几秒内会显示「助理已接入」。</div>`}</div>`;
  if (!compact) h += `<div class="pcard"><h4>📡 自动发现</h4><div class="row2"><span class="dim" style="flex:1">登录后会自动给本组织每位同事发一次打招呼，装了九派助理的同事会自动出现在上面。新同事入职后可以再发现一次。</span><button class="pbtn dt-disc">重新发现</button></div></div>`;
  if (!compact) h += `<div class="pcard"><h4>🔎 在钉钉里找同事</h4><div class="addp"><input class="dt-q" placeholder="同事姓名"><button class="pbtn dt-search">搜索</button></div><div class="err perr"></div>
    ${dtFound.map((x) => `<div class="row2"><span>${esc(x.name)} <span class="dim">${esc([x.title, x.dept].filter(Boolean).join(" · "))}</span></span>${x.added ? '<span class="tag" style="margin-left:auto">已添加</span>' : `<button class="pbtn" style="margin-left:auto" data-add="${esc(x.openId)}">添加</button>`}</div>`).join("")}</div>`;
  return h;
}
function bindPeers(el) {
  const err = (e) => { const x = $(".perr", el) || $(".dt-err", el); if (x) x.textContent = e.message; };
  const q = (c) => $(c, el);
  if (q(".dt-disc")) q(".dt-disc").onclick = () => post("/api/dt/discover", {}).then((r) => toast("已发现", `组织 ${r.members ?? "?"} 人，打招呼 ${r.sent ?? 0} 人`)).catch(err);
  if (q(".dt-search")) q(".dt-search").onclick = async () => {
    $(".perr", el).textContent = "";
    try { dtFound = (await post("/api/dt/search", { q: q(".dt-q").value })).list; if (!dtFound.length) throw new Error("钉钉通讯录里没搜到"); renderNet(true); } catch (e) { err(e); }
  };
  $$("[data-add]", el).forEach((b) => (b.onclick = async () => {
    const x = dtFound.find((y) => y.openId === b.dataset.add);
    b.disabled = true;
    try { const r = await post("/api/dt/add", x); x.added = true; toast("已添加", `已在钉钉里向 ${x.name} 打招呼`); renderNet(true); } catch (e) { err(e); b.disabled = false; }
  }));
  if (q(".dt-login")) q(".dt-login").onclick = () => post("/api/dt/login", {}).then(() => toast("请在浏览器里扫码", "用钉钉扫码并点同意")).catch(err);
  if (q(".dt-login-custom")) q(".dt-login-custom").onclick = () => post("/api/dt/login", { custom: true }).catch(err);
  if (q(".dt-connect")) q(".dt-connect").onclick = () => post("/api/dt/connect", {}).catch(err);
  if (q(".dt-creds-t")) q(".dt-creds-t").onclick = () => { credsOpen = !credsOpen; renderNet(true); };
  if (q(".dt-save")) q(".dt-save").onclick = () => post("/api/dt/creds", { clientId: q(".dt-id").value, clientSecret: q(".dt-sec").value }).then(() => { credsOpen = false; toast("已保存", "凭据只存在本机"); }).catch(err);
  $$("[data-ping]", el).forEach((b) => (b.onclick = () => post("/api/dt/ping", { id: b.dataset.ping }).then(() => toast("已发送", "等对方助理回应")).catch(err)));
  $$("[data-forget]", el).forEach((b) => (b.onclick = () => post("/api/peers/forget", { id: b.dataset.forget })));
}
function directoryHtml() {
  const ppl = [S.me, ...S.directory].filter(Boolean);
  const order = [S.me?.dept].filter(Boolean);
  const depts = [...new Set(ppl.map((m) => m.dept || "其他"))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return `<div class="pcard dir"><h4>🏢 ${S.persona ? "公司通讯录（示例公司 + 钉钉同事）" : "钉钉同事通讯录"} <span class="dim">${S.directory.filter((m) => m.online).length} 位助理已接入 · 「私聊」会发到对方钉钉</span></h4>${depts.map((d) => `<div class="row2 dept">${esc(d)}</div>` + ppl.filter((m) => (m.dept || "其他") === d).sort((a, b) => a.L - b.L)
    .map((m) => `<div class="row2"><span class="pd ${m.id === S.me?.id || m.online ? "on" : ""}"></span>${avHtml(m)}<span>${esc(m.n)} <span class="dim">${esc(m.r)} · L${esc(m.L)}${m.up ? " · 上级 " + esc(nameOf(m.up)) : ""}</span>${m.squad ? ` <span class="sqd">${esc(m.squad)}</span>` : ""}</span>
      ${m.id === S.me?.id ? '<span class="tag" style="margin-left:auto">我</span>' : (m.reach ? `<button class="pbtn g" style="margin-left:auto;white-space:nowrap" data-dm="${esc(m.id)}">私聊</button>` : `<span class="dim" style="margin-left:auto;font-size:11px">未加钉钉</span>`)}</div>`).join("")).join("")}</div>`;
}
function renderNet(force) {
  const v = $(".v-net");
  if (!force && v.contains(document.activeElement)) return;
  v.innerHTML = directoryHtml() + peersHtml(false); bindPeers(v);
  $$("[data-dm]", v).forEach((b) => (b.onclick = () => { S.dms[b.dataset.dm] ||= []; openThread("dm:" + b.dataset.dm); }));
}

function renderSetup() {
  const el = $(".setup");
  const dws = S.dt?.kind === "dws";
  const show = dws ? (S.dt?.state !== "ready" || !S.me) : !S.me;
  el.hidden = !show;
  if (!show || el.contains(document.activeElement)) return;
  if (dws) {
    el.innerHTML = `<h2>👋 用钉钉登录九派助理</h2><div class="dim" style="font-size:13px;line-height:1.7">你的私人助理会以你的钉钉身份，在钉钉里和同事的助理约会议、排时间、团建投票。登录后身份自动用你的钉钉姓名和部门，还会给你生成一套示例日程和记录（之后可以改）。</div>
      ${S.dt?.state === "ready" && !S.me ? `<div class="pcard">正在读取你的钉钉身份…</div>` : dtHtml(false)}`;
    bindPeers(el);
    return;
  }
  el.innerHTML = `<h2>👋 测试节点：我是谁？</h2><div class="pcard">
      <div class="row2"><input class="s-n" placeholder="名字"><input class="s-id" placeholder="英文 id"></div>
      <div class="row2"><button class="pbtn s-go">就是我</button></div><div class="err s-err"></div></div>`;
  $(".s-go", el).onclick = () => post("/api/setup", { custom: { n: $(".s-n", el).value, id: $(".s-id", el).value } }).catch((e) => { $(".s-err", el).textContent = e.message; });
}

/* ---------------- 侧栏（宽屏） ---------------- */
function renderSide() {
  const seq = $(".seq");
  if (!S.a2a.length) seq.innerHTML = `<div class="empty">还没有报文。本人发起协商、或同事的助理发来报文时会出现在这里。</div>`;
  else {
    let conv = null, h = "";
    S.a2a.forEach((r, i) => {
      if (r.conv && r.conv !== conv) { conv = r.conv; h += `<div class="conv">🔁 ${esc(conv)}</div>`; }
      const ty = TY[r.ty] || { c: "#ccc", n: r.ty };
      h += `<div class="a2r ${sel === i ? "sel" : ""}" data-i="${i}"><div><b style="background:${ty.c}">${esc(r.ty)}</b><div class="tm">${esc(new Date(r.t).toTimeString().slice(0, 8))}</div></div>
        <div><span class="who">${esc(nameOf(r.from))} → ${esc(r.to.map(nameOf).join("、"))}</span><br>${esc(r.x)}</div></div>`;
    });
    const near = seq.scrollHeight - seq.scrollTop - seq.clientHeight < 60;
    seq.innerHTML = h;
    if (near) seq.scrollTop = seq.scrollHeight;
    $$(".a2r", seq).forEach((row) => (row.onclick = () => { sel = +row.dataset.i; renderSide(); }));
  }
  const r = S.a2a[sel];
  $(".detail").innerHTML = r ? `<div class="json">${esc(JSON.stringify({ from: "agent://" + r.from, to: r.to.map((x) => "agent://" + x), type: r.ty, conv: r.conv, payload: r.p }, null, 2))}</div>` : "";
  $(".mdns").textContent = DT_STATE[S.dt?.state] || "";
  const ps = $(".peers-side");
  if (!ps.contains(document.activeElement)) { ps.innerHTML = peersHtml(true); bindPeers(ps); }
  const ex = $(".extra");
  const b = S.board, t = S.tally;
  ex.hidden = !b && !t;
  if (b || t) ex.innerHTML = `<h3>🧮 求交 / 投票 <small>本机算的</small></h3>
    ${b ? `<div style="font-size:12px">${b.common?.length ? "共同时段：" + b.common.slice(0, 4).map((x) => esc(x.slot)).join("；") : "交集为空" + (b.relax?.length ? "；松绑：" + esc(b.relax[0].slot) + " 需 " + esc(b.relax[0].needs_owner_exemption_from.map(nameOf).join("、")) + " 本人同意" : "")}</div>` : ""}
    ${t ? `<div style="font-size:12px;margin-top:6px">${t.rows.map((r) => `${esc(r.name)} ${r.score} 分${r.vetoed_by.length ? "（" + esc(r.vetoed_by.map(nameOf).join("、")) + " 否决）" : ""}`).join(" · ")} → ${esc(t.status === "winner" ? t.rows.find((r) => r.shop === t.winner)?.name : t.status)}</div>` : ""}`;
}

function render() {
  if (!S) return;
  renderHeader(); renderSetup();
  if (tab === "chat") renderChat();
  if (tab === "cal") renderCal();
  if (tab === "mem") renderMem();
  if (tab === "net") renderNet();
  if (tab === "msg") renderMsg();
  renderBadge();
  renderSide();
}

function say(x) { if (!x.trim()) return; post("/api/say", { text: x.trim() }).catch((e) => toast("⚠ 没发出去", e.message)); }
// 输入框：助理页发给助理（@某人 则直接发给那个人）；消息页发到当前对话
function send(x) {
  x = x.trim();
  if (!x) return;
  if (tab === "msg" && thread) {
    const p = thread.startsWith("g:") ? post("/api/group/send", { gid: thread.slice(2), text: x }) : post("/api/dm", { to: [thread.slice(3)], text: x });
    return p.catch((e) => toast("⚠ 没发出去", e.message));
  }
  say(x);
}
function syncInput() {
  const show = tab === "chat" || (tab === "msg" && !!thread && !groupForm);
  $(".inp").hidden = !show;
  $(".mention").hidden = true;
  input.placeholder = tab === "chat" ? "对你的助理说…（@某人 直接发给他）" : thread?.startsWith("g:") ? "在群里说…（@某人 提醒他）" : `发给 ${thread ? nameOf(thread.slice(3)) : ""}…`;
}
function switchTab(t) {
  tab = t;
  $$(".tab").forEach((x) => x.classList.toggle("on", x.dataset.t === t));
  for (const k of ["chat", "msg", "cal", "mem", "net"]) $(".v-" + k).hidden = k !== tab;
  syncInput();
  render();
}
$$(".tab").forEach((t) => (t.onclick = () => { if (t.dataset.t === "msg" && tab === "msg") { thread = null; groupForm = null; } switchTab(t.dataset.t); }));
const input = $(".inp input");
$(".inp button").onclick = () => { send(input.value); input.value = ""; $(".mention").hidden = true; };
input.oninput = () => { menIdx = 0; updateMention(); };
input.onclick = updateMention;
input.onblur = () => setTimeout(() => ($(".mention").hidden = true), 150);
input.onkeydown = (e) => {
  const box = $(".mention");
  if (!box.hidden) {
    const n = $$("div", box).length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); menIdx = (menIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n; updateMention(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) { e.preventDefault(); pickMention($$("div", box)[menIdx].dataset.id); return; }
    if (e.key === "Escape") { box.hidden = true; return; }
  }
  if (e.key === "Enter" && !e.isComposing) { send(input.value); input.value = ""; }
};
$("[data-act=reset]").onclick = () => confirm("清空对话和报文，开新一轮（日程保留）？") && post("/api/reset", {});
document.addEventListener("click", () => { try { if (Notification.permission === "default") Notification.requestPermission(); } catch {} }, { once: true });
setInterval(() => S && renderHeader(), 30000);
await load();
connect();
