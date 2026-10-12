import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import extension from "../extensions/fast-mode.js";

const SETTING_KEY = "fastMode";
const STATUS_KEY = "fast-mode";
const STATUS_LABEL = "⚡ Fast";
const TIER_FIELD = "service_tier";
const GOOGLE_TIER_FIELD = "serviceTier";
const PRIORITY_TIER = "priority";
const DEFAULT_TIER = "default";
const GPT_ID = "gpt-6.1-sol";
const GEMINI_ID = "gemini-3-pro";
const GROK_ID = "grok-4.7";
const RESPONSE_API = "openai-responses";
const COMPLETIONS_API = "openai-completions";
const GOOGLE_API = "google-generative-ai";
const AZURE_API = "azure-openai-responses";
const FOREIGN_API = "anthropic-messages";
const FOREIGN_ID = "claude-sonnet-4-5";
const OTHER_STATUS_KEY = "fixture-other-status";
const OTHER_STATUS = "other extension status";
const OPENAI_CHAT_APIS = [RESPONSE_API, "openai-codex-responses", COMPLETIONS_API, AZURE_API];
const REQUEST_EVENT = "before_provider_request";
const START_EVENT = "session_start";
const SELECT_EVENT = "model_select";
const AGENT_EVENT = "before_agent_start";
const STOP_EVENT = "session_shutdown";

function harness(initial = {}, model = { id: GPT_ID, api: RESPONSE_API }) {
  let settings = initial;
  const handlers = new Map();
  const statuses = new Map([[OTHER_STATUS_KEY, OTHER_STATUS]]);
  const ctx = {
    model,
    hasUI: true,
    mode: "tui",
    ui: { setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); } },
  };
  extension({
    getSettings: () => structuredClone(settings),
    on(name, handler) { assert.equal(handlers.has(name), false); handlers.set(name, handler); },
    registerCommand() { assert.fail("Fast 模式不应注册或覆盖 /fast 工作流命令"); },
    registerProvider() { assert.fail("Fast 模式不应替换 provider"); },
  });
  return {
    ctx, statuses,
    updateSettings(next) { settings = next; },
    emit(name, event = {}) { return handlers.get(name)(event, ctx); },
    request(payload = { model: GPT_ID, input: [] }) { return handlers.get(REQUEST_EVENT)({ payload }, ctx); },
  };
}

test("默认开启及显式开启，OpenAI 系 GPT 请求只增加 Priority 且不修改原载荷", () => {
  for (const settings of [{}, { [SETTING_KEY]: true }]) {
    for (const api of OPENAI_CHAT_APIS) {
      const fixture = harness(settings, { id: GPT_ID, api });
      const reasoning = Object.freeze({ effort: "high" });
      const payload = Object.freeze({ model: GPT_ID, input: [], reasoning, temperature: 0.3, stream: true });
      const result = fixture.request(payload);
      assert.deepEqual(result, { ...payload, [TIER_FIELD]: PRIORITY_TIER });
      assert.notEqual(result, payload);
      assert.equal(result.reasoning, reasoning);
      assert.equal(payload[TIER_FIELD], undefined);
    }
  }
});

test("Gemini 原生协议注入 config.serviceTier，不创建或覆盖已有配置", () => {
  const fixture = harness({}, { id: GEMINI_ID, api: GOOGLE_API });
  assert.deepEqual(
    fixture.request({ model: GEMINI_ID, config: { temperature: 1 } }),
    { model: GEMINI_ID, config: { temperature: 1, [GOOGLE_TIER_FIELD]: PRIORITY_TIER } },
  );
  assert.deepEqual(fixture.request({ model: GEMINI_ID }), undefined);
  const explicit = { model: GEMINI_ID, config: { [GOOGLE_TIER_FIELD]: "flex" } };
  assert.equal(fixture.request(explicit), undefined);
  assert.equal(explicit.config[GOOGLE_TIER_FIELD], "flex");
  assert.equal(fixture.request({ model: GEMINI_ID, config: "broken" }), undefined);
});

test("Grok 走 OpenAI 系协议时注入 Priority", () => {
  const fixture = harness({}, { id: GROK_ID, api: COMPLETIONS_API });
  assert.deepEqual(fixture.request({ model: GROK_ID, messages: [] }), { model: GROK_ID, messages: [], [TIER_FIELD]: PRIORITY_TIER });
  // 视觉聊天仍是文本推理，不排除。
  assert.deepEqual(fixture.request({ model: "grok-2-vision" }), { model: "grok-2-vision", [TIER_FIELD]: PRIORITY_TIER });
  fixture.ctx.model = { id: GROK_ID, api: GOOGLE_API };
  assert.equal(fixture.request({ model: GROK_ID }), undefined);
});

test("Azure 部署别名遵循目录模型身份，且只对 GPT 注入", () => {
  const payload = { model: "deployment-eastus", input: [] };
  const fixture = harness({}, { id: GPT_ID, api: AZURE_API });
  assert.deepEqual(fixture.request(payload), { ...payload, [TIER_FIELD]: PRIORITY_TIER });
  // Azure 按目录身份识别，即使载荷只有部署名也注入。
  assert.deepEqual(fixture.request({}), { [TIER_FIELD]: PRIORITY_TIER });
  const gemini = harness({}, { id: GEMINI_ID, api: AZURE_API });
  assert.equal(gemini.request({ model: GEMINI_ID }), undefined);
});

test("关闭时不注入、不显示，也不修改已有显式服务等级", () => {
  const fixture = harness({ [SETTING_KEY]: false });
  fixture.emit(START_EVENT);
  assert.equal(fixture.statuses.has(STATUS_KEY), false);
  assert.equal(fixture.request(), undefined);
  const payload = { model: GPT_ID, [TIER_FIELD]: PRIORITY_TIER };
  assert.equal(fixture.request(payload), undefined);
  assert.equal(payload[TIER_FIELD], PRIORITY_TIER);
});

test("已有服务等级优先，不用默认 Fast 覆盖显式选择", () => {
  const fixture = harness();
  for (const tier of [DEFAULT_TIER, "auto", "flex", PRIORITY_TIER, "fast", "scale", null]) {
    const payload = Object.freeze({ model: GPT_ID, [TIER_FIELD]: tier });
    assert.equal(fixture.request(payload), undefined);
    assert.equal(payload[TIER_FIELD], tier);
  }
  assert.equal(fixture.request({ model: GPT_ID, [TIER_FIELD]: undefined })[TIER_FIELD], PRIORITY_TIER);
});

test("按真实请求模型识别 Fast 家族，包括提供方前缀，不改模型名", () => {
  const fixture = harness();
  for (const id of [GPT_ID, `openai/${GPT_ID}`, `relay/openai/${GPT_ID}`, "GPT-5.5"]) {
    assert.deepEqual(fixture.request({ model: id }), { model: id, [TIER_FIELD]: PRIORITY_TIER });
  }
  assert.equal(fixture.request({ model: FOREIGN_ID }), undefined);
});

test("非文本变体、非 Fast 家族和非目标协议不受影响，也不显示状态", () => {
  for (const id of [FOREIGN_ID, "text-embedding-3-large", "not-gpt-model", "gpt-image-1", "gpt-image",
    "gemini-3-pro-image", "gemini-2.5-flash-native-audio", "gemini-3.8-live"]) {
    const fixture = harness({}, { id, api: RESPONSE_API });
    fixture.emit(START_EVENT);
    assert.equal(fixture.statuses.has(STATUS_KEY), false);
    assert.equal(fixture.request({ model: id }), undefined);
  }
  for (const api of [FOREIGN_API, "google-vertex", "custom-api"]) {
    const fixture = harness({}, { id: GEMINI_ID, api });
    fixture.emit(START_EVENT);
    assert.equal(fixture.statuses.has(STATUS_KEY), false);
    assert.equal(fixture.request({ model: GEMINI_ID, config: {} }), undefined);
  }
});

test("无模型或不可识别的载荷保持不变，不猜测请求", () => {
  const fixture = harness({}, undefined);
  fixture.ctx.model = undefined;
  fixture.emit(START_EVENT);
  assert.equal(fixture.statuses.has(STATUS_KEY), false);
  assert.equal(fixture.request(), undefined);
  fixture.ctx.model = { id: GPT_ID, api: RESPONSE_API };
  for (const payload of [null, undefined, [], "body", 1, {}, { model: null }, { model: 42 }]) {
    assert.equal(fixture.emit(REQUEST_EVENT, { payload }), undefined);
  }
});

test("启动、模型切换、配置刷新与退出正确更新闪电状态", () => {
  const fixture = harness();
  fixture.emit(START_EVENT);
  assert.equal(fixture.statuses.get(STATUS_KEY), STATUS_LABEL);
  assert.equal(fixture.statuses.get(OTHER_STATUS_KEY), OTHER_STATUS);

  fixture.ctx.model = { id: FOREIGN_ID, api: FOREIGN_API };
  fixture.emit(SELECT_EVENT);
  assert.equal(fixture.statuses.has(STATUS_KEY), false);
  fixture.ctx.model = { id: GEMINI_ID, api: GOOGLE_API };
  fixture.emit(SELECT_EVENT);
  assert.equal(fixture.statuses.get(STATUS_KEY), STATUS_LABEL);

  fixture.updateSettings({ [SETTING_KEY]: false });
  fixture.emit(AGENT_EVENT);
  assert.equal(fixture.statuses.has(STATUS_KEY), false);
  assert.equal(fixture.request(), undefined);
  fixture.updateSettings({ [SETTING_KEY]: true });
  fixture.emit(AGENT_EVENT);
  assert.equal(fixture.statuses.get(STATUS_KEY), STATUS_LABEL);
  fixture.emit(STOP_EVENT);
  assert.equal(fixture.statuses.has(STATUS_KEY), false);
  assert.equal(fixture.statuses.get(OTHER_STATUS_KEY), OTHER_STATUS);
});

test("不缓存开关，遵循 Pi 返回的有效配置", () => {
  const fixture = harness({ [SETTING_KEY]: true });
  assert.equal(fixture.request()[TIER_FIELD], PRIORITY_TIER);
  fixture.updateSettings({ [SETTING_KEY]: false });
  assert.equal(fixture.request(), undefined);
  fixture.updateSettings({});
  assert.equal(fixture.request()[TIER_FIELD], PRIORITY_TIER);
});

test("无效配置显式报错并清除旧图标，不默认为开启", () => {
  const fixture = harness();
  fixture.emit(START_EVENT);
  for (const value of ["false", 0, 1, null, {}, []]) {
    fixture.updateSettings({ [SETTING_KEY]: value });
    assert.throws(() => fixture.emit(AGENT_EVENT), TypeError);
    assert.equal(fixture.statuses.has(STATUS_KEY), false);
    assert.throws(() => fixture.request(), new RegExp(SETTING_KEY));
  }
});

test("JSON/print 无 UI 模式仍注入参数，不访问 UI", () => {
  const fixture = harness();
  fixture.ctx.hasUI = false;
  delete fixture.ctx.ui;
  for (const name of [START_EVENT, SELECT_EVENT, AGENT_EVENT, STOP_EVENT]) fixture.emit(name);
  assert.equal(fixture.request()[TIER_FIELD], PRIORITY_TIER);
});

test("旧宿主没有原生配置 API 时明确拒绝加载，不增加兼容读取", () => {
  assert.throws(() => extension({ on() {} }), /pi\.getSettings/);
});

test("包资源清单实际加载新扩展，独立回归命令可用", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/fast-mode.js"));
  assert.ok(manifest.pi.extensions.includes("./extensions/skills-status.js"));
  assert.equal(manifest.scripts["test:fast-mode"], "node --test scripts/test-fast-mode.mjs");
});
