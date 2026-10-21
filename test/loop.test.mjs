// 用本机假钉钉信箱（LoopLink）测两个节点之间的协议：打招呼、私聊、协商报文往返、分片、普通文字。
// 不启动 dsh，也不联系真人：本机助理用一个假的 deliverLocal 代替。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MeetingNode } from "../lib/node.mjs";
import { encodeWire, decodeWire, Reassembler } from "../lib/dingtalk.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(100); } throw new Error("timeout"); };

test("wire 编码 / 分片", () => {
  const big = { k: "env", payload: { x: "时段".repeat(4000) } };
  const parts = encodeWire("你好", big);
  assert.ok(parts.length > 1);
  const r = new Reassembler();
  let out = null;
  for (const p of parts.reverse()) { const d = decodeWire(p); assert.ok(d.part); out = r.push("a", d.part) || out; }
  assert.deepEqual(out, big);
  assert.deepEqual(decodeWire(encodeWire("hi", { k: "pong" })[0]).obj, { k: "pong" });
  assert.equal(decodeWire("就普通一句话").obj, undefined);
});

test("两个节点通过假钉钉协商", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ddtest-"));
  const loopDir = path.join(root, "loop");
  const mk = (port, name) => new MeetingNode({ port, host: "127.0.0.1", a2aPort: 1, a2aPath: "/a2a", dataDir: path.join(root, "n" + port), credsFile: path.join(root, "c.json"), loopDir, loopName: name, replyTimeoutMin: 1 });
  const A = mk(4691, "李经理"), B = mk(4692, "刘经理");
  // 假的本机助理：B 收到 SYN 就回 SYN-ACK
  B.deliverLocal = async (text) => {
    const id = text.match(/msg_id: (\S+)/)[1];
    await B.runTool("my_availability", { dates: ["周四"] }).then((av) => B.runTool("reply_ding", { reply_to: id, type: "SYN-ACK", text: "给你可用时段", payload: av }));
    return { text: "ok" };
  };
  await A.start(); await B.start();
  try {
    A.setup({ persona: "li" }); B.setup({ persona: "liu" });
    await until(() => A.dt.state === "ready" && B.dt.state === "ready");
    const found = await A.searchDingTalk("刘");
    assert.equal(found.length, 1);
    await A.addContact(found[0]);
    await until(() => A.peers.liu?.installed && B.peers.li?.installed).catch((e) => { console.log(JSON.stringify(A.S.contacts), JSON.stringify(B.S.contacts), A.dt, B.dt); throw e; });
    // 私聊
    await A.sendDM(["liu"], "周四记得带电脑");
    await until(() => B.S.dms.li?.some((m) => m.x === "周四记得带电脑"));
    // 协商
    const r = await A.runTool("send_ding", { to: ["liu"], type: "SYN", conv: "conv-t", text: "问周四空闲", payload: { meeting_id: "t", dates: ["周四"], duration_min: 60 } });
    assert.equal(r.replies[0].type, "SYN-ACK");
    assert.ok(Array.isArray(r.replies[0].payload.available));
    // 对方本人在钉钉里直接回的普通文字 → 私聊
    await B.link.send(B.peers.li.openId, "好的收到", "k1");
    await until(() => A.S.dms.liu?.some((m) => m.x === "好的收到"));
  } finally { await A.stop(); await B.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
