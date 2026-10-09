import { isRecord } from "./storage.js";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PRIORITY_HEADER_PREFIX = "x-codex";
const WINDOW_PRIMARY = "primary";
const WINDOW_SECONDARY = "secondary";
const USAGE_TIMEOUT_MS = 15_000;

function number(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function window(value) {
  if (!isRecord(value)) return undefined;
  const usedPercent = number(value.used_percent);
  if (usedPercent === undefined || usedPercent < 0) return undefined;
  const windowSeconds = number(value.limit_window_seconds) ?? (number(value.window_minutes) === undefined ? undefined : number(value.window_minutes) * 60);
  const resetAt = number(value.reset_at);
  if (usedPercent === 0 && (!windowSeconds || windowSeconds === 0) && !resetAt) return undefined;
  return {
    usedPercent,
    windowSeconds,
    resetAt,
  };
}

function credits(value) {
  if (!isRecord(value) || typeof value.has_credits !== "boolean" || typeof value.unlimited !== "boolean") return undefined;
  const rawBalance = typeof value.balance === "string" ? value.balance.trim() : value.balance;
  const balance = typeof rawBalance === "number" ? (Number.isFinite(rawBalance) ? String(rawBalance) : undefined) :
    typeof rawBalance === "string" && rawBalance.length <= 80 && /^\d+(?:\.\d+)?$/.test(rawBalance) ? rawBalance : undefined;
  return { hasCredits: value.has_credits, unlimited: value.unlimited, balance };
}

function additionalLimits(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.rate_limit)) return [];
    const label = entry.limit_name ?? entry.metered_feature;
    return [{
      label: typeof label === "string" ? label.slice(0, 60).replace(/[\x00-\x1f\x7f]/g, "") : "额外额度",
      primary: window(entry.rate_limit.primary_window),
      secondary: window(entry.rate_limit.secondary_window),
    }];
  }).filter((entry) => entry.primary || entry.secondary);
}

export function parseUsage(payload, capturedAt = Date.now()) {
  if (!isRecord(payload)) throw new Error("额度接口响应结构无效。");
  const rate = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const report = {
    capturedAt, source: "usage",
    primary: window(rate.primary_window), secondary: window(rate.secondary_window),
    credits: credits(payload.credits),
    additional: additionalLimits(payload.additional_rate_limits),
    limitReached: rate.limit_reached === true, allowed: rate.allowed,
  };
  if (!report.primary && !report.secondary && !report.credits && !report.additional.length) throw new Error("额度接口未返回可展示的数据。");
  return report;
}

export function parseHeaders(headers, capturedAt = Date.now()) {
  const values = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const readWindow = (name) => {
    const prefix = `${PRIORITY_HEADER_PREFIX}-${name}`;
    return window({
      used_percent: values[`${prefix}-used-percent`],
      window_minutes: values[`${prefix}-window-minutes`],
      reset_at: values[`${prefix}-reset-at`],
    });
  };
  const boolean = (value) => value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : undefined;
  const report = {
    capturedAt, source: "headers",
    primary: readWindow(WINDOW_PRIMARY), secondary: readWindow(WINDOW_SECONDARY),
    credits: credits({
      has_credits: boolean(values[`${PRIORITY_HEADER_PREFIX}-credits-has-credits`]),
      unlimited: boolean(values[`${PRIORITY_HEADER_PREFIX}-credits-unlimited`]),
      balance: values[`${PRIORITY_HEADER_PREFIX}-credits-balance`],
    }),
    additional: [],
  };
  for (const key of Object.keys(values)) {
    const match = key.match(/^x-codex-(.+)-primary-used-percent$/);
    if (!match) continue;
    const prefix = `x-codex-${match[1]}`;
    const extra = window({
      used_percent: values[key],
      window_minutes: values[`${prefix}-primary-window-minutes`],
      reset_at: values[`${prefix}-primary-reset-at`],
    });
    const extraSecondary = window({
      used_percent: values[`${prefix}-secondary-used-percent`],
      window_minutes: values[`${prefix}-secondary-window-minutes`],
      reset_at: values[`${prefix}-secondary-reset-at`],
    });
    if (extra || extraSecondary) report.additional.push({ label: match[1], primary: extra, secondary: extraSecondary });
  }
  return report.primary || report.secondary || report.credits || report.additional.length ? report : undefined;
}

export function parseRateEvent(event, capturedAt = Date.now()) {
  if (!isRecord(event) || event.type !== "codex.rate_limits") return undefined;
  try {
    const rate = event.rate_limits ?? {};
    return { ...parseUsage({ rate_limit: { primary_window: rate.primary, secondary_window: rate.secondary }, credits: event.credits }, capturedAt), source: "stream" };
  } catch {
    // 未识别的通知不覆盖已有快照；不是成功查询，也不伪造零额度。
    return undefined;
  }
}

export async function queryUsage(credential, id, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.access}`, "ChatGPT-Account-Id": id, "User-Agent": "pi-codex-accounts" },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS), redirect: "error",
    });
  } catch {
    throw new Error("额度查询网络失败或超时，登录与已有快照未改变。");
  }
  if (!response.ok) throw new Error(`额度查询失败（HTTP ${response.status}），不将失败解释成零额度。`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("额度接口响应不是有效 JSON。"); }
  if (!isRecord(payload)) throw new Error("额度接口响应结构无效。");
  if (payload.account_id !== undefined && payload.account_id !== id) throw new Error("额度响应账号身份不匹配，拒绝归入当前账号。");
  return parseUsage(payload);
}

function windowLabel(value, fallback) {
  const seconds = value.windowSeconds;
  if (seconds === 604800) return "周";
  if (seconds === 18000) return "5h";
  if (seconds > 0) return `${Math.round(seconds / 60)}m`;
  return fallback;
}

function remaining(value, now) {
  if (!value || !Number.isFinite(value.usedPercent)) return "?";
  // 窗口已重置不能推断已补满，也不能继续把旧 0% 作为当前值。
  if (value.resetAt && value.resetAt * 1000 <= now) return "待刷新";
  return `${Math.max(0, 100 - Math.min(100, value.usedPercent)).toFixed(0)}%`;
}

export function formatQuota(report, now = Date.now()) {
  if (!report) return "额度未知";
  const parts = [];
  for (const [key, fallback] of [[WINDOW_PRIMARY, "主窗"], [WINDOW_SECONDARY, "次窗"]]) {
    const value = report[key];
    if (value) parts.push(`${windowLabel(value, fallback)} ${remaining(value, now)}`);
  }
  if (report.credits) {
    const value = report.credits;
    parts.push(value.unlimited ? "credits ∞" : value.balance !== undefined ? `credits ${value.balance}` : value.hasCredits ? "credits 未知" : "无 credits");
  }
  for (const item of report.additional ?? []) {
    const values = [item.primary, item.secondary].filter(Boolean).map((value, index) => `${windowLabel(value, index === 0 ? "主窗" : "次窗")} ${remaining(value, now)}`);
    if (values.length) parts.push(`${item.label}: ${values.join("/")}`);
  }
  return parts.join(" · ") || "额度未知";
}

export function formatReport(report) {
  const lines = [formatQuota(report), `快照时间：${new Date(report.capturedAt).toLocaleString()}`];
  for (const key of [WINDOW_PRIMARY, WINDOW_SECONDARY]) {
    const value = report[key];
    if (value?.resetAt) lines.push(`${windowLabel(value, key === WINDOW_PRIMARY ? "主窗" : "次窗")} 重置：${new Date(value.resetAt * 1000).toLocaleString()}`);
  }
  for (const item of report.additional ?? []) {
    if (item.label) lines.push(`${item.label}:`);
    for (const key of ["primary", "secondary"]) {
      const value = item[key];
      if (value?.resetAt) lines.push(`${item.label} ${windowLabel(value, key === "primary" ? "主窗" : "次窗")} 重置：${new Date(value.resetAt * 1000).toLocaleString()}`);
    }
  }
  if (report.limitReached || report.allowed === false) lines.push("当前限制已到达，可使用 /account switch 切换；credits 与额外模型额度需以平台为准。");
  return lines.join("\n");
}

export function isExhausted(report) {
  const windows = [report?.primary, report?.secondary, ...(report?.additional ?? []).flatMap((item) => [item.primary, item.secondary])];
  return report?.limitReached === true || report?.allowed === false || windows.some((value) => value && value.usedPercent >= 100 && (!value.resetAt || value.resetAt * 1000 > Date.now()));
}
