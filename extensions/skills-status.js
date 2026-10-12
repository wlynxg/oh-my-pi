import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = join(PACKAGE_ROOT, "scripts", "sync-skills.mjs");
const ADAPTIVE_SKILL = "adaptive-workflow";
const SKILL_FILENAME = "SKILL.md";
const ADAPTIVE_SKILL_PATH = join(PACKAGE_ROOT, "skills", ADAPTIVE_SKILL, SKILL_FILENAME);
const DESIGN_ONLY_POLICY = "当前请求只做澄清或方案：允许只读探索与方案记录，不实施业务改动。";
const MODE_POLICIES = {
  clarify: DESIGN_ONLY_POLICY,
  design: DESIGN_ONLY_POLICY,
  review: "当前请求默认只读审查；没有修正授权，不自动实施审查建议。",
  deep: "当前请求使用可审查记录与垂直切片，按已批准范围推进。",
  debug: "当前请求遵循 debugging-with-evidence：区分未复现、未验证与修复后仍失败，不给无证据的修复声明。",
};

const MODE_PREFIXES = [
  ["深度设计", "deep"],
  ["只做方案", "design"],
  ["调试", "debug"],
  ["审查", "review"],
  ["澄清", "clarify"],
  ["快修", "fast"],
  ["普通", "normal"],
];
const SLASH_MODES = new Map([
  ["fast", "fast"],
  ["clarify", "clarify"],
  ["deep", "deep"],
  ["design", "design"],
  ["review", "review"],
  ["debug", "debug"],
  ["normal", "normal"],
]);

const MODE_LABELS = {
  auto: "自动分级",
  fast: "快修",
  normal: "普通",
  deep: "深度",
  clarify: "只澄清",
  design: "只做方案",
  review: "审查",
  debug: "证据调试",
};

function getModeFromPrompt(prompt) {
  const text = String(prompt || "").trim();
  for (const [prefix, mode] of MODE_PREFIXES) {
    if (text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`)) return mode;
  }
  if (text.startsWith('<skill name="debugging-with-evidence"')) return "debug";
  const slash = text.match(/^\/(fast|clarify|deep|design|review|debug|normal)(?:\s|$)/);
  return slash ? SLASH_MODES.get(slash[1]) : undefined;
}

function compactNames(names, empty = "-") {
  const list = [...names].sort();
  return list.length > 0 ? list.join(", ") : empty;
}

function buildPolicy(mode) {
  const selected = mode === "auto" ? "自动判断 fast / normal / deep" : MODE_LABELS[mode] || mode;
  // 每轮读取同一份正文，避免入口提示与 skill 的确认、兼容和验收规则漂移。
  const guide = readFileSync(ADAPTIVE_SKILL_PATH, "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  return `<!-- personal-pi-mode:${mode} -->\n<skill name="${ADAPTIVE_SKILL}" location="${ADAPTIVE_SKILL_PATH}">\n${guide}\n</skill>\n当前请求模式：${selected}。${MODE_POLICIES[mode] || ""}`;
}

export default function personalPiSkillsExtension(pi) {
  let nextOverride;

  function modeCommand(prefix, mode, args, ctx) {
    const request = args.trim();
    if (!request) {
      nextOverride = mode;
      ctx.ui.notify(`下一条请求使用：${MODE_LABELS[mode]}`, "info");
      return;
    }
    pi.sendUserMessage(`${prefix} ${request}`);
  }

  function showSkills(ctx) {
    const available = ctx.getSystemPromptOptions?.()?.skills || [];
    const availableNames = available.map(skill => skill.name).sort();
    ctx.ui.notify(`已发现 skills：${compactNames(availableNames)}`, "info");
  }

  async function syncUpstream(ctx) {
    if (!existsSync(SYNC_SCRIPT)) {
      ctx.ui.notify(`同步脚本不存在：${SYNC_SCRIPT}`, "error");
      return;
    }
    ctx.ui.notify("正在分析上游 skill 变化，不会覆盖本地文件...", "info");
    const result = await ctx.exec("node", [SYNC_SCRIPT], { cwd: PACKAGE_ROOT });
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const tail = output.length > 1800 ? `...\n${output.slice(-1800)}` : output;
    ctx.ui.notify(result.code === 0 ? `同步分析完成\n${tail}` : `同步分析失败（${result.code}）\n${tail}`, result.code === 0 ? "info" : "error");
  }

  pi.registerCommand("fast", {
    description: "Use fast workflow for the next request or provided task",
    handler: (args, ctx) => modeCommand("快修", "fast", args, ctx),
  });
  pi.registerCommand("normal", {
    description: "Use normal workflow for the next request or provided task",
    handler: (args, ctx) => modeCommand("普通", "normal", args, ctx),
  });
  pi.registerCommand("clarify", {
    description: "Clarify a request without implementing it",
    handler: (args, ctx) => modeCommand("澄清", "clarify", args, ctx),
  });
  pi.registerCommand("deep", {
    description: "Use deep workflow for the next request or provided task",
    handler: (args, ctx) => modeCommand("深度设计", "deep", args, ctx),
  });
  pi.registerCommand("design", {
    description: "Produce a design or review packet without implementing",
    handler: (args, ctx) => modeCommand("只做方案", "design", args, ctx),
  });
  pi.registerCommand("review", {
    description: "Review current work using risk-first evidence",
    handler: (args, ctx) => modeCommand("审查", "review", args, ctx),
  });
  pi.registerCommand("skills", {
    description: "Show discovered skills",
    handler: (_args, ctx) => showSkills(ctx),
  });
  pi.registerCommand("sync-skills", {
    description: "Analyze Git upstream skill changes without overwriting local skills",
    handler: (_args, ctx) => syncUpstream(ctx),
  });

  pi.on("input", async event => {
    if (event.source === "extension") return;
    const text = String(event.text || "");
    const pendingMode = nextOverride;
    if (text === "/debug" || text.startsWith("/debug ")) {
      return { action: "transform", text: `/skill:debugging-with-evidence ${text.slice(6).trim()}`.trim() };
    }
    if (text === "调试" || text.startsWith("调试 ")) {
      return { action: "transform", text: `/skill:debugging-with-evidence ${text.slice(2).trim()}`.trim() };
    }
    if (pendingMode === "debug" && text && !text.startsWith("/skill:")) {
      return { action: "transform", text: `/skill:debugging-with-evidence ${text}` };
    }
  });

  pi.on("before_agent_start", async event => {
    const activeMode = getModeFromPrompt(event.prompt) || nextOverride || "auto";
    nextOverride = undefined;
    const policy = buildPolicy(activeMode);
    return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
  });
}
