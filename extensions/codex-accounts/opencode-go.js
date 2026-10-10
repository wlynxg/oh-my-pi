import { createHash } from "node:crypto";
import { isRecord } from "./storage.js";

export const GO_PROVIDER = "opencode-go";
export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_MS = 15_000;
const WINDOWS = [["rolling", "5h"], ["weekly", "周"], ["monthly", "月"]];
const LIMITED_STATUS = "rate-limited";
const STATUSES = new Set(["ok", LIMITED_STATUS]);

export async function resolveGoAuth(registry) {
  let resolved;
  try { resolved = await registry.getProviderAuth(GO_PROVIDER); }
  catch { throw new Error("OpenCode Go 认证解析失败，请检查 /login opencode-go。"); }
  const key = resolved?.auth?.apiKey;
  if (typeof key !== "string" || !key.trim()) throw new Error("没有 OpenCode Go API Key，请先 /login opencode-go。");
  // 缓存仅留凭据指纹，不另存或显示 API Key。
  return { key, tag: createHash("sha256").update(key).digest("hex") };
}

export function parseGoUsage(payload, capturedAt = Date.now()) {
  if (!isRecord(payload?.usage)) throw new Error("OpenCode Go 额度响应结构无效，未返回 usage。");
  const windows = {};
  for (const [name] of WINDOWS) {
    const value = payload.usage[name];
    if (!isRecord(value) || !STATUSES.has(value.status) || typeof value.percent !== "number" ||
        !Number.isFinite(value.percent) || value.percent < 0 || typeof value.resetsAt !== "string" ||
        !Number.isFinite(Date.parse(value.resetsAt))) {
      throw new Error("OpenCode Go 额度窗口缺失或字段无效，不将未知值解释为零额度。");
    }
    windows[name] = { usedPercent: value.percent, resetAt: Date.parse(value.resetsAt), limited: value.status === LIMITED_STATUS };
  }
  return { capturedAt, windows };
}

export async function queryGoUsage(key, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "personal-pi-skills/0.1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
    });
  } catch {
    // fetch 的异常可能含 Authorization 值，禁止把原始异常带入通知。
    throw new Error("OpenCode Go 额度查询网络失败或超时，未改变登录。");
  }
  if (!response.ok) throw new Error(`OpenCode Go 额度查询失败（HTTP ${response.status}），不将失败解释为零额度。`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("OpenCode Go 额度响应不是有效 JSON。"); }
  return parseGoUsage(payload);
}

export function formatGoQuota(report, now = Date.now()) {
  if (!report) return "额度未知（/account usage 刷新）";
  return WINDOWS.map(([name, label]) => {
    const value = report.windows[name];
    const remaining = value.resetAt <= now ? "待刷新" : `${Math.max(0, 100 - Math.min(100, value.usedPercent)).toFixed(0)}%`;
    const limited = value.limited && value.resetAt > now ? "（受限）" : "";
    return `${label} 剩余 ${remaining}${limited}`;
  }).join(" · ");
}

export function formatGoReport(report) {
  return [
    "OpenCode Go 套餐额度（不含 Zen 余额）",
    formatGoQuota(report),
    ...WINDOWS.map(([name, label]) => `${label} 重置：${new Date(report.windows[name].resetAt).toLocaleString()}`),
    `快照时间：${new Date(report.capturedAt).toLocaleString()}`,
  ].join("\n");
}
