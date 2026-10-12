import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, PROVIDER, credentialInfo } from "../extensions/codex-accounts/storage.js";
import { formatQuota, formatReport, isExhausted, parseHeaders, parseRateEvent, parseUsage, queryUsage } from "../extensions/codex-accounts/usage.js";
import { registerAccounts } from "../extensions/codex-accounts/controller.js";

const TOKEN_CLAIM = "https://api.openai.com/auth";
const ACCOUNT_ONE = "acct-11111111";
const ACCOUNT_TWO = "acct-22222222";
const SHARED_USER_TWO = "user-shared-second";
const SHARED_REFRESH_TWO = "fixture-refresh-shared-second";
const LUO_ALIAS = "luo";
const NEW_ALIAS = "new";
const EMAIL_ONE = `user-${ACCOUNT_ONE}@example.test`;
const EMAIL_SHARED_TWO = `${SHARED_USER_TWO}@example.test`;
const EMAIL_SHARED_WORKSPACES = "shared-mailbox@example.test";
const COMMAND = "account";
const STATUS_KEY = "codex-accounts";
const ACCOUNT_HEADER = "ChatGPT-Account-Id";
const EMPTY_USAGE = { primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 2000000000 }, secondary_window: { used_percent: 65, limit_window_seconds: 604800, reset_at: 2000600000 } };

function token(id, email = `${id}@example.test`, userId = `user-${id}`) {
  const payload = Buffer.from(JSON.stringify({ [TOKEN_CLAIM]: { chatgpt_account_id: id, chatgpt_user_id: userId }, email })).toString("base64url");
  return `header.${payload}.signature`;
}
function credential(id, refresh = `refresh-${id}`, expires = Date.now() + 3600_000, userId = `user-${id}`) {
  return { type: "oauth", access: token(id, `${userId}@example.test`, userId), refresh, expires, accountId: id };
}
const IDENTITY_ONE = credentialInfo(credential(ACCOUNT_ONE)).id;
const IDENTITY_TWO = credentialInfo(credential(ACCOUNT_TWO)).id;
function loginAs(f, next) {
  const auth = JSON.parse(readFileSync(f.authPath, "utf8"));
  writeFileSync(f.authPath, JSON.stringify({ ...auth, [PROVIDER]: next }));
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
    assert.deepEqual(snapshot.accounts[IDENTITY_ONE].credential, original);
    assert.equal(lstatSync(f.store.accountsPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(snapshot).includes("keep-this"), false);
    assert.equal(snapshot.version, 2);
  } finally { f.close(); }
});

test("切换账号保留 auth.json 其他 provider、原始 expires 和目标 refresh token", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    const personalExpiry = f.store.readAccounts().accounts[IDENTITY_ONE].credential.expires;
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
    assert.equal(snapshots[IDENTITY_TWO].credential.refresh, "rotated-refresh-two");
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
    const saved = JSON.parse(readFileSync(f.store.accountsPath, "utf8")).accounts[IDENTITY_ONE].credential;
    assert.deepEqual(saved, changed);
  } finally { f.close(); }
});

test("移除仅删除保存快照，不改变当前活动登录", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    await f.store.remove(IDENTITY_ONE);
    assert.equal(f.store.current().id, IDENTITY_ONE);
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
    assert.equal(accounts[IDENTITY_ONE].name, "personal");
    assert.ok(["work", "work-alt"].includes(accounts[IDENTITY_TWO].name));
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
  assert.equal(calls[0].init.headers[ACCOUNT_HEADER], ACCOUNT_ONE);
  assert.equal(new URL(calls[0].url).protocol, "https:");
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_TWO, fetchImpl), /身份不匹配/);
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_ONE, async () => new Response("", { status: 403 })), /HTTP 403/);
  await assert.rejects(queryUsage(credential(ACCOUNT_ONE), ACCOUNT_ONE, async () => { throw new Error("network"); }), /网络失败/);
});

test("同一工作区的不同用户分别保存、切换与记录额度，不覆盖 luo", async () => {
  const f = fixture();
  try {
    const first = f.store.current().credential;
    await f.store.save(LUO_ALIAS);
    const second = credential(ACCOUNT_ONE, SHARED_REFRESH_TWO, Date.now() + 3600000, SHARED_USER_TWO);
    loginAs(f, second);
    await f.store.save(NEW_ALIAS);
    const secondId = credentialInfo(second).id;
    const accounts = f.store.readAccounts().accounts;
    assert.equal(Object.keys(accounts).length, 2);
    assert.notEqual(secondId, IDENTITY_ONE);
    assert.deepEqual(accounts[IDENTITY_ONE].credential, first);
    assert.deepEqual(accounts[secondId].credential, second);
    await f.store.recordUsage(IDENTITY_ONE, { capturedAt: 10 });
    await f.store.recordUsage(secondId, { capturedAt: 20 });
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].usage.capturedAt, 10);
    assert.equal(f.store.readAccounts().accounts[secondId].usage.capturedAt, 20);
    await f.store.switch(LUO_ALIAS);
    assert.deepEqual(f.store.current().credential, first);
    await f.store.switch(NEW_ALIAS);
    assert.deepEqual(f.store.current().credential, second);
    await f.store.remove(secondId);
    assert.ok(f.store.readAccounts().accounts[IDENTITY_ONE]);
    assert.equal(Object.keys(f.store.readAccounts().accounts).length, 1);
    assert.deepEqual(f.store.current().credential, second);
  } finally { f.close(); }
});

test("同工作区未保存的新用户不能由自动同步覆盖已保存的旧用户", async () => {
  const f = fixture();
  try {
    await f.store.save(LUO_ALIAS);
    const before = readFileSync(f.store.accountsPath, "utf8");
    const second = credential(ACCOUNT_ONE, SHARED_REFRESH_TWO, Date.now() + 3600000, SHARED_USER_TWO);
    loginAs(f, second);
    const active = await f.store.syncActive();
    assert.notEqual(active.id, IDENTITY_ONE);
    assert.equal(active.accountId, ACCOUNT_ONE);
    assert.equal(readFileSync(f.store.accountsPath, "utf8"), before);
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].name, LUO_ALIAS);
  } finally { f.close(); }
});

test("v1 快照只读规范化并完整保留，首次保存新用户才原子落盘 v2", async () => {
  const f = fixture();
  try {
    const entry = { name: LUO_ALIAS, credential: f.store.current().credential, savedAt: 100, updatedAt: 200, usage: { capturedAt: 50 } };
    writeFileSync(f.store.accountsPath, JSON.stringify({ version: 1, accounts: { [ACCOUNT_ONE]: entry } }), { mode: 0o600 });
    const before = readFileSync(f.store.accountsPath, "utf8");
    const authBefore = readFileSync(f.authPath, "utf8");
    const converted = f.store.readAccounts();
    assert.equal(converted.version, 2);
    assert.deepEqual(converted.accounts[IDENTITY_ONE], entry);
    assert.equal(readFileSync(f.store.accountsPath, "utf8"), before);
    assert.equal(readFileSync(f.authPath, "utf8"), authBefore);
    const second = credential(ACCOUNT_ONE, SHARED_REFRESH_TWO, Date.now() + 3600000, SHARED_USER_TWO);
    loginAs(f, second);
    await f.store.save(NEW_ALIAS);
    const disk = JSON.parse(readFileSync(f.store.accountsPath, "utf8"));
    assert.equal(disk.version, 2);
    assert.equal(Object.keys(disk.accounts).length, 2);
    assert.deepEqual(disk.accounts[IDENTITY_ONE], entry);
    assert.equal(lstatSync(f.store.accountsPath).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("用户与工作区共同决定快照键，邮箱或轮换凭据不改变用户身份", () => {
  const first = credential(ACCOUNT_ONE);
  const identity = credentialInfo(first);
  assert.equal(identity.accountId, ACCOUNT_ONE);
  assert.equal(identity.userId, `user-${ACCOUNT_ONE}`);
  assert.match(identity.id, /^[a-f0-9]{64}$/);
  const rotated = { ...first, access: token(ACCOUNT_ONE, "renamed@example.test"), refresh: "fixture-new-refresh", expires: first.expires + 1000 };
  assert.equal(credentialInfo(rotated).id, identity.id);
  assert.notEqual(credentialInfo(credential(ACCOUNT_TWO, undefined, undefined, identity.userId)).id, identity.id);
  const claims = JSON.parse(Buffer.from(first.access.split(".")[1], "base64url"));
  delete claims[TOKEN_CLAIM].chatgpt_user_id;
  claims[TOKEN_CLAIM].user_id = identity.userId;
  const fromClaims = () => ({ ...first, access: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` });
  assert.equal(credentialInfo(fromClaims()).id, identity.id);
  delete claims[TOKEN_CLAIM].user_id;
  claims.sub = identity.userId;
  assert.equal(credentialInfo(fromClaims()).id, identity.id);
});

test("缺少用户身份或快照键异常时明确拒绝，不升级或覆盖文件、不泄露凭据", async () => {
  const f = fixture();
  try {
    const invalid = credential(ACCOUNT_ONE);
    invalid.access = `header.${Buffer.from(JSON.stringify({ [TOKEN_CLAIM]: { chatgpt_account_id: ACCOUNT_ONE } })).toString("base64url")}.signature`;
    loginAs(f, invalid);
    const legacy = { version: 1, accounts: { [ACCOUNT_ONE]: { name: LUO_ALIAS, credential: invalid, savedAt: 100, updatedAt: 200 } } };
    writeFileSync(f.store.accountsPath, JSON.stringify(legacy), { mode: 0o600 });
    const before = readFileSync(f.store.accountsPath, "utf8");
    const authBefore = readFileSync(f.authPath, "utf8");
    await assert.rejects(f.store.save(NEW_ALIAS), (error) => /用户身份/.test(error.message) && !error.message.includes(invalid.refresh) && !error.message.includes(invalid.access));
    assert.equal(readFileSync(f.store.accountsPath, "utf8"), before);
    assert.equal(readFileSync(f.authPath, "utf8"), authBefore);
    const valid = credential(ACCOUNT_ONE);
    loginAs(f, valid);
    legacy.accounts[ACCOUNT_ONE].credential = valid;
    legacy.version = 2;
    writeFileSync(f.store.accountsPath, JSON.stringify(legacy));
    const malformed = readFileSync(f.store.accountsPath, "utf8");
    await assert.rejects(f.store.save(NEW_ALIAS), /快照身份不一致/);
    assert.equal(readFileSync(f.store.accountsPath, "utf8"), malformed);
    legacy.version = 99;
    writeFileSync(f.store.accountsPath, JSON.stringify(legacy));
    await assert.rejects(f.store.save(NEW_ALIAS), /格式不匹配/);
  } finally { f.close(); }
});

test("快照键不能作为额度请求的工作区 header，校验在发送凭据前完成", async () => {
  let calls = 0;
  const active = credential(ACCOUNT_ONE);
  await assert.rejects(queryUsage(active, credentialInfo(active).id, async () => { calls++; }), /工作区身份不匹配/);
  assert.equal(calls, 0);
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
  registerAccounts(pi, store, { fetchImpl: settings.fetchImpl ?? (async () => new Response(JSON.stringify({ account_id: ACCOUNT_ONE, rate_limit: { primary_window: EMPTY_USAGE.primary_window, secondary_window: EMPTY_USAGE.secondary_window }, credits: { has_credits: true, unlimited: false, balance: "0" } }), { status: 200 })) });
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
    assert.ok(h.notifications.at(-1)[0].includes(EMAIL_ONE));
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
    assert.ok(f.store.readAccounts().accounts[IDENTITY_TWO]);
    h.confirmValue = true;
    await h.commands.get("account").handler("remove work", h.context);
    assert.equal(f.store.readAccounts().accounts[IDENTITY_TWO], undefined);
  } finally { f.close(); }
});

test("同工作区两用户的命令列表、额度 header、切换及迟到响应均不串号", async () => {
  const f = fixture();
  try {
    await f.store.save(LUO_ALIAS);
    const second = credential(ACCOUNT_ONE, SHARED_REFRESH_TWO, Date.now() + 3600000, SHARED_USER_TWO);
    loginAs(f, second); await f.store.save(NEW_ALIAS);
    const secondId = credentialInfo(second).id;
    let receivedWorkspace;
    const h = commandHarness(f.store, { auth: true, fetchImpl: async (_url, init) => {
      receivedWorkspace = init.headers[ACCOUNT_HEADER];
      return new Response(JSON.stringify({ account_id: ACCOUNT_ONE, rate_limit: EMPTY_USAGE }), { status: 200 });
    } });
    h.auth = second;
    await h.commands.get("account").handler("list", h.context);
    assert.ok(h.notifications.at(-1)[0].includes(`○ ${EMAIL_ONE}`));
    assert.ok(h.notifications.at(-1)[0].includes(`● ${EMAIL_SHARED_TWO}`));
    await h.commands.get("account").handler("usage", h.context);
    assert.equal(receivedWorkspace, ACCOUNT_ONE);
    assert.ok(f.store.readAccounts().accounts[secondId].usage);
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].usage, undefined);
    await h.handlers.get("before_provider_request")({}, h.context);
    await h.commands.get("account").handler("switch luo", h.context);
    assert.equal(f.store.current().id, IDENTITY_ONE); assert.equal(h.reloads, 1);
    await h.handlers.get("after_provider_response")({ status: 200, headers: { "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300" } }, h.context);
    await h.handlers.get("provider_stream_event")({ provider: PROVIDER, data: { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 99, window_minutes: 300 } } } }, h.context);
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].usage, undefined);
  } finally { f.close(); }
});

test("邮箱覆盖所有账号展示，保留历史别名且只读列表和弹窗不改凭据", async () => {
  const f = fixture();
  try {
    const h = commandHarness(f.store);
    await h.commands.get(COMMAND).handler(`save ${LUO_ALIAS}`, h.context);
    assert.ok(h.notifications.at(-1)[0].includes(EMAIL_ONE));
    assert.ok(h.statuses.get(STATUS_KEY).includes(EMAIL_ONE));
    assert.equal(h.statuses.get(STATUS_KEY).includes(LUO_ALIAS), false);
    const beforeAuth = readFileSync(f.authPath, "utf8");
    const beforeAccounts = readFileSync(f.store.accountsPath, "utf8");
    await h.commands.get(COMMAND).handler("list", h.context);
    assert.ok(h.notifications.at(-1)[0].includes(EMAIL_ONE));
    let choices;
    h.context.ui.select = async (_title, labels) => { choices = labels; return undefined; };
    await h.commands.get(COMMAND).handler("switch", h.context);
    assert.ok(choices[0].includes(EMAIL_ONE));
    assert.equal(choices[0].includes(LUO_ALIAS), false);
    const completion = h.commands.get(COMMAND).getArgumentCompletions(`switch ${EMAIL_ONE}`);
    assert.equal(completion[0].value, `switch ${EMAIL_ONE}`);
    assert.equal(completion[0].label, EMAIL_ONE);
    assert.equal(readFileSync(f.authPath, "utf8"), beforeAuth);
    assert.equal(readFileSync(f.store.accountsPath, "utf8"), beforeAccounts);
    await h.commands.get(COMMAND).handler(`switch ${EMAIL_ONE}`, h.context);
    assert.equal(h.reloads, 1);
    assert.ok(h.notifications.at(-1)[0].includes(EMAIL_ONE));
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].name, LUO_ALIAS);
    let confirmation;
    h.context.ui.confirm = async (_title, text) => { confirmation = text; return false; };
    await h.commands.get(COMMAND).handler(`remove ${EMAIL_ONE}`, h.context);
    assert.ok(confirmation.includes(EMAIL_ONE));
  } finally { f.close(); }
});

test("新登录未保存时显示其邮箱和未保存标记，而不是冒用旧别名", async () => {
  const f = fixture();
  try {
    await f.store.save(LUO_ALIAS);
    const second = credential(ACCOUNT_ONE, SHARED_REFRESH_TWO, Date.now() + 3600000, SHARED_USER_TWO);
    loginAs(f, second);
    const h = commandHarness(f.store);
    await h.commands.get(COMMAND).handler("list", h.context);
    assert.ok(h.notifications.at(-1)[0].includes(`${EMAIL_SHARED_TWO}（未保存）`));
    assert.ok(h.statuses.get(STATUS_KEY).includes(`${EMAIL_SHARED_TWO}（未保存）`));
    assert.equal(Object.keys(f.store.readAccounts().accounts).length, 1);
    await h.commands.get(COMMAND).handler("save", h.context);
    assert.ok(h.notifications.at(-1)[0].includes(EMAIL_SHARED_TWO));
    assert.equal(f.store.readAccounts().accounts[credentialInfo(second).id].name, EMAIL_SHARED_TWO);
    assert.equal(Object.keys(f.store.readAccounts().accounts).length, 2);
  } finally { f.close(); }
});

test("同邮箱多个工作区拒绝歧义，弹窗选项和补全提交值保持可区分", async () => {
  const f = fixture();
  try {
    const first = credential(ACCOUNT_ONE);
    first.access = token(ACCOUNT_ONE, EMAIL_SHARED_WORKSPACES);
    loginAs(f, first); await f.store.save(LUO_ALIAS);
    const second = credential(ACCOUNT_TWO);
    second.access = token(ACCOUNT_TWO, EMAIL_SHARED_WORKSPACES);
    loginAs(f, second); await f.store.save(NEW_ALIAS);
    const h = commandHarness(f.store);
    await h.commands.get(COMMAND).handler(`switch ${EMAIL_SHARED_WORKSPACES}`, h.context);
    assert.match(h.notifications.at(-1)[0], /多个账号/);
    assert.equal(h.reloads, 0);
    let labels;
    h.context.ui.select = async (_title, values) => { labels = values; return values[1]; };
    await h.commands.get(COMMAND).handler("switch", h.context);
    assert.equal(new Set(labels).size, 2);
    assert.equal(f.store.current().accountId, ACCOUNT_TWO);
    const completion = h.commands.get(COMMAND).getArgumentCompletions(`switch ${EMAIL_SHARED_WORKSPACES}`);
    assert.equal(new Set(completion.map(item => item.value)).size, 2);
    assert.equal(new Set(completion.map(item => item.label)).size, 2);
  } finally { f.close(); }
});

test("取不到邮箱时明确标记未知，不推测邮箱、不改写别名", async () => {
  const f = fixture();
  try {
    const active = credential(ACCOUNT_ONE);
    active.access = `header.${Buffer.from(JSON.stringify({ [TOKEN_CLAIM]: { chatgpt_account_id: ACCOUNT_ONE, chatgpt_user_id: `user-${ACCOUNT_ONE}` } })).toString("base64url")}.signature`;
    loginAs(f, active); await f.store.save(LUO_ALIAS);
    const h = commandHarness(f.store);
    await h.commands.get(COMMAND).handler("list", h.context);
    assert.ok(h.notifications.at(-1)[0].includes(`${LUO_ALIAS}（邮箱未知）`));
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].name, LUO_ALIAS);
  } finally { f.close(); }
});

test("外部额度查询失败仅提示错误，不清零或覆盖已有额度快照", async () => {
  const f = fixture();
  try {
    await f.store.save("personal");
    await f.store.recordUsage(IDENTITY_ONE, parseUsage({ rate_limit: { primary_window: EMPTY_USAGE.primary_window } }, 100));
    const h = commandHarness(f.store);
    const original = h.context.modelRegistry;
    h.context.modelRegistry = { ...original, async getProviderAuth() { return { auth: { apiKey: token("wrong") } }; } };
    await h.commands.get("account").handler("usage", h.context);
    assert.match(h.notifications.at(-1)[0], /当前认证已变化|认证解析/);
    assert.equal(f.store.readAccounts().accounts[IDENTITY_ONE].usage.capturedAt, 100);
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
