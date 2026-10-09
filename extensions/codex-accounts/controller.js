import { PROVIDER } from "./storage.js";
import { formatQuota, formatReport, isExhausted, parseHeaders, parseRateEvent, queryUsage } from "./usage.js";

const COMMAND = "account";
const STATUS_KEY = "codex-accounts";
const MESSAGE_TYPE = "codex-account-status";
const OPERATIONS = ["save", "switch", "list", "remove", "usage"];
const INFO = "info";
const ERROR = "error";
const WARNING = "warning";
const HELP = "/account [save 名称 | switch 名称 | list | remove 名称 | usage]\n先 /login openai-codex，再 /account save；添加另一账号前请先保存当前登录。";
const UNSAVED = "未保存";

export function registerAccounts(pi, store, { fetchImpl = globalThis.fetch } = {}) {
  let latestUsage;
  let requestAccount;
  let warned = false;

  function notify(ctx, text, level = INFO) {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: false });
  }

  function clear(ctx) { if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined); }

  function quota(id, accounts) {
    const saved = accounts[id]?.usage;
    return latestUsage?.id === id && (!saved || latestUsage.report.capturedAt >= saved.capturedAt) ? latestUsage.report : saved;
  }

  function refresh(_event, ctx) {
    if (ctx.mode !== "tui") return;
    if (ctx.model?.provider !== PROVIDER) { clear(ctx); return; }
    try {
      const { current, accounts } = store.view();
      if (!current) { clear(ctx); return; }
      const name = accounts[current.id]?.name ?? UNSAVED;
      const report = quota(current.id, accounts);
      const time = report ? ` · 快照 ${new Date(report.capturedAt).toLocaleTimeString()}` : "";
      ctx.ui.setStatus(STATUS_KEY, `👤 ${name} · ${formatQuota(report)}${time}`);
    } catch (error) {
      clear(ctx);
      throw error;
    }
  }

  function list(ctx) {
    const { current, accounts } = store.view();
    const lines = Object.entries(accounts).map(([id, entry]) => {
      const report = quota(id, accounts);
      return `${id === current?.id ? "●" : "○"} ${entry.name} · ${formatQuota(report)}${report ? `（缓存 ${new Date(report.capturedAt).toLocaleString()}）` : ""}`;
    });
    if (current && !accounts[current.id]) lines.unshift(`● 当前登录${UNSAVED}，请先 /account save。`);
    notify(ctx, lines.join("\n") || "尚无已保存账号，请先 /login openai-codex，再 /account save。");
    refresh({}, ctx);
  }

  async function choose(ctx, suppliedName, action) {
    const accounts = store.readAccounts().accounts;
    const entries = Object.entries(accounts);
    if (suppliedName) {
      const match = Object.hasOwn(accounts, suppliedName) ? [suppliedName, accounts[suppliedName]] : entries.find(([, entry]) => entry.name === suppliedName);
      if (!match) throw new Error("没有找到已保存的账号，先执行 /account list。");
      return match[0];
    }
    if (!entries.length) throw new Error("尚无已保存账号，请先 /account save。");
    if (!ctx.hasUI) throw new Error("非交互模式请显式指定账号名称。");
    const labels = entries.map(([id, entry]) => `${entry.name} · ${formatQuota(quota(id, accounts))}`);
    const selected = await ctx.ui.select(action, labels);
    return selected === undefined ? undefined : entries[labels.indexOf(selected)]?.[0];
  }

  async function record(id, report, ctx) {
    latestUsage = { id, report };
    await store.recordUsage(id, report);
    refresh({}, ctx);
    if (isExhausted(report) && !warned) {
      warned = true;
      notify(ctx, "Codex 额度窗口已到限制，可使用 /account switch 切换已保存账号；不会自动轮换。", WARNING);
    }
  }

  async function usage(ctx) {
    if (!store.current()) throw new Error("没有 Codex 登录，请先 /login openai-codex。");
    // 原生解析负责到期刷新与轮换落盘；不复制 OAuth 逻辑，也不打印解析出的 token。
    let resolved;
    try { resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER); }
    catch { throw new Error("Codex 原生认证解析或刷新失败，请检查 /login；已有账号未被替换。"); }
    const active = await store.syncActive();
    if (!active || resolved?.auth?.apiKey !== active.credential.access) {
      throw new Error("当前认证已变化或被覆盖，请重试；不使用不匹配的凭据查询额度。");
    }
    const report = await queryUsage(active.credential, active.id, fetchImpl);
    await record(active.id, report, ctx);
    const entry = store.readAccounts().accounts[active.id];
    notify(ctx, `${entry?.name ?? UNSAVED}\n${formatReport(report)}`);
  }

  pi.registerCommand(COMMAND, {
    description: "保存和切换 Codex 账号，查询剩余额度（save/switch/list/remove/usage）",
    getArgumentCompletions(prefix) {
      const match = prefix.match(/^(\S*)\s*([\s\S]*)$/);
      const operation = match?.[1] ?? "";
      if (!prefix.includes(" ")) return OPERATIONS.filter((name) => name.startsWith(operation)).map((name) => ({ value: name, label: name }));
      if (!OPERATIONS.slice(1, 4).includes(operation) || operation === "list") return null;
      const names = Object.values(store.readAccounts().accounts).map((entry) => entry.name);
      return names.filter((name) => name.startsWith(match?.[2] ?? "")).map((name) => ({ value: `${operation} ${name}`, label: name }));
    },
    async handler(args, ctx) {
      const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const operation = match?.[1] ?? "";
      const name = match?.[2]?.trim();
      try {
        if (operation === "save") {
          const saved = await store.save(name);
          notify(ctx, `已保存 Codex 账号：${saved.name}。`);
          refresh({}, ctx);
        } else if (operation === "switch" || !operation) {
          if (!ctx.isIdle()) throw new Error("请先按 Esc 停止当前请求，待会话空闲后切换账号。");
          const id = await choose(ctx, name, "切换 Codex 账号");
          if (id === undefined) return;
          const selected = await store.switch(id);
          requestAccount = undefined;
          warned = false;
          // Pi 1.1 按文件版本重读 auth；刷新模型可用性后重载，保留原始 expires。
          const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: false });
          if (result.errors?.has(PROVIDER)) throw new Error("登录槽已切换，但模型可用性刷新失败；旧账号已保存，可手动切回。");
          notify(ctx, `已全局切换至 ${selected.name}，正在重载；其他会话的新请求也会使用此账号。`);
          await ctx.reload();
          return; // 不复用已经失效的扩展上下文。
        } else if (operation === "list") {
          list(ctx);
        } else if (operation === "usage") {
          await usage(ctx);
        } else if (operation === "remove") {
          const id = await choose(ctx, name, "移除已保存的账号快照");
          if (id === undefined) return;
          if (!ctx.hasUI) throw new Error("移除快照需要交互确认，请在 Pi 界面执行。");
          const entry = store.readAccounts().accounts[id];
          if (!await ctx.ui.confirm("移除账号快照", `仅删除 ${entry.name} 的本地快照，不退出当前登录、不撤销平台凭据。`)) return;
          await store.remove(id);
          if (latestUsage?.id === id) latestUsage = undefined;
          notify(ctx, "已移除快照；当前 auth.json 登录未改变。");
          refresh({}, ctx);
        } else {
          notify(ctx, HELP);
        }
      } catch (error) {
        notify(ctx, error.message, ERROR);
      }
    },
  });

  pi.on("session_start", refresh);
  pi.on("model_select", refresh);
  pi.on("before_agent_start", refresh);
  pi.on("before_provider_request", async (_event, ctx) => {
    requestAccount = undefined;
    if (ctx.model?.provider !== PROVIDER) return;
    const active = await store.syncActive();
    if (active) requestAccount = { id: active.id, access: active.credential.access };
  });
  pi.on("after_provider_response", async (event, ctx) => {
    if (!requestAccount || ctx.model?.provider !== PROVIDER) return;
    // 共享认证被其他进程改动时不归入当前账号，避免把旧响应配额串到新账号。
    const current = store.current();
    if (current?.id !== requestAccount.id || current.credential.access !== requestAccount.access) return;
    const report = parseHeaders(event.headers);
    if (report) await record(requestAccount.id, report, ctx);
    if (event.status === 429 && !warned) {
      warned = true;
      notify(ctx, "Codex 返回 429（可能是额度或速率限制），可使用 /account usage 核实、/account switch 手动切换。", WARNING);
    }
  });
  pi.on("provider_stream_event", async (event, ctx) => {
    if (event.provider !== PROVIDER || !requestAccount) return;
    const current = store.current();
    if (current?.id !== requestAccount.id || current.credential.access !== requestAccount.access) return;
    const report = parseRateEvent(event.data);
    if (report) await record(requestAccount.id, report, ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.model?.provider === PROVIDER) await store.syncActive();
    requestAccount = undefined;
    refresh({}, ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    clear(ctx);
    requestAccount = undefined;
    latestUsage = undefined;
    if (ctx.model?.provider === PROVIDER) await store.syncActive();
  });
}
