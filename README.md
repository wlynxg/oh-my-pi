# Oh My Pi

面向个人使用的 Pi 扩展与开发工作流集合：包含 Fast 服务等级、Codex 多账号切换、Codex/OpenCode Go 额度查询，以及 8 个工作流 skills。工作流保留 superpowers 的需求理解和 skill 编写方法，吸收 ponytail 的复用与最小化原则；底线以 `adaptive-workflow/SKILL.md` 为唯一来源，每轮实际注入，其他 skills 按需读取。

## 安装

推荐从 GitHub 安装，方便在其他设备上使用和更新：

```bash
pi install git:github.com/wlynxg/oh-my-pi@main
```

更新到最新版本：

```bash
pi update git:github.com/wlynxg/oh-my-pi@main
```

安装或更新后运行 `/reload`，或者重启 Pi。确认当前安装来源：

```bash
pi list
```

本地仓库路径只用于开发和调试：

```bash
pi install /root/oh-my-pi
```

同一环境只保留 GitHub 或本地其中一种来源，避免同一套 skills 被重复加载。若同时使用上游 Superpowers，建议在 `pi config` 中关闭它的自动 bootstrap 扩展，只保留需要时显式调用的 skills。

### 从旧 skills 包迁移

已有 Git 来源安装先移除旧声明，再安装新仓库：

```bash
pi remove git:github.com/wlynxg/skills@main
pi install git:github.com/wlynxg/oh-my-pi@main
```

然后 `/reload` 或重启 Pi。若之前安装的是本地路径，使用 `pi list` 显示的旧来源执行 `pi remove`；不要同时加载旧、新仓库，否则命令会重复注册。

本仓保留原仓库完整 Git 历史、技能名称与历史会话文件，不迁移或修改个人 `auth.json`、Codex 账号快照。历史设计记录保留原名。

## 工作模式

默认自动分级，也可以用前缀或命令覆盖当前请求：

- `快修` 或 `/fast`：恢复既定行为或精确配置/文案调整，没有新的重要设计决策；不绕过确认和安全边界。
- `澄清` 或 `/clarify`：只澄清需求并给出短设计，不实现。
- `深度设计` 或 `/deep`：新子系统、稳定公共契约、跨域所有权、安全/金额/迁移/并发一致性等高影响任务；不只按文件数或耗时判断。
- `只做方案` 或 `/design`：只生成方案或 review packet。
- `审查` 或 `/review`：检查当前差异和验证证据。
- `调试` 或 `/debug`：从日志和复现证据开始排查，未完成原始复现验证时不声称修复。

默认不要求 TDD。认证、权限、金额、迁移、并发、数据丢失风险或明确回归问题，才会提高测试和验证强度。

### 职责分层

| 层级 | Skills | 使用边界 |
|---|---|---|
| 日常开发 | `adaptive-workflow`、`clarifying-requirements`、`debugging-with-evidence`、`verification-before-completion` | 分别负责流程、设计、故障和验收；只有 adaptive 正文每轮注入，其余按任务匹配。 |
| 复杂交付 | `reviewable-delivery` | 大需求/高影响任务的切片与审查，不要求每个小修改建 packet。 |
| 技能维护 | `creating-skills`、`absorbing-skills`、`syncing-upstream` | 只维护本库；编写负责评估，吸收负责来源与取舍，同步只在明确要求时检查。 |

8 个入口都保留，不按使用次数删除低频维护能力；没有新增技能。引用外部 API 文档不是技能吸收，普通功能开发不是技能编写；维护完成也不自动提交或推送。

### 决策底线

- 助手负责内部技术取舍，给推荐和理由；新功能与重要业务设计先对齐批准。已有完整批准或审阅方案后的明确委托不重复请示，部分回答不批准其他重要决策。
- 已确认未上线、未承诺旧契约且调用方可同步更新时，默认干净替换；不能仅凭 `dev`/版本号或仓内零引用推断。必要兼容先确认，放边界薄适配并记录删除条件。
- 未上线不代表能删数据；一次性迁移优先受控离线处理，不自动形成正式命令、常驻双写或新框架。安全、真实失败保护和明确要求的扩展不缩水。
- 检查边界不等于自动加缓存、重试、幂等和配置；优先复用框架与已有能力，减少长期概念和运行分支，而不只是缩短 diff。
- 完成前回到已批准验收项，核对实现、真实接入和实际证据；构建、局部单测、mock 或 skip 不证明整体完成。

默认回答先给核心结论：纯问答、确认或状态查询保持 1-3 句，需要枚举时使用紧凑列表；实际改动时才简短说明变更、验证和必要风险。最终答复额外用两行 `不确定：...`、`遗漏：...` 暴露真实缺口，每行一句；用户要求精确字符串、机器可读格式或仅输出命令结果时除外。只有用户要求细节、存在阻塞，或任务本身属于深度设计、审查、调试时才展开。

## 技能与工作流入口

不再显示技能次数、统计状态或统计 widget，也不再读取或写入技能使用计数。`/skills` 仅列出可用技能；技能加载、完整工作流正文注入与模式快捷命令保持不变。旧会话中的统计记录保留，不清理或改写历史文件。更新插件后 `/reload` 或重启 Pi 生效，旧界面由 Pi 原生重载流程清理。

扩展不是工具审批或操作系统沙箱，不能保证阻止所有违规操作；没有默认引入新的审批状态机。

可用命令：

```text
/skills
/debug <日志或问题>
/sync-skills
```

`/debug` 会显式加载证据调试 skill；普通日志、报错和异常任务也会按 skill 描述自动匹配。

## 多终端任务摘要

`extensions/task-context.js` 为 **Pi 1.2.0+ 的终端交互模式**提供任务摘要：终端标签显示“项目｜具体任务｜状态”，输入框上方固定两行显示任务主线和当前步骤。不会覆盖手动会话名，也不会改网页界面。

当前执行模型通过本地 `update_task_context` 工具维护摘要，结合已有主线与最近对话理解“部署／执行／继续”等跟进；真正换任务时才修改主线。没有独立摘要模型、后台请求或轮询，仍会增加普通对话中的提示、工具调用与 token 开销。

运行、交互等待、工具活动、中止和模型异常来自 Pi 事件；正常结束仅显示“待命”，不等于任务已完成验收。模型没有更新本轮摘要时明确标记“摘要待更新”，保留上一任务而不冒充当前结论。

摘要随工具结果保存，重载、恢复、分叉、压缩和树导航仅恢复当前分支的数据，不新增全局任务数据库或跨终端写锁。摘要要求不包含邮箱、IP、URL、凭据或原始敏感命令；扩展校验控制码和常见敏感格式，无效更新被拒绝且不回显原始参数。格式校验不等于能识别所有秘密，任务描述本身也应避免敏感内容。

Warp、手动固定标签名或终端设置可能覆盖程序标题，固定摘要栏仍可查看；扩展不修改 shell 配置。RPC、JSON、print 模式不会注册摘要工具、注入规则或写终端标题。更新 GitHub 插件后需 `/reload` 或重启加载。

## Fast 模式

独立扩展 `extensions/fast-mode.js`，使用 Pi 原生 `pi.getSettings()`；当前实现与验证基于 **Pi 1.0.0**，没有该 API 的旧宿主会明确报告加载错误，不另建兼容配置读取。

默认对以下有官方 Fast/Priority 能力的模型请求注入 `priority` 服务等级，不改模型、思考强度或提示词：

| 家族 | 协议 | 注入位置 | 说明 |
|---|---|---|---|
| `gpt-*` | OpenAI Responses / Codex Responses / Chat Completions / Azure Responses | 请求体 `service_tier: "priority"` | OpenAI 官方 `priority` 与 `fast` 等价；Azure 按目录模型身份识别，仅 GPT 部署注入。 |
| `gemini-*` | Google Generative AI 及 OpenAI 兼容端点 | 原生 `config.serviceTier: "priority"` / 兼容体 `service_tier` | Gemini 默认 standard，Priority 约贵 75–100%，可透明降级。 |
| `grok-*` | OpenAI 系协议 | 请求体 `service_tier: "priority"` | xAI Priority 约为标准价格的 2 倍。 |

图像、语音、embedding 等非文本推理变体不注入。Anthropic Claude 不注入：官方 `service_tier` 只有 `auto`/`standard_only`，默认 `auto` 已在有优先容量时自动使用，且新容量承诺已停售，没有可强制开启的 Fast 值。Azure Provisioned/PTU 与 Vertex 均为部署级容量，不属于请求参数。

当前模型适用且开关开启时，原生状态栏显示 `⚡ Fast`；关闭、切到非适用模型或退出时移除。不替换 footer，不影响其他扩展状态。

在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中配置：

```json
{
  "fastMode": false
}
```

省略或 `true` 为开启，`false` 关闭本扩展的自动注入；已信任项目配置优先于全局配置。修改后执行 `/reload` 或重启 Pi。配置必须是布尔值，无效类型会报告扩展错误并清除图标，不默认强开；Pi 的请求钩子报错后可能继续发送原请求，而不是强制中止。

已有显式 `service_tier`/`serviceTier` 优先保留，包括 `default`、`flex` 等。因此关闭本扩展不等于强制服务端 Standard，也不会覆盖其他配置已选择的等级或远端项目默认值。

**费用与结果边界：** Priority/Fast 会消耗更高的额度或费用（OpenAI/Codex 约为 Standard 的 2 倍额度，Gemini 约贵 75–100%，xAI 约 2 倍），具体取决于模型、账号和订阅。`⚡ Fast` 表示该扩展对当前模型的客户端默认策略开启，不是上游已接受 Fast、每个请求都采用 Fast 或实际提速的证明；实际处理层级应核对服务端回显（如响应 `service_tier`、`x-gemini-service-tier`）。不支持该参数的上游错误原样报告，不静默移除参数重试。Pi 本地费用估算不等于官方实际计费或订阅额度消耗。

依据：[OpenAI API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[Codex Speed](https://developers.openai.com/codex/speed)、[Anthropic Service tiers](https://docs.claude.com/en/api/service-tiers)、[Gemini Priority inference](https://ai.google.dev/gemini-api/docs/priority-inference)、[xAI Priority Processing](https://docs.x.ai/developers/advanced-api-usage/priority-processing)。

## Codex 多账号

`extensions/codex-accounts.js` 扩展复用 Pi 原生 `/login openai-codex` 和 OAuth 刷新，不覆盖 provider，也不安装第三方账号插件。Pi 的 `auth.json` 每个 provider 只有一个活跃凭证槽；本扩展将其他登录以 OAuth 凭据快照写在个人 agent 目录的 `codex-accounts.json`，文件权限设为 `0600`，内容包含可长期使用的 refresh token。请保护整个 `~/.pi/agent` 目录并避免同步到不可信位置；本地文件权限不等同于静态加密。

首次保存当前账号，再登录并保存其他账号：

```text
/login openai-codex
/account save personal
/login openai-codex
/account save work
/account list
/account switch personal
/account usage
```

支持 `/account`（打开选择器）、`save [名称]`、`switch [名称]`、`list`、`remove [名称]`、`usage`。`/account save` 不必填写名称：首次保存优先使用登录邮箱，已有别名保留。列表、切换弹窗、状态栏及操作提示优先显示凭据中的真实邮箱，而不是历史别名；取不到邮箱时明确标记“邮箱未知”并显示已有名称。切换／移除可使用邮箱或原别名；同一邮箱有多个工作区时不猜选，使用 `/account` 弹窗选择。快照以 **用户身份＋工作区** 识别：用户优先取 OAuth token 中的 `chatgpt_user_id`，其次 `user_id`／`sub`；`chatgpt_account_id` 是组织／工作区 ID，不能单独用它去重。同工作区不同用户分别保存，同一用户 token 轮换或邮箱变化不会仅因此生成重复快照。原生 OAuth 的 `accountId` 与额度请求 header 仍保留工作区 ID。

**旧快照升级：** 修复版本写入 v2 格式。读取 v1 时只在内存转换，保留名称、凭据、保存时间和额度快照，不立即改文件；后续确需保存、同步、切换、删除或额度写入时，在原锁与原子保存边界落盘 v2。用户身份缺失、格式或键不匹配时明确报错并保留原文件，不用邮箱猜测、不删除无法识别的条目。旧版本已经覆盖丢失的凭据无法自动恢复。

**升级前让相关 Pi 实例统一更新／重载，不能混用新旧账号扩展。** 旧插件不能读取 v2，应停止旧实例的账号操作。只修改本地仓库不会更新已安装 Git 包；`/reload` 加载的是实际安装来源，必须先应用包含修复的包版本。

**切换是全局的：** active Codex 登录写回 `auth.json`，同 agent 目录的其他 Pi 会话后续请求也会使用切换后的账号。为避免请求中途换号，当前会话忙碌时拒绝切换；如多个 Pi 进程并行使用同一 agent 目录，不要在另一个进程发请求期间切换。切换前会保存 Pi 已轮换的 token，并使用 Pi 的文件变更重载、refresh-token 流程；其他 provider 的认证不会改变。移除只删本地快照，不会退出或撤销平台账号。不要同时运行其他会改写同一 `openai-codex` 凭据槽的账号扩展。

`/account list` 会显示当前 Codex 账号和已有额度快照；`/account usage` 在当前模型提供方为 `opencode-go` 时查询 Go（见下节），其他情况下保持查询 Codex 的已有行为。Codex 查询通过账号专属 bearer token 与 `ChatGPT-Account-Id` 访问 `https://chatgpt.com/backend-api/wham/usage`，并校验响应账号 ID。状态栏对 Codex 显示账号名、主/次窗口剩余百分比和快照时间。请求响应头/流事件也可更新快照；无法判断或数据过期时显示未知/待刷新，而不是估算。达到限制或收到 429 时提示 `/account switch`，**不会自动换号、重试请求或消费另一个账号额度**。

身份字段依据：[OpenAI 官方 token 数据定义](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs)。

**额度接口限制：** `wham/usage` 是 Codex 当前使用但未作为稳定公开 API 承诺的端点；平台返回 403/432、限流、网络错误或字段变化时，命令报告查询失败，保留之前快照，不把错误当作余额 0。Codex 可以有额外模型额度窗和 credits；返回 `null` 的余额显示为未知，接口未返回的项不会猜测。剩余比例与重置时间是快照，不是实时保证；最终额度以 ChatGPT/Codex 官方用量页面为准。

### OpenCode Go 额度

已在 Pi 登录 OpenCode Go 的用户无需额外配置或再保存账号：在 `/model` 选择 `opencode-go` 模型，然后执行同一个命令：

```text
/account usage
```

复用 Pi 原生解析的 API Key，查询官方 `GET https://opencode.ai/zen/go/v1/usage`。显示 **5 小时、周、月剩余比例和重置时间**，例如：

```text
Go · 5h 剩余 100% · 周 剩余 95% · 月 剩余 93% · 快照 14:30:00
```

接口 `percent` 是已用比例，剩余为 `100 - percent`；受限窗口会标注“受限”，重置后的旧数据标注“待刷新”。**只在手动执行命令时查询**，启动/切换模型/每轮结束仅显示缓存，不新增定时轮询。Go 快照仅保存在当前扩展的内存中，重启或 `/reload` 后需再次查询；缓存按凭据指纹隔离，换 Key 不会沿用旧账号的数据。

HTTP 错误、超时、无订阅或字段不完整会明确报告失败，同一凭据下保留带时间的最后成功快照，不伪造零额度。不复制保存 Key，不请求浏览器 Cookie，不改 Codex 登录或账号文件。**此接口只返回 Go 套餐窗口，不包含 Zen 余额**；`save/switch/list/remove` 仍仅管理 Codex 账号。

依据：[官方额度路由](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)、[已合并 PR #16513](https://github.com/anomalyco/opencode/pull/16513)、[Go 官方文档](https://docs.opencode.ai/docs/go/)。自动测试使用假 Key；真实账号验证只查询额度，不发送模型生成请求。

### 验证

```bash
npm run test:accounts
npm run test:opencode-usage
```

覆盖凭据保存/轮换/切换、账号身份、文件权限/锁、异常数据、额度解析和命令行为；测试使用假 token 和模拟接口，不会进行真实 OAuth 登录或触碰现有 `auth.json`。

## Skill 来源

这些 skills 是针对 Pi 的本地改写和组合，不是对上游仓库的整套复制：

| 本地 skill | 主要来源 | 本地处理 |
|---|---|---|
| `adaptive-workflow` | [Ponytail](https://github.com/DietrichGebert/ponytail)、[Anthropic 官方指引](https://github.com/anthropics/claude-code) | 复用与最小维护负担；按阶段和真实消费者决定兼容，保留确认与数据安全。 |
| `clarifying-requirements` | [Superpowers](https://github.com/obra/superpowers) 的 `brainstorming`、Anthropic 的 `feature-dev` | 高影响澄清与批准；区分部分批准和既有授权，不强制小任务 PRD/spec。 |
| `creating-skills` | [Superpowers](https://github.com/obra/superpowers) 的 `writing-skills` 及其 skill 测试方法 | 保留渐进披露、压力场景和行为评估，按规则风险裁剪。 |
| `reviewable-delivery` | [Superpowers](https://github.com/obra/superpowers) 的验证与审查原则 | 可审查切片、复杂度检查与验收覆盖，复用记录而不堆多份产物。 |
| `verification-before-completion` | Superpowers 的 `verification-before-completion` | 逐项核对实现、接入与证据，不把局部通过当完整完成。 |
| `debugging-with-evidence` | [Superpowers](https://github.com/obra/superpowers)、[Addy Osmani agent-skills](https://github.com/addyosmani/agent-skills)、[Wshobson agents](https://github.com/wshobson/agents)、[Warp common-skills](https://github.com/warpdotdev/common-skills) | 融合复现、根因追踪、差分实验和 `blocked`/`unverified` 等证据状态，适配本地代码调试。 |
| `absorbing-skills` | 本地工作流 | 记录吸收、改写、拒绝和验证理由。 |
| `syncing-upstream` | 本地工作流 | 根据来源 manifest 生成上游差异报告，不自动覆盖本地 skills。 |

完整的 Git URL、baseline commit、文件映射、吸收内容、改写内容和拒绝内容见 [`sources/manifest.json`](sources/manifest.json)。[Fowler 的 YAGNI](https://martinfowler.com/bliki/Yagni.html) 与 [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) 是原则参考，不作为 Git skill 上游自动同步。

## 上游同步

来源和吸收记录在 `sources/manifest.json`。`syncing-upstream` 是手动 skill，不会被模型自动调用；需要时显式使用 `/skill:syncing-upstream`，或直接使用 `/sync-skills` 命令。先分析：

```bash
node scripts/sync-skills.mjs
```

输出报告技能及 manifest 已映射 reference/command 相对 baseline 的差异，不覆盖本地 `skills/`，也不自动推进 baseline。报告摘要可能截断；吸收前另读相关完整源文件。需要时可以写报告（自定义路径只能位于 `reports/`，不能经过符号链接）：

```bash
node scripts/sync-skills.mjs --write-report
```

已检查相关变化、吸收部分验证完成，并获得推进该来源 baseline 的明确授权后再执行；无需为了记录检查强制创建提交：

```bash
node scripts/sync-skills.mjs --source superpowers --mark-baseline superpowers --yes
```

## 验证

```bash
npm run validate
npm run test:sync
npm run test:extension
npm run test:fast-mode
npm run test:accounts
npm run test:opencode-usage
git diff --check
```

`docs/superpowers/specs/` 是历史设计记录，当前生效规则以 skills 正文和扩展为准。`evaluations/scenarios.md` 记录工作流场景；[开发阶段行为评估](evaluations/development-stage.md) 覆盖兼容、一次性迁移、部分批准、额外机制与假完成。

上述命令只验证结构和扩展/sync 行为，不会自动调用模型，也不证明实际任务已正确完成。修改纪律性规则时另做隔离模型行为对照，按真实结果报告，不用规则复述或选择评估代替业务端到端验证。
