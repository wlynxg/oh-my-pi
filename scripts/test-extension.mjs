#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import extension from "../extensions/skills-status.js";

const INPUT_EVENT = "input";
const POLICY_EVENT = "before_agent_start";
const DEBUG_SKILL = "debugging-with-evidence";
const REQUEST = "检查超时";
const BASE_PROMPT = "base";
const MODE = {
  auto: "auto", fast: "fast", normal: "normal", deep: "deep",
  clarify: "clarify", design: "design", review: "review", debug: "debug",
};
const AUTO_MARKER = `personal-pi-mode:${MODE.auto}`;
const ADAPTIVE_BODY = readFileSync("skills/adaptive-workflow/SKILL.md", "utf8")
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
  .trim();
const handlers = new Map();
const commands = new Map();
const sent = [];
const notifications = [];
const executions = [];

extension({
  on(name, handler) {
    assert.equal(handlers.has(name), false);
    handlers.set(name, handler);
  },
  registerCommand(name, options) {
    commands.set(name, options);
  },
  appendEntry() {
    assert.fail("工作流扩展不应再写入技能统计");
  },
  sendUserMessage(text) {
    sent.push(text);
  },
});

// 统计链路整体删除，而不只是隐藏 widget；历史会话由 Pi 原生维护。
assert.deepEqual([...handlers.keys()].sort(), [INPUT_EVENT, POLICY_EVENT].sort());
const skills = ["adaptive-workflow", "reviewable-delivery", DEBUG_SKILL, "clarifying-requirements"]
  .map(name => ({ name, filePath: `${process.cwd()}/skills/${name}/SKILL.md` }));
const sessionManager = {
  getBranch() {
    assert.fail("工作流扩展不应再读取历史统计");
  },
};
const ctx = {
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  ui: {
    setStatus() {
      assert.fail("工作流扩展不应再渲染技能计数状态");
    },
    setWidget() {
      assert.fail("工作流扩展不应再渲染技能计数 widget");
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  },
  sessionManager,
  getSystemPromptOptions: () => ({ skills }),
  exec: async (...args) => {
    executions.push(args);
    return { stdout: "ok", stderr: "", code: 0 };
  },
};
const policyFor = prompt => handlers.get(POLICY_EVENT)({ prompt, systemPrompt: BASE_PROMPT, systemPromptOptions: { skills } }, ctx);
const input = (text, source = "interactive") => handlers.get(INPUT_EVENT)({ source, text }, ctx);

const before = await policyFor('<skill name="reviewable-delivery" location="/tmp/reviewable-delivery/SKILL.md">\nbody\n</skill>');
assert.ok(before.systemPrompt.startsWith(`${BASE_PROMPT}\n\n`));
assert.ok(before.systemPrompt.includes("当前请求模式：自动判断"));
assert.ok(before.systemPrompt.includes(ADAPTIVE_BODY));
for (const rule of ["先回答用户当前问题", "用 1-3 句", "不确定：...", "遗漏：...", "用户要求精确字符串"]) {
  assert.ok(before.systemPrompt.includes(rule), `输出规则缺失：${rule}`);
}

// 移除统计不能削弱模式路由、完整正文注入或设计授权边界。
const modePrompts = new Map([
  [MODE.auto, "新增一个功能"], [MODE.fast, "快修 修改超时"], [MODE.normal, "普通 修改接口"],
  [MODE.deep, "深度设计 修改跨域数据流"], [MODE.clarify, "澄清 导出范围"],
  [MODE.design, "只做方案 新功能"], [MODE.review, "审查 当前差异"], [MODE.debug, "/debug 错误日志"],
]);
for (const [mode, prompt] of modePrompts) {
  const policy = await policyFor(prompt);
  assert.ok(policy.systemPrompt.includes(`personal-pi-mode:${mode}`), `模式错误：${mode}`);
  assert.ok(policy.systemPrompt.includes(ADAPTIVE_BODY), `完整正文缺失：${mode}`);
  for (const rule of ["等待明确批准", "默认直接替换", "一次性操作", "不静默替换系统实现", "未实现、未验证和环境阻塞分别报告"]) {
    assert.ok(policy.systemPrompt.includes(rule), `规则缺失：${mode} / ${rule}`);
  }
  assert.equal(policy.systemPrompt.includes("明确、局部、低风险的小改动直接完成"), false);
  if ([MODE.clarify, MODE.design].includes(mode)) assert.ok(policy.systemPrompt.includes("不实施业务改动"));
  if (mode === MODE.review) assert.ok(policy.systemPrompt.includes("不自动实施审查建议"));
  if (mode === MODE.debug) assert.ok(policy.systemPrompt.includes("区分未复现、未验证与修复后仍失败"));
}

for (const text of ["调试 webhook 偶发失败", "/debug webhook 偶发失败"]) {
  assert.deepEqual(await input(text), { action: "transform", text: `/skill:${DEBUG_SKILL} webhook 偶发失败` });
}
assert.equal(await input("/debug 忽略扩展输入", "extension"), undefined);
assert.equal(await input("/skill:reviewable-delivery"), undefined);
const expandedDebug = await policyFor(`<skill name="${DEBUG_SKILL}" location="/tmp/${DEBUG_SKILL}/SKILL.md">\nbody\n</skill>`);
assert.ok(expandedDebug.systemPrompt.includes(`personal-pi-mode:${MODE.debug}`));

const modeCommands = new Map([
  [MODE.fast, "快修"], [MODE.normal, "普通"], [MODE.clarify, "澄清"], [MODE.deep, "深度设计"],
  [MODE.design, "只做方案"], [MODE.review, "审查"],
]);
for (const [mode, prefix] of modeCommands) {
  await commands.get(mode).handler(REQUEST, ctx);
  assert.equal(sent.at(-1), `${prefix} ${REQUEST}`);
  assert.ok((await policyFor(sent.at(-1))).systemPrompt.includes(`personal-pi-mode:${mode}`));
  await commands.get(mode).handler("", ctx);
  await input(REQUEST);
  assert.ok((await policyFor(REQUEST)).systemPrompt.includes(`personal-pi-mode:${mode}`));
  assert.ok((await policyFor(REQUEST)).systemPrompt.includes(AUTO_MARKER), "模式覆盖必须仅作用于下一条请求");
}

await commands.get("skills").handler("", ctx);
const discovered = notifications.at(-1).message;
assert.equal(discovered, `已发现 skills：${skills.map(skill => skill.name).sort().join(", ")}`);
assert.equal(/观测|使用次数|\*\d/.test(discovered), false);
await commands.get("sync-skills").handler("", ctx);
assert.equal(executions.length, 1);
assert.equal(executions[0][0], "node");
assert.ok(executions[0][1][0].endsWith("/scripts/sync-skills.mjs"));
assert.ok(notifications.at(-1).message.includes("同步分析完成"));

// JSON/print 模式不需要 UI，也不能恢复或持久化技能计数。
const headless = { isIdle: () => true, sessionManager };
const headlessPolicy = await handlers.get(POLICY_EVENT)({ prompt: REQUEST, systemPrompt: BASE_PROMPT }, headless);
assert.ok(headlessPolicy.systemPrompt.includes(ADAPTIVE_BODY));
assert.ok(headlessPolicy.systemPrompt.includes(AUTO_MARKER));
console.log("扩展验证通过：统计链路移除，完整规则、所有模式、调试别名、技能列表、同步入口及无 UI 注入保留");
