import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, PROVIDER } from "../extensions/codex-accounts/storage.js";
import { formatQuota, formatReport, isExhausted, parseHeaders, parseRateEvent, parseUsage, queryUsage } from "../extensions/codex-accounts/usage.js";
import { registerAccounts } from "../extensions/codex-accounts/controller.js";

const TOKEN_CLAIM = "https://api.openai.com/auth";
const ACCOUNT_ONE = "acct-11111111";
const ACCOUNT_TWO = "acct-22222222";
const EMPTY_USAGE = { primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 2000000000 }, secondary_window: { used_percent: 65, limit_window_seconds: 604800, reset_at: 2000600000 } };

function token(id, email = `${id}@example.test`) {
  const payload = Buffer.from(JSON.stringify({ [TOKEN_CLAIM]: { chatgpt_account_id: id }, email })).toString("base64url");
  return `header.${payload}.signature`;
}
function credential(id, refresh = `refresh-${id}`, expires = Date.now() + 3600_000) {
  return { type: "oauth", access: token(id), refresh, expires, accountId: id };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-accounts-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "keep-this" }, [PROVIDER]: credential(ACCOUNT_ONE) }), { mode: 0o600 });
  const store = new AccountStore(dir);
  return { dir, authPath, store, close: () => rmSync(dir, { recursive: true, force: true }) };
}

await test("保存账号保留 OAuth 凭据，文件权限为 0600，且不保存 API key", async () => {
  const f = fixture();
  try {
    const original = f.store.current().credential;
    const saved = await f.store.save("personal");
    assert.equal(saved.name, "personal");
    const snapshot = JSON.parse(readFileSync(f.store.accountsPath, "utf8"));
    assert.deepEqual(snapshot.accounts[ACCOUNT_ONE].credential, original);
    assert.equal(lstatSync(f.store.accountsPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(snapshot).includes("keep-this"), false);
    assert.equal(snapshot.version, 1);
  } finally { f.close(); }
});

test("切换账号保留 auth.json 其他 provider、原始 expires 和目标 refresh token", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const personalExpiry = f.store.readAccounts().accounts[ACCOUNT_ONE].credential.expires;
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = credential(ACCOUNT_TWO, "rotated-refresh-two");
    writeFileSync(f.authPath, JSON.stringify(auth));
    await f.store.save("work");
    const selected = await f.store.switch("personal");
    const active = JSON.parse(readFileSync(f.authPath, "utf8"));
    const snapshots = JSON.parse(readFileSync(f.store.accountsPath, "utf8")).accounts;
    assert.equal(selected.name, "personal");
    assert.equal(active.anthropic.key, "keep-this");
    assert.equal(active[PROVIDER].accountId, ACCOUNT_ONE);
    assert.equal(active[PROVIDER].expires, personalExpiry);
    assert.equal(snapshots[ACCOUNT_TWO].credential.refresh, "rotated-refresh-two");
  } finally { f.close(); }
});

test("切换前同步当前账号已轮换的 access/refresh 凭据", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const changed = credential(ACCOUNT_ONE, "rotated-refresh-one");
    changed.access = token(ACCOUNT_ONE, "rotated@example.test");
    changed.expires += 5000;
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = changed;
    writeFileSync(f.authPath, JSON.stringify(auth));
    await f.store.syncActive();
    const saved = JSON.parse(readFileSync(f.store.accountsPath, "utf8")).accounts[ACCOUNT_ONE].credential;
    assert.deepEqual(saved, changed);
  } finally { f.close(); }
});

test("移除仅删除保存快照，不改变当前活动登录", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    await f.store.remove(ACCOUNT_ONE);
    assert.equal(f.store.current().id, ACCOUNT_ONE);
    assert.deepEqual(Object.keys(f.store.readAccounts().accounts), []);
  } finally { f.close(); }
});

test("不同账号名称冲突被拒绝，特殊账号 ID 不会污染对象原型", async () => {
  const f = fixture();
  try {
    await f.store.save("shared");
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = credential(ACCOUNT_TWO);
    writeFileSync(f.authPath, JSON.stringify(auth));
    await assert.rejects(f.store.save("shared"), /名称已属于/);
    await f.store.save();
    assert.equal(Object.getPrototypeOf(f.store.readAccounts().accounts), null);
    assert.equal(Object.prototype.polluted, undefined);
  } finally { f.close(); }
});

test("凭据格式、token account_id 不一致、损坏 JSON 和符号链接都会 fail closed", async () => {
  const f = fixture();
  try {
    const bad = credential(ACCOUNT_ONE);
    bad.accountId = ACCOUNT_TWO;
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = bad;
    writeFileSync(f.authPath, JSON.stringify(auth));
    await assert.rejects(f.store.save(), /身份缺失或与 token 不一致/);
    writeFileSync(f.authPath, "{broken");
    await assert.rejects(f.store.save(), /JSON 损坏/);
    writeFileSync(f.authPath, JSON.stringify({ [PROVIDER]: credential(ACCOUNT_ONE) }));
    writeFileSync(f.store.accountsPath, "{broken");
    await assert.rejects(f.store.save(), /JSON 损坏/);
    rmSync(f.store.accountsPath);
    const target = join(f.dir, "target.json");
    writeFileSync(target, JSON.stringify({ version: 1, accounts: {} }));
    symlinkSync(target, f.store.accountsPath);
    await assert.rejects(f.store.save(), /符号链接/);
  } finally { f.close(); }
});

test("未登录时不创建空账号快照", async () => {
  const f = fixture();
  try {
    writeFileSync(f.authPath, JSON.stringify({ anthropic: { type: "api_key", key: "secret" } }));
    await assert.rejects(f.store.save(), /先执行 \/login/);
    assert.equal(existsSync(f.store.accountsPath), false);
  } finally { f.close(); }
});

test("两个并发账号保存串行化，互不覆盖", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = credential(ACCOUNT_TWO);
    writeFileSync(f.authPath, JSON.stringify(auth));
    await Promise.all([f.store.save("work"), f.store.save("work-alt")]);
    const accounts = f.store.readAccounts().accounts;
    assert.equal(Object.keys(accounts).length, 2);
    assert.equal(accounts[ACCOUNT_ONE].name, "personal");
    assert.ok(["work", "work-alt"].includes(accounts[ACCOUNT_TWO].name));
  } finally { f.close(); }
});

test("usage API payload 支持 5 小时/周窗口、credits null、重置时间和额度耗尽", () => {
  const report = parseUsage({ plan_type: "plus", rate_limit: { ...EMPTY_USAGE, limit_reached: true, allowed: false }, credits: { has_credits: true, unlimited: false, balance: null } }, 1000);
  assert.equal(formatQuota(report, 1000), "5h 72% · 周 35% · credits 未知");
  assert.match(formatReport(report), /当前限制已到达/);
  assert.equal(isExhausted(report), true);
  assert.equal(report.primary.resetAt, 2000000000);
});

test("quota API exposes extra model limit windows and credits without treating null as zero", () => {
  const report = parseUsage({
    rate_limit: { primary_window: EMPTY_USAGE.primary_window },
    additional_rate_limits: [{ metered_feature: "codex_extra", limit_name: "Extra model", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2000000000 } } }],
    credits: { has_credits: true, unlimited: false, balance: "0" },
  }, 50);
  assert.match(formatQuota(report, 50), /credits 0/);
  assert.match(formatQuota(report, 50), /Extra model: 周 0%/);
  assert.equal(isExhausted(report), true);
  assert.equal(parseUsage({ rate_limit: { primary_window: EMPTY_USAGE.primary_window }, credits: { has_credits: true, unlimited: false, balance: null } }, 60).credits.balance, undefined);
});

test("额度用尽且窗口重置时间已过时显示待刷新，不沿用 0%", () => {
  const report = parseUsage({ rate_limit: { primary_window: { used_percent: 100, reset_at: 1000 } } }, 1);
  assert.equal(formatQuota(report, 1000 * 1000), "主窗 待刷新");
  assert.equal(isExhausted(report), false);
});

test("不可信或异常数值不伪造成 0 额度，header/parser 忽略坏值", () => {
  assert.throws(() => parseUsage({}), /未返回可展示/);
  assert.throws(() => parseUsage(null), /结构无效/);
  assert.equal(parseHeaders({ "x-codex-primary-used-percent": "NaN" }), undefined);
  assert.equal(parseHeaders({ "x-codex-primary-used-percent": "-1" }), undefined);
  assert.equal(parseHeaders({ "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "0" }), undefined);
});

test("response headers 与 codex.rate_limits 事件都按真实窗口值解析", () => {
  const headers = parseHeaders({
    "X-Codex-Primary-Used-Percent": "50", "X-Codex-Primary-Window-Minutes": "300", "X-Codex-Primary-Reset-At": "2000000000",
    "x-codex-secondary-used-percent": "75", "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-primary-used-percent": "80", "x-codex-secondary-primary-window-minutes": "300", "x-codex-secondary-primary-reset-at": "2000001000",
    "x-codex-secondary-secondary-used-percent": "85", "x-codex-secondary-secondary-window-minutes": "10080",
  }, 200);
  assert.equal(formatQuota(headers, 200), "5h 50% · 周 25% · secondary: 5h 20%/周 15%");
  const event = parseRateEvent({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 25, window_minutes: 5, reset_at: 2000000000 } } }, 300);
  assert.equal(formatQuota(event, 300), "5m 75%");
  assert.equal(parseRateEvent({ type: "other" }), undefined);
});

test("额度查询固定 HTTPS 端点、正确账号 header、错误或串号不覆盖快照", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ account_id: ACCOUNT_ONE, rate_limit: { primary_window: EMPTY_USAGE.primary_window } }), { status: 200 });
  };
  const report = await queryUsage(credential(ACCOUNT_ONE), ACCOUNT_ONE, fetchImpl);
  assert.equal(report.primary.usedPercent, 28);
  assert.equal(calls[0].init.headers["ChatGPT-Account-Id"], ACCOUNT_ONE);
  assert.equal(new URL(calls[0].url).protocol, "https:");
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_TWO, fetchImpl), /身份不匹配/);
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_ONE, async () => new Response("", { status: 403 })), /HTTP 403/);
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_ONE, async () => { throw new Error("network"); }), /网络失败/);
});

function commandHarness(store, settings = { auth: true }) {
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map();
  const notifications = [];
  const sent = [];
  const refreshed = [];
  let reloads = 0;
  let choices = [];
  let confirmValue = true;
  let auth = settings.auth ? credential(ACCOUNT_ONE) : undefined;
  const context = {
    mode: "tui", hasUI: true, model: { provider: PROVIDER, id: "gpt-6.1-sol" },
    isIdle: () => true,
    modelRegistry: {
      async getProviderAuth() { return auth ? { auth: { apiKey: auth.access } } : undefined; },
      async refresh(options) { refreshed.push(options); return { errors: new Map() }; },
    },
    ui: {
      notify(...args) { notifications.push(args); },
      setStatus(key, text) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
      async select(_title, options) { return choices.shift() ?? options[0]; },
      async confirm() { return confirmValue; },
    },
    async reload() { reloads++; },
  };
  const pi = {
    registerCommand(name, options) { commands.set(name, options); },
    on(name, handler) { handlers.set(name, handler); },
    sendMessage(message) { sent.push(message); },
  };
  registerAccounts(pi, store, { fetchImpl: async () => new Response(JSON.stringify({ account_id: ACCOUNT_ONE, rate_limit: { primary_window: EMPTY_USAGE.primary_window, secondary_window: EMPTY_USAGE.secondary_window }, credits: { has_credits: true, unlimited: false, balance: "0" } }), { status: 200 }) });
  return {
    context, commands, handlers, statuses, notifications, sent, refreshed,
    get reloads() { return reloads; },
    set choices(value) { choices = value; },
    set confirmValue(value) { confirmValue = value; },
    set auth(value) { auth = value; },
  };
}

test("/account save/list/usage/switch/remove 端到端命令接入", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
    auth[PROVIDER] = credential(ACCOUNT_TWO);
    writeFileSync(f.authPath, JSON.stringify(auth));
    await f.store.save("work");
    await f.store.switch("personal");
    const h = commandHarness(f.store);
    await h.commands.get("account").handler("list", h.context);
    assert.match(h.notifications.at(-1)[0], /personal/);
    await h.commands.get("account").handler("usage", h.context);
    assert.match(h.notifications.at(-1)[0], /5h/);
    assert.match(h.notifications.at(-1)[0], /credits 0/);
    assert.match(h.statuses.get("codex-accounts"), /5h 72%/);
    await h.commands.get("account").handler("switch work", h.context);
    assert.equal(JSON.parse(readFileSync(f.authPath, "utf8"))[PROVIDER].accountId, ACCOUNT_TWO);
    assert.equal(h.reloads, 1);
    assert.deepEqual(h.refreshed.at(-1), { providers: [PROVIDER], allowNetwork: false });
    h.confirmValue = false;
    await h.commands.get("account").handler("remove work", h.context);
    assert.ok(f.store.readAccounts().accounts[ACCOUNT_TWO]);
    h.confirmValue = true;
    await h.commands.get("account").handler("remove work", h.context);
    assert.equal(f.store.readAccounts().accounts[ACCOUNT_TWO], undefined);
  } finally { f.close(); }
});

test("外部额度查询失败仅提示错误，不清零或覆盖已有额度快照", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    await f.store.recordUsage(ACCOUNT_ONE, parseUsage({ rate_limit: { primary_window: EMPTY_USAGE.primary_window } }, 100));
    const h = commandHarness(f.store);
    const original = h.context.modelRegistry;
    h.context.modelRegistry = { ...original, async getProviderAuth() { return { auth: { apiKey: token("wrong") } }; } };
    await h.commands.get("account").handler("usage", h.context);
    assert.match(h.notifications.at(-1)[0], /当前认证已变化|认证解析/);
    assert.equal(f.store.readAccounts().accounts[ACCOUNT_ONE].usage.capturedAt, 100);
  } finally { f.close(); }
});

test("执行中拒绝账号切换，429 只提示不自动切换", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const h = commandHarness(f.store);
    h.context.isIdle = () => false;
    await h.commands.get("account").handler("switch personal", h.context);
    assert.match(h.notifications.at(-1)[0], /会话空闲/);
    assert.equal(h.reloads, 0);
  } finally { f.close(); }
});

test("JSON 模式命令输出可读提示且不尝试绘制状态栏", async () => {
  const f = fixture();
  try {
    const h = commandHarness(f.store);
    h.context.mode = "json";
    h.context.hasUI = false;
    await h.handlers.get("session_start")({}, h.context);
    await h.commands.get("account").handler("list", h.context);
    assert.equal(h.statuses.has("codex-accounts"), false);
    assert.ok(h.sent.length > 0 || h.notifications.length > 0);
  } finally { f.close(); }
});

test("测试环境依赖原生扩展注册，无需另行替换 provider", () => {
  assert.equal(PROVIDER, "openai-codex");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/codex-accounts.js"));
  assert.equal(manifest.scripts["test:accounts"], "node --test scripts/test-codex-accounts.mjs");
  assert.equal(JSON.parse(readFileSync("package-lock.json", "utf8")).packages["node_modules/proper-lockfile"].version, "4.1.2");
});

test("原生存储权限测试 fixture 也不会放宽 mode", () => {
  const f = fixture();
  try { chmodSync(f.authPath, 0o600); assert.equal(lstatSync(f.authPath).mode & 0o777, 0o600); }
  finally { f.close(); }
});

console.log("Codex accounts tests: storage locking, credential rotation/switch, abuse resistance, usage parsers, CLI/status integration");
