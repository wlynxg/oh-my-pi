import assert from "node:assert/strict";
import test from "node:test";
import { registerAccounts } from "../extensions/codex-accounts/controller.js";
import { GO_PROVIDER, GO_USAGE_URL, formatGoQuota, formatGoReport, parseGoUsage, queryGoUsage, resolveGoAuth } from "../extensions/codex-accounts/opencode-go.js";

const STATUS_KEY = "codex-accounts";
const KEY = "fake-go-key-not-a-real-credential";
const KEY_TWO = "second-fake-go-key";
const USAGE_COMMAND = "usage";
const MESSAGE_EVENT = "before_agent_start";
const MODEL_EVENT = "model_select";
const START_EVENT = "session_start";
const SNAPSHOT = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2033-05-18T03:33:20.000Z" },
    weekly: { status: "ok", percent: 5, resetsAt: "2033-05-19T03:33:20.000Z" },
    monthly: { status: "ok", percent: 7, resetsAt: "2033-06-18T03:33:20.000Z" },
  },
};
const response = () => new Response(JSON.stringify(SNAPSHOT), { status: 200 });

function harness() {
  let key = KEY;
  let fetcher = async () => response();
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map();
  const notifications = [];
  const messages = [];
  const calls = [];
  const store = new Proxy({}, { get() { assert.fail("Go 查询不应读取或改动 Codex 账号存储"); } });
  const ctx = {
    mode: "tui", hasUI: true, model: { provider: GO_PROVIDER, id: "glm-5" },
    modelRegistry: { async getProviderAuth(provider) { assert.equal(provider, GO_PROVIDER); return { auth: { apiKey: key } }; } },
    ui: {
      setStatus(name, text) { if (text === undefined) statuses.delete(name); else statuses.set(name, text); },
      notify(text, level) { notifications.push({ text, level }); },
    },
  };
  registerAccounts({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message); },
  }, store, { fetchImpl: async (url, init) => { calls.push({ url, init }); return fetcher(url, init); } });
  return {
    ctx, statuses, notifications, messages, calls,
    set key(value) { key = value; },
    set fetcher(value) { fetcher = value; },
    query() { return commands.get("account").handler(USAGE_COMMAND, ctx); },
    event(name) { return handlers.get(name)({}, ctx); },
  };
}

test("官方 usage 三窗使用率转换成剩余比例，0 已用表示 100% 剩余", () => {
  const report = parseGoUsage(SNAPSHOT, 123);
  assert.equal(formatGoQuota(report, 123), "5h 剩余 100% · 周 剩余 95% · 月 剩余 93%");
  assert.equal(report.capturedAt, 123);
  assert.match(formatGoReport(report), /不含 Zen 余额/);
  assert.match(formatGoReport(report), /快照时间/);
  assert.match(formatGoReport(report), /5h 重置/);
});

test("受限窗口显示真实 0%，重置后的旧快照显示待刷新而不是补满", () => {
  const payload = structuredClone(SNAPSHOT);
  payload.usage.rolling.status = "rate-limited";
  payload.usage.rolling.percent = 103;
  const report = parseGoUsage(payload);
  assert.match(formatGoQuota(report, 123), /5h 剩余 0%（受限）/);
  assert.match(formatGoQuota(report, Date.parse(payload.usage.rolling.resetsAt)), /5h 剩余 待刷新/);
});

test("缺失窗口、坏数值和旧结构明确报错，不把未知当零", () => {
  for (const payload of [null, {}, { rollingUsage: {} }, { usage: {} }]) assert.throws(() => parseGoUsage(payload));
  for (const field of ["status", "percent", "resetsAt"]) {
    const payload = structuredClone(SNAPSHOT);
    delete payload.usage.weekly[field];
    assert.throws(() => parseGoUsage(payload), /窗口缺失或字段无效/);
  }
  for (const value of [null, "0", -1, Infinity, NaN]) {
    const payload = structuredClone(SNAPSHOT);
    payload.usage.weekly.percent = value;
    assert.throws(() => parseGoUsage(payload));
  }
  const payload = structuredClone(SNAPSHOT);
  payload.usage.monthly.resetsAt = "not-a-date";
  assert.throws(() => parseGoUsage(payload));
});

test("只向固定官方 HTTPS 接口发送 Bearer，拒绝重定向", async () => {
  let captured;
  await queryGoUsage(KEY, async (url, init) => { captured = { url, init }; return response(); });
  assert.equal(captured.url, GO_USAGE_URL);
  assert.equal(captured.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(captured.init.redirect, "error");
  assert.ok(captured.init.signal instanceof AbortSignal);
});

test("HTTP、网络、JSON 和认证错误不泄露 key 或上游原始错误", async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(queryGoUsage(KEY, async () => new Response(KEY, { status })), (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes(KEY));
  }
  await assert.rejects(queryGoUsage(KEY, async () => { throw new Error(KEY); }), (error) => /网络失败/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(queryGoUsage(KEY, async () => new Response(KEY)), (error) => /JSON/.test(error.message) && !error.message.includes(KEY));
  await assert.rejects(resolveGoAuth({ async getProviderAuth() { throw new Error(KEY); } }), (error) => !error.message.includes(KEY));
});

test("沿用 /account usage：Go 使用现有凭据、更新状态栏，不触碰 Codex 存储", async () => {
  const h = harness();
  await h.event(START_EVENT);
  assert.match(h.statuses.get(STATUS_KEY), /Go · 额度未知/);
  assert.equal(h.calls.length, 0);
  await h.query();
  assert.equal(h.calls.length, 1);
  assert.match(h.statuses.get(STATUS_KEY), /5h 剩余 100%/);
  assert.match(h.statuses.get(STATUS_KEY), /周 剩余 95%/);
  assert.match(h.statuses.get(STATUS_KEY), /月 剩余 93%/);
  assert.match(h.statuses.get(STATUS_KEY), /快照/);
  assert.match(h.notifications.at(-1).text, /OpenCode Go 套餐额度/);
  assert.equal(JSON.stringify(h.notifications).includes(KEY), false);
  assert.equal([...h.statuses.values()].join().includes(KEY), false);
});

test("启动、模型切换和每轮事件只显示缓存，没有自动额度查询", async () => {
  const h = harness();
  await h.event(START_EVENT);
  await h.query();
  for (const event of [MODEL_EVENT, MESSAGE_EVENT, "agent_settled"]) await h.event(event);
  assert.equal(h.calls.length, 1);
  h.ctx.model = { provider: "opencode", id: "glm-5" };
  await h.event(MODEL_EVENT);
  assert.equal(h.statuses.has(STATUS_KEY), false);
  h.ctx.model = { provider: GO_PROVIDER, id: "kimi-k2" };
  await h.event(MODEL_EVENT);
  assert.match(h.statuses.get(STATUS_KEY), /月 剩余 93%/);
  assert.equal(h.calls.length, 1);
});

test("同一 key 查询失败保留最后成功快照，明确通知失败", async () => {
  const h = harness();
  await h.query();
  const original = h.statuses.get(STATUS_KEY);
  h.fetcher = async () => new Response("", { status: 403 });
  await h.query();
  assert.equal(h.statuses.get(STATUS_KEY), original);
  assert.equal(h.notifications.at(-1).level, "error");
  assert.match(h.notifications.at(-1).text, /HTTP 403/);
});

test("换 key 或退出认证后立即清除旧账号快照，不混用缓存", async () => {
  const h = harness();
  await h.query();
  h.key = KEY_TWO;
  await h.event(MODEL_EVENT);
  assert.match(h.statuses.get(STATUS_KEY), /额度未知/);
  await h.query();
  h.key = undefined;
  await h.query();
  assert.match(h.statuses.get(STATUS_KEY), /额度未知/);
  assert.match(h.notifications.at(-1).text, /没有 OpenCode Go API Key/);
});

test("查询期间 key 变化则拒绝缓存响应，并提示重新查询", async () => {
  const h = harness();
  h.fetcher = async () => { h.key = KEY_TWO; return response(); };
  await h.query();
  assert.match(h.notifications.at(-1).text, /登录在查询期间发生变化/);
  assert.match(h.statuses.get(STATUS_KEY), /额度未知/);
});

test("等待网络期间切到其他 provider，旧 Go 请求不覆盖新模型状态", async () => {
  const h = harness();
  h.fetcher = async () => {
    h.ctx.model = { provider: "anthropic", id: "claude-sonnet" };
    await h.event(MODEL_EVENT);
    return response();
  };
  await h.query();
  assert.equal(h.statuses.has(STATUS_KEY), false);
});

test("JSON 模式返回可读结果，不访问终端 UI，退出清理缓存", async () => {
  const h = harness();
  h.ctx.mode = "json";
  h.ctx.hasUI = false;
  delete h.ctx.ui;
  await h.event(START_EVENT);
  await h.query();
  assert.match(h.messages.at(-1).content, /月 剩余 93%/);
  assert.equal(JSON.stringify(h.messages).includes(KEY), false);
  await h.event("session_shutdown");
  h.ctx.mode = "tui";
  h.ctx.ui = { setStatus(name, text) { h.statuses.set(name, text); } };
  await h.event(START_EVENT);
  assert.match(h.statuses.get(STATUS_KEY), /额度未知/);
});
