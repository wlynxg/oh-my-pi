import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "./codex-accounts/storage.js";
import { registerAccounts } from "./codex-accounts/controller.js";

export default function codexAccounts(pi) {
  const [major, minor] = VERSION.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 1)) {
    throw new Error("Codex 多账号扩展要求 Pi 1.1.0 或更新版本，请先升级 Pi。");
  }
  // 只使用个人 agent 目录，不从项目配置接收凭据存放路径。
  registerAccounts(pi, new AccountStore(getAgentDir()));
}
