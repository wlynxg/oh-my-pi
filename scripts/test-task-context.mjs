import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TASK_TOOL, TASK_VERSION, registerTaskContext, validateTask } from "../extensions/task-context/controller.js";

const GOAL = "Codex 多账号邮箱展示";
const STEP = "验证同组织账号切换";
const OTHER_GOAL = "修复Go额度展示";
const MANUAL_NAME = "手动会话名称";
const WIDGET_KEY = "personal-pi-task-context";
const OTHER_WIDGET = "other-extension";
const OTHER_CONTENT = "keep";
const TUI = "tui";
const USER = "user";
const MESSAGE = "message";
const BASE = "base prompt";
const DEPLOY = "部署";
const IDLE = "待命";
const RUNNING = "运行中";
const STALE = "摘要待更新";
const EMPTY = "任务待归纳";
const BASH = "bash";
const READ = "read";
const EDIT = "edit";
const BASH_ID = "bash-1";
const READ_ID = "a";
const EDIT_ID = "b";
const POLICY_EVENT = "before_agent_start";
const START_EVENT = "session_start";
const SETTLED_EVENT = "agent_settled";
const BOUNDARY_EVENT = "agent_before_settle";
const TOOL_START = "tool_execution_start";
const TOOL_END = "tool_execution_end";
const TREE_EVENT = "session_tree";
const SHUTDOWN_EVENT = "session_shutdown";
const TOOL_CONTEXT = { goal: GOAL, step: STEP };
const dataEntry = data => ({ type: MESSAGE, message: { role: "toolResult", toolName: TASK_TOOL, details: data, isError: false } });

function harness({ mode = TUI, sessionId = "session-a", branch = [], name = MANUAL_NAME } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const titles = [];
  const widgets = new Map();
  let activeBranch = branch;
  const ctx = {
    mode, cwd: "/tmp/oh-my-pi", hasUI: mode === TUI,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => activeBranch },
    ui: {
      setTitle(title) { titles.push(title); },
      setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
    },
  };
  registerTaskContext({
    on(event, handler) { assert.equal(handlers.has(event), false); handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getSessionName: () => name,
    setSessionName() { assert.fail("不能覆盖手动会话名称"); },
    appendEntry() { assert.fail("不能重复持久化已有工具结果"); },
    sendUserMessage() { assert.fail("不能启动额外模型轮次"); },
  }, { parameters: {}, outputSchema: {}, text: value => value, widget: lines => lines });
  const emit = (event, data = {}, context = ctx) => handlers.get(event)(data, context);
  const update = (value = TOOL_CONTEXT, context = ctx, signal = new AbortController().signal) => {
    const result = tools.get(TASK_TOOL).execute("context-call", value, signal, undefined, context);
    activeBranch = [...activeBranch, dataEntry(result.details)];
    return result;
  };
  return {
    ctx, tools, titles, widgets, emit, update,
    get lines() { return widgets.get(WIDGET_KEY); },
    get title() { return titles.at(-1); },
    set branch(value) { activeBranch = value; },
    start(prompt = "修改账户展示") { return emit(POLICY_EVENT, { messageType: USER, prompt, systemPrompt: BASE }); },
  };
}

test("工具在终端会话启动后接入，主模型规则保留且不启动独立摘要模型", () => {
  const h = harness();
  assert.equal(h.tools.size, 0);
  h.emit(START_EVENT);
  assert.equal(h.tools.get(TASK_TOOL).exposure, "model-only");
  const policy = h.start();
  assert.ok(policy.systemPrompt.startsWith(BASE));
  assert.ok(policy.systemPrompt.includes(TASK_TOOL));
  assert.ok(policy.systemPrompt.includes("不启动独立摘要模型"));
  assert.ok(policy.systemPrompt.includes("不为了更新摘要请求继续一轮"));
  assert.ok(policy.systemPrompt.includes("最近对话继承具体任务"));
  assert.equal(h.emit(POLICY_EVENT, { messageType: "custom", systemPrompt: BASE }), undefined);
});

test("实时显示具体任务及动作，不把部署/执行跟进变成新主线", () => {
  const h = harness(); h.emit(START_EVENT); h.start();
  const result = h.update();
  assert.deepEqual(result.details, { version: TASK_VERSION, ...TOOL_CONTEXT });
  assert.deepEqual(result.structuredContent, result.details);
  assert.equal(h.lines.length, 2);
  assert.ok(h.lines[0].includes(GOAL));
  assert.ok(h.title.includes(GOAL));
  h.emit(TOOL_START, { toolCallId: BASH_ID, toolName: BASH, args: { command: "curl https://private.example?token=do-not-display" } });
  assert.ok(h.lines[1].includes("执行命令"));
  assert.equal(h.lines.join().includes("private.example"), false);
  h.emit(TOOL_END, { toolCallId: BASH_ID, toolName: BASH, isError: false });
  h.emit(SETTLED_EVENT, { aborted: false });
  assert.ok(h.lines[1].includes(IDLE));
  assert.equal(h.lines[1].includes("已完成"), false);
  const policy = h.start(DEPLOY);
  assert.ok(policy.systemPrompt.includes(GOAL));
  assert.ok(h.lines[0].includes(STALE));
  assert.ok(h.title.includes("上次"));
  assert.throws(() => h.update({ goal: DEPLOY, step: "执行部署" }), /concrete/);
  h.update({ goal: GOAL, step: "部署邮箱展示插件" });
  assert.ok(h.lines[0].includes(GOAL));
  assert.equal(h.lines[0].includes(STALE), false);
});

test("明确转向新任务后更新摘要，而未更新时不冒充新任务", () => {
  const h = harness(); h.emit(START_EVENT); h.start(); h.update();
  h.emit(SETTLED_EVENT, { aborted: false });
  h.start("现在改处理Go额度");
  h.emit(SETTLED_EVENT, { aborted: false });
  assert.ok(h.lines[0].includes(STALE));
  h.start("处理Go额度"); h.update({ goal: OTHER_GOAL, step: "核对周窗口解析" });
  assert.ok(h.lines[0].includes(OTHER_GOAL));
  assert.equal(h.lines[0].includes(GOAL), false);
});

test("运行、交互、并行工具、错误重试及中止状态来自真实事件", () => {
  const h = harness(); h.emit(START_EVENT); h.start(); h.update();
  h.emit(TOOL_START, { toolCallId: READ_ID, toolName: READ });
  h.emit(TOOL_START, { toolCallId: EDIT_ID, toolName: EDIT });
  h.emit(TOOL_END, { toolCallId: READ_ID, toolName: READ, isError: false });
  assert.ok(h.lines[1].includes("修改文件"));
  h.emit("ui_prompt_start"); assert.ok(h.lines[1].includes("等待交互"));
  h.emit("ui_prompt_end"); assert.ok(h.lines[1].includes(RUNNING));
  h.emit(TOOL_END, { toolCallId: EDIT_ID, toolName: EDIT, isError: true });
  assert.ok(h.lines[1].includes("工具报错"));
  h.emit(BOUNDARY_EVENT, { outcome: "error" });
  h.emit(SETTLED_EVENT, { aborted: false }); assert.ok(h.title.includes("执行异常"));
  h.start("重试"); h.emit(BOUNDARY_EVENT, { outcome: "completed" });
  h.emit(SETTLED_EVENT, { aborted: false }); assert.ok(h.title.includes(IDLE));
  h.start("继续"); h.emit(SETTLED_EVENT, { aborted: true }); assert.ok(h.title.includes("已停止"));
});

test("恢复、重载、分叉、压缩和树导航只使用当前分支摘要", () => {
  const original = dataEntry({ version: TASK_VERSION, ...TOOL_CONTEXT });
  const h = harness({ branch: [original] }); h.emit(START_EVENT);
  assert.ok(h.lines[0].includes(GOAL));
  h.branch = [dataEntry({ version: TASK_VERSION, goal: "另一条分支的功能", step: "检查接口" })];
  h.emit(TREE_EVENT); assert.equal(h.lines[0].includes(GOAL), false);
  h.branch = [original]; h.emit(TREE_EVENT); assert.ok(h.lines[0].includes(GOAL));
  h.start(); h.emit("session_compact");
  assert.ok(h.lines[1].includes(RUNNING)); assert.ok(h.lines[0].includes(STALE));
  const fork = harness({ sessionId: "forked-session", branch: [original] }); fork.emit(START_EVENT);
  assert.ok(fork.lines[0].includes(GOAL));
  h.branch = [original, { type: MESSAGE, message: { role: USER, content: "换一个任务" } }];
  h.emit(TREE_EVENT); assert.ok(h.lines[0].includes(STALE));
  h.branch = []; h.emit(TREE_EVENT); assert.ok(h.lines[0].includes(EMPTY));
});

test("新会话与旧上下文隔离，关闭时只清理自己的widget并还原标题", () => {
  const h = harness(); h.emit(START_EVENT); h.start(); h.update();
  const other = { ...h.ctx, sessionManager: { getSessionId: () => "session-b", getBranch: () => [] } };
  const title = h.title;
  h.emit(TOOL_START, { toolCallId: "old", toolName: "write" }, other);
  assert.equal(h.title, title);
  assert.throws(() => h.update(TOOL_CONTEXT, other), /active terminal session/);
  h.widgets.set(OTHER_WIDGET, [OTHER_CONTENT]);
  h.emit(SHUTDOWN_EVENT); assert.equal(h.widgets.has(WIDGET_KEY), false);
  assert.deepEqual(h.widgets.get(OTHER_WIDGET), [OTHER_CONTENT]);
  assert.ok(h.title.includes(MANUAL_NAME));
  assert.throws(() => h.update(), /active terminal session/);
  h.emit(START_EVENT, {}, other); assert.ok(h.lines[0].includes(EMPTY));
});

test("任务摘要拒绝控制码和敏感数据，失败不回显原始参数、不覆盖上一条", () => {
  const h = harness(); h.emit(START_EVENT); h.start(); h.update();
  const original = h.title;
  for (const text of ["邮箱 user@example.test", "登录 https://auth.example", "目标 10.2.3.4", "sk-abcdefghijklmnop", "token=do-not-print", "操作\x1b]0;unsafe\x07", "方向\u202e欺骗", "x".repeat(100)]) {
    assert.throws(() => h.update({ goal: text, step: STEP }), /without sensitive data/);
    assert.equal(h.title, original);
    const rendered = h.tools.get(TASK_TOOL).renderResult({ details: { goal: text, step: STEP }, isError: false });
    assert.equal(rendered, "任务摘要未更新");
  }
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => h.update(TOOL_CONTEXT, h.ctx, aborted.signal));
  assert.equal(h.title, original);
  h.emit(TOOL_END, { toolName: TASK_TOOL, isError: true });
  assert.ok(h.lines[0].includes(GOAL)); assert.ok(h.lines[0].includes(STALE));
  assert.deepEqual(validateTask({ goal: ` ${GOAL} `, step: ` ${STEP} ` }), { version: TASK_VERSION, ...TOOL_CONTEXT });
});

test("不注册工具或更新UI到RPC、JSON、print模式，也不复活技能统计", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = harness({ mode }); h.emit(START_EVENT);
    assert.equal(h.tools.size, 0);
    assert.equal(h.start(), undefined);
    h.emit(SETTLED_EVENT, { aborted: false });
    assert.equal(h.titles.length, 0); assert.equal(h.widgets.size, 0);
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/task-context.js"));
  assert.ok(manifest.scripts["test:task-context"]);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies[name], undefined);
  }
});
