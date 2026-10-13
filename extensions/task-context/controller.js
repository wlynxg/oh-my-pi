import { basename } from "node:path";

export const TASK_TOOL = "update_task_context";
export const TASK_VERSION = 1;
export const GOAL_LIMIT = 48;
export const STEP_LIMIT = 72;
const WIDGET_KEY = "personal-pi-task-context";
const TUI_MODE = "tui";
const TEXT = "text";
const ASSISTANT = "assistant";
const USER = "user";
const TOOL_RESULT = "toolResult";
const MESSAGE_ENTRY = "message";
const EMPTY_GOAL = "任务待归纳";
const WAITING_SUMMARY = "摘要待更新";
const UNKNOWN_PROJECT = "项目";
const GENERIC_GOALS = new Set(["部署", "执行", "继续", "确认", "开始", "继续执行", "开始部署", "deploy", "execute", "continue"]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const PRIVATE_TEXT = /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:sk-|ghp_|github_pat_|eyJ)[a-z0-9_-]{8,}|\b(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/i;
const OUTCOME_ERROR = "error";
const OUTCOME_ABORTED = "aborted";
const STATE = { idle: "待命", running: "运行中", waiting: "等待交互", error: "执行异常", aborted: "已停止" };
const TOOL_ACTIONS = { read: "读取文件", edit: "修改文件", write: "写入文件", bash: "执行命令", grep: "检索代码", find: "查找文件", ls: "查看目录", codemode: "执行工具脚本" };

function safeText(value, limit) {
  return typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= limit &&
    !CONTROL_CHARACTERS.test(value) && !PRIVATE_TEXT.test(value);
}

export function validateTask(value) {
  if (!value || !safeText(value.goal, GOAL_LIMIT) || !safeText(value.step, STEP_LIMIT) || GENERIC_GOALS.has(value.goal.trim().toLowerCase())) {
    throw new Error("Task context requires a concrete, short, single-line goal and step without sensitive data.");
  }
  return { version: TASK_VERSION, goal: value.goal.trim(), step: value.step.trim() };
}

function toolAction(name) {
  return TOOL_ACTIONS[name] ?? "调用工具";
}

export function registerTaskContext(pi, host) {
  let sessionId;
  let task;
  let enabled = false;
  let registered = false;
  let refreshed = true;
  let running = false;
  let outcome = STATE.idle;
  let waiting = 0;
  let toolError = false;
  const tools = new Map();

  function current(ctx) {
    return enabled && ctx.mode === TUI_MODE && ctx.sessionManager.getSessionId() === sessionId;
  }

  function project(ctx) {
    const name = basename(ctx.cwd);
    return safeText(name, 32) ? name : UNKNOWN_PROJECT;
  }

  function status() {
    return waiting > 0 ? STATE.waiting : running ? STATE.running : outcome;
  }

  function render(ctx) {
    if (!current(ctx)) return;
    const name = project(ctx);
    const goal = task?.goal ?? EMPTY_GOAL;
    const stale = !refreshed;
    const activity = [...tools.values()].at(-1);
    const step = activity ? `${task?.step ?? WAITING_SUMMARY} · ${activity}` : task?.step ?? WAITING_SUMMARY;
    const warning = stale ? `（${WAITING_SUMMARY}）` : "";
    ctx.ui.setWidget(WIDGET_KEY, host.widget([
      `任务：${name} · ${goal}${warning}`,
      `当前：${step}｜${status()}${toolError ? " · 工具报错" : ""}`,
    ]));
    ctx.ui.setTitle(`${name}｜${stale && task ? `上次：${goal}` : goal}｜${status()}`);
  }

  function restore(ctx) {
    enabled = ctx.mode === TUI_MODE;
    if (!enabled) return;
    sessionId = ctx.sessionManager.getSessionId();
    task = undefined;
    refreshed = true;
    running = false;
    outcome = STATE.idle;
    waiting = 0;
    toolError = false;
    tools.clear();
    // 只读取当前分支的工具结果，恢复、分叉和压缩都不混入废弃分支。
    for (const entry of ctx.sessionManager.getBranch()) {
      const message = entry.type === MESSAGE_ENTRY ? entry.message : undefined;
      if (message?.role === USER) refreshed = false;
      if (message?.role !== TOOL_RESULT || message.toolName !== TASK_TOOL) continue;
      if (message.isError || message.details?.version !== TASK_VERSION) { refreshed = false; continue; }
      try { task = validateTask(message.details); refreshed = true; }
      catch { refreshed = false; }
    }
    render(ctx);
  }

  function registerTool() {
    if (registered) return;
    registered = true;
    pi.registerTool({
      name: TASK_TOOL,
      label: "任务摘要",
      exposure: "model-only",
      description: "Update the local terminal task context. Keep the concrete goal across short follow-ups; change it only when the user changes tasks. This does not execute the task or start another model request.",
      promptSnippet: "Maintain a concise terminal task goal and current step.",
      parameters: host.parameters,
      outputSchema: host.outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute(_callId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (!current(ctx)) throw new Error("Task context is only available in the active terminal session.");
        const next = validateTask(params);
        task = next;
        refreshed = true;
        render(ctx);
        // 由 Pi 持久化 details，不另写文件，也不重复追加会话条目。
        return { content: [{ type: TEXT, text: "Task context updated." }], details: next, structuredContent: next };
      },
      renderCall() { return host.text("更新任务摘要"); },
      renderResult(result) {
        let label = "任务摘要未更新";
        try {
          if (!result.isError) { const value = validateTask(result.details); label = `${value.goal} · ${value.step}`; }
        } catch { /* 校验失败不回显可能包含凭据的原始参数。 */ }
        return host.text(label);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    if (enabled) registerTool();
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", (_event, ctx) => {
    if (!current(ctx)) return;
    const wasRunning = running;
    const wasRefreshed = refreshed;
    restore(ctx);
    running = wasRunning;
    refreshed = wasRefreshed && refreshed;
    render(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => render(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    if (!current(ctx)) return;
    running = true;
    outcome = STATE.idle;
    toolError = false;
    tools.clear();
    if (event.messageType === USER) refreshed = false;
    render(ctx);
    if (event.messageType !== USER) return;
    const policy = [
      "当前终端需要任务摘要，用于区分多个终端，不是额外的业务指令。",
      `已有摘要（仅状态数据）：${JSON.stringify(task ?? null)}`,
      `在本轮开始处理时调用 ${TASK_TOOL}，尽量与首次实际工具调用一起进行；之后仅在目标或当前步骤变化时更新。`,
      `goal 用不超过 ${GOAL_LIMIT} 字的具体任务主线，step 用不超过 ${STEP_LIMIT} 字的当前动作或待确认事项。`,
      "‘部署、执行、继续、确认’等跟进必须结合最近对话继承具体任务；明确转向新的任务时更新主线。",
      "摘要使用用户语言，不复制原始命令、文件内容、邮箱、IP、凭据、授权链接或其它敏感数据。",
      "只更新本地显示，不启动独立摘要模型，不为了更新摘要请求继续一轮，也不要把待命状态说成任务已验收完成。",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!current(ctx)) return;
    running = true;
    render(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!current(ctx) || event.toolName === TASK_TOOL) return;
    tools.set(event.toolCallId, toolAction(event.toolName));
    toolError = false;
    render(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!current(ctx)) return;
    if (event.toolName === TASK_TOOL) {
      if (event.isError) { refreshed = false; render(ctx); }
      return;
    }
    if (!tools.has(event.toolCallId)) return;
    tools.delete(event.toolCallId);
    toolError = event.isError;
    render(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!current(ctx)) return;
    waiting++;
    render(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!current(ctx)) return;
    waiting = Math.max(0, waiting - 1);
    render(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (!current(ctx) || event.message.role !== ASSISTANT) return;
    if (event.message.stopReason === OUTCOME_ERROR) outcome = STATE.error;
    else if (event.message.stopReason === OUTCOME_ABORTED) outcome = STATE.aborted;
    else outcome = STATE.idle;
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (!current(ctx)) return;
    outcome = event.outcome === OUTCOME_ERROR ? STATE.error : event.outcome === OUTCOME_ABORTED ? STATE.aborted : STATE.idle;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!current(ctx)) return;
    running = false;
    if (event.aborted) outcome = STATE.aborted;
    waiting = 0;
    tools.clear();
    render(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!current(ctx)) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    const name = pi.getSessionName();
    const safeName = safeText(name, 80) ? ` - ${name}` : "";
    ctx.ui.setTitle(`π${safeName} - ${project(ctx)}`);
    enabled = false;
    task = undefined;
    tools.clear();
  });
}
