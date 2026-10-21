// 扫码登录后，给每个人自动生成一套「示例档案」：未来一周的日程、偏好、手机里的原始记录（聊天 / 备忘 / 预约 / 外卖 / 体检）。
// 仿照原 demo 里小美、小雨、李经理那些人的写法；按钉钉 userId 做随机种子，同一个人每次生成的一样，不同人不一样。
// 这些都只是演示数据，本人可以在「📅 日程」「🧠 记住的」里改掉或换成自己的真实安排。
import * as E from "./engine.mjs";

function rng(seedStr) {
  let h = 2166136261;
  for (const c of String(seedStr)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

const WORK = ["需求评审", "客户电话", "部门周会", "方案评审", "项目例会", "数据复盘", "面试", "供应商沟通", "培训", "版本验收", "预算对账", "招聘会议", "线上故障复盘", "设计稿评审"];
const BEHAVIOR = [
  { x: "约会越早越好" }, { x: "会与会之间尽量留 15 分钟缓冲" }, { x: "下午写东西，少打断" }, { x: "跨部门会议需本人确认" },
  { x: "符合偏好的邀请自动接受" }, { x: "上午常外出见客户" }, { x: "1on1 可以顺延" },
];
const TIMED = [
  { x: "12:00–13:30 午休（仅本人可豁免）", s: "12:00", e: "13:30", k: "human", days: "weekday" },
  { x: "17:30 后接孩子（硬约束）", s: "17:30", e: "18:00", k: "hard", days: "weekday" },
  { x: "16:00 后精力差，少排会（勉强可以）", s: "16:00", e: "17:00", k: "soft", days: "weekday" },
  { x: "09:00–09:30 送孩子上学", s: "09:00", e: "09:30", k: "hard", days: "weekday" },
];
// 周末安排：[原始记录片段, 时段]，flex 由文字暗示（助理要自己从记录里读出来）
const WEEKEND = [
  (d, r) => ({ text: `[备忘录 · ${md(r.past(4))}]\n${WD[d.getDay()]} 10:00–13:00 回爸妈家吃午饭，妈妈生日（雷打不动！蛋糕已订）`, hint: "hard" }),
  (d, r) => ({ text: `[微信 · 球队群 · ${md(r.past(2))}]\n教练：${WD[d.getDay()]}上午 9 点到 11 点孩子足球课照常，家长记得接送\n我：收到`, hint: "hard" }),
  (d, r) => ({ text: `[普拉提 App · 预约]\n${WD[d.getDay()]} 09:00–10:00 私教课（提前 12 小时取消不扣费）`, hint: "tentative" }),
  (d, r) => ({ text: `[工作群 · 老板 · ${md(r.past(3))}]\n老板：${WD[d.getDay()]}下午 13:00–17:00 新版本上线，你盯一下\n我：好的\n[微信 · 同事 · ${md(r.past(3))}]\n同事：${WD[d.getDay()]}上线你要是有事，我可以远程帮你盯，提前跟老板报备一声就行\n我：先不用，到时候我自己点头了再找你`, hint: "owner_exemptible" }),
  (d, r) => ({ text: `[微信 · 室友 · ${md(r.past(1))}]\n我：${WD[d.getDay()]}下午三点以后我要在家补觉，谁也别叫我\n室友：哈哈好`, hint: "tentative" }),
  (d, r) => ({ text: `[大麦 · 订单]\n${WD[d.getDay()]} 19:30 话剧《茶馆》两张，已出票，不可退`, hint: "hard" }),
  (d, r) => ({ text: `[微信 · 男/女朋友 · ${md(r.past(2))}]\nTA：${WD[d.getDay()]}晚上那家云南菜我订好了，六点半，别又迟到哈\n我：知道啦，五点半就开始收拾`, hint: "hard" }),
];
const TEA = [
  { chat: "我现在只喝果茶，多肉葡萄少冰五分糖；奶茶喝了就爆痘", order: "鲜果茶铺 · 多肉葡萄（少冰 · 五分糖）× 6 次\n奶茶研究所 · 芋泥波波奶茶 × 1 次（评价：太腻，下次不点）" },
  { chat: "我乳糖不耐，一喝牛奶就闹肚子，奶茶只能点燕麦奶的", order: "奶茶研究所 · 燕麦乌龙（换燕麦奶 · 半糖）× 5 次\n鲜果茶铺 · 柠檬绿茶 × 2 次" },
  { chat: "我就爱原味奶茶，全糖正常冰，别给我换别的", order: "奶茶研究所 · 原味奶茶（全糖）× 8 次" },
  { chat: "下午不能喝带咖啡因的，不然晚上睡不着，芒芒甘露就挺好", order: "鲜果茶铺 · 芒芒甘露（少冰）× 4 次\n奶茶研究所 · 芋泥牛奶 × 2 次" },
  { chat: "我对坚果过敏，榛果那种绝对不行，其他随意", order: "奶茶研究所 · 芋泥波波奶茶（五分糖）× 3 次\n鲜果茶铺 · 满杯红柚 × 3 次" },
];
const HEALTH = [
  "[健康 App · 医生备注]\n空腹血糖偏高，每天额外添加糖控制在 25g 以内：奶茶最多三分糖，最好无糖。",
  "[体检报告 · 备注]\n胃不太好，少喝冰的。",
  "",
  "",
];

export function generateProfile(seed, today = new Date()) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)];
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const day = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const r = { past: (n) => day(-n) };
  // 日程：未来 7 天的工作日，每天 1~3 场
  const cal = [];
  let k = 0;
  for (let i = 0; i < 8; i++) {
    const d = day(i);
    if ([0, 6].includes(d.getDay())) continue;
    const n = 1 + Math.floor(R() * 3), taken = [];
    for (let j = 0; j < n; j++) {
      const len = pick([30, 60, 60, 90]);
      for (let tries = 0; tries < 8; tries++) {
        const s = 9 * 60 + Math.floor(R() * ((18 * 60 - len - 9 * 60) / 30)) * 30;
        if (s < 13 * 60 + 30 && s + len > 12 * 60) continue; // 避开午饭
        if (taken.some(([a, b]) => s < b && s + len > a)) continue;
        taken.push([s, s + len]);
        cal.push({ id: "g" + ++k, d: E.ymd(d), s: E.F(s), e: E.F(s + len), t: pick(WORK), k: "busy" });
        break;
      }
    }
  }
  cal.sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
  // 偏好：1 条带时段的 + 1~2 条行为偏好
  const prefs = [];
  const timed = pick(TIMED);
  prefs.push({ id: "p1", ...timed });
  if (timed.k !== "human") prefs.push({ id: "lunch", x: "12:00–13:00 午饭", s: "12:00", e: "13:00", k: "hard", days: "weekday" });
  const beh = [...BEHAVIOR].sort(() => R() - 0.5).slice(0, 1 + Math.floor(R() * 2));
  beh.forEach((b, i) => prefs.push({ id: "b" + i, x: b.x, s: null, e: null, k: null }));
  // 原始记录：本周末两件事 + 奶茶口味 + 可能的体检备注
  const sat = day((6 - base.getDay() + 7) % 7 || 7), sun = day(((6 - base.getDay() + 7) % 7 || 7) + 1);
  const w = [...WEEKEND].sort(() => R() - 0.5);
  const tea = pick(TEA), health = pick(HEALTH);
  const history = [
    w[0](sat, r).text,
    w[1](sun, r).text,
    `[微信 · 同事 · ${md(r.past(1))}]\n同事：下午喝啥\n我：${tea.chat}`,
    `[外卖记录]\n${tea.order}`,
    health,
  ].filter(Boolean).join("\n\n");
  return { cal, prefs, history };
}
