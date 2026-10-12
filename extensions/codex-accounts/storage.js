import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export const PROVIDER = "openai-codex";
export const ACCOUNTS_FILE = "codex-accounts.json";
const AUTH_FILE = "auth.json";
const OAUTH = "oauth";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const PRIVATE_MODE = 0o600;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const NO_LOGIN = "没有可保存的 Codex OAuth 登录，请先执行 /login openai-codex。";
const EMPTY_STORE = { version: STORE_VERSION, accounts: {} };

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenClaims(access) {
  try {
    const value = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString());
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function credentialInfo(credential) {
  if (!isRecord(credential) || credential.type !== OAUTH ||
      typeof credential.access !== "string" || !credential.access || /\s/.test(credential.access) ||
      typeof credential.refresh !== "string" || !credential.refresh ||
      !Number.isFinite(credential.expires) || credential.expires < 0) {
    throw new Error("Codex OAuth 凭据格式无效，不修改任何登录。");
  }
  const claims = tokenClaims(credential.access);
  const auth = claims[AUTH_CLAIM];
  const tokenId = auth?.chatgpt_account_id;
  const accountId = credential.accountId ?? tokenId;
  if (typeof accountId !== "string" || !/^[\w-]{1,200}$/.test(accountId) || RESERVED_IDS.has(accountId) ||
      (tokenId !== undefined && tokenId !== accountId)) {
    throw new Error("Codex 账号身份缺失或与 token 不一致，不修改任何登录。");
  }
  const userId = auth?.chatgpt_user_id ?? auth?.user_id ?? claims.sub;
  if (typeof userId !== "string" || !userId || userId.length > 200 || /\s|[\x00-\x1f\x7f]/.test(userId)) {
    throw new Error("Codex 用户身份缺失或无效，拒绝合并或覆盖账号；请检查登录或旧快照，原文件保持不变。");
  }
  // 工作区 ID 不是用户 ID；同一用户与工作区组成独立登录，轮换 token 不改变快照键。
  const id = createHash("sha256").update(JSON.stringify([PROVIDER, userId, accountId])).digest("hex");
  const email = claims.email ?? claims[PROFILE_CLAIM]?.email;
  return { id, accountId, userId, email: typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 80 ? email : undefined };
}

function validName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("账号名称须为 1–100 个字符，不能包含控制字符。");
  }
  return name.trim();
}

function readJson(path, fallback) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("凭据路径必须是普通文件，不能是符号链接。");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // JSON 异常可能携带原始 token 片段，禁止直接输出解析器错误。
    throw new Error("凭据文件不可读或 JSON 损坏，拒绝覆盖；请先检查个人 agent 目录。");
  }
  if (!isRecord(parsed)) throw new Error("凭据文件根结构无效，拒绝覆盖。");
  return parsed;
}

function atomicWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", PRIVATE_MODE);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export class AccountStore {
  constructor(agentDir) {
    this.agentDir = resolve(agentDir);
    this.authPath = join(this.agentDir, AUTH_FILE);
    this.accountsPath = join(this.agentDir, ACCOUNTS_FILE);
  }

  readAccounts() {
    const store = readJson(this.accountsPath, EMPTY_STORE);
    if (![STORE_VERSION, LEGACY_STORE_VERSION].includes(store.version) || !isRecord(store.accounts)) {
      throw new Error("账号快照格式不匹配，拒绝覆盖；请勿混用其他账号扩展。");
    }
    const accounts = Object.create(null);
    for (const [key, entry] of Object.entries(store.accounts)) {
      if (!isRecord(entry)) throw new Error("账号快照身份不一致，拒绝覆盖。");
      const identity = credentialInfo(entry.credential);
      const expected = store.version === LEGACY_STORE_VERSION ? identity.accountId : identity.id;
      if (key !== expected) throw new Error("账号快照身份不一致，拒绝覆盖。");
      validName(entry.name);
      accounts[identity.id] = entry;
    }
    // v1 只在读取边界内存升级；原名称、凭据、额度与时间保留，写入仍经原锁和原子保存。
    return { ...store, version: STORE_VERSION, accounts };
  }

  readAuth() { return readJson(this.authPath, {}); }

  current() {
    const credential = this.readAuth()[PROVIDER];
    if (credential === undefined) return undefined;
    return { credential, ...credentialInfo(credential) };
  }

  view() {
    return { current: this.current(), accounts: this.readAccounts().accounts };
  }

  async locked(paths, action) {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    const releases = [];
    let compromised = false;
    const check = () => { if (compromised) throw new Error("凭据文件锁失效，操作未完成。"); };
    try {
      for (const path of paths) {
        releases.push(await lockfile.lock(path, {
          realpath: false, stale: 30_000, update: 1_000,
          retries: { retries: 200, factor: 1, minTimeout: 100, maxTimeout: 100 },
          onCompromised: () => { compromised = true; },
        }));
        check();
      }
      return action(check);
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  put(store, credential, suppliedName) {
    const { id, email } = credentialInfo(credential);
    const existing = store.accounts[id];
    let name = suppliedName ? validName(suppliedName) : existing?.name ?? email ?? id;
    const collision = Object.entries(store.accounts).some(([otherId, entry]) => otherId !== id && entry.name === name);
    if (collision && suppliedName) throw new Error("该名称已属于另一个账号，请选择不同名称。");
    if (collision) {
      const usedNames = new Set(Object.values(store.accounts).map((entry) => entry.name));
      let suffix = 1;
      do { name = `${id.slice(0, 70)}-${suffix++}`; } while (usedNames.has(name));
    }
    validName(name);
    const now = Date.now();
    store.accounts[id] = { ...existing, name, credential: structuredClone(credential), savedAt: existing?.savedAt ?? now, updatedAt: now };
    return { id, name };
  }

  async save(name) {
    return this.locked([this.authPath, this.accountsPath], (check) => {
      const credential = this.readAuth()[PROVIDER];
      if (credential === undefined) throw new Error(NO_LOGIN);
      const store = this.readAccounts();
      const saved = this.put(store, credential, name);
      check();
      atomicWrite(this.accountsPath, store);
      return saved;
    });
  }

  async syncActive() {
    // 只同步已保存账号；每次原生刷新后保留轮换凭据，不创建未经用户命名的账号。
    if (!this.current()) return undefined;
    return this.locked([this.authPath, this.accountsPath], (check) => {
      const credential = this.readAuth()[PROVIDER];
      if (!credential) return undefined;
      const identity = credentialInfo(credential);
      const { id } = identity;
      const store = this.readAccounts();
      if (store.accounts[id] && JSON.stringify(store.accounts[id].credential) !== JSON.stringify(credential)) {
        this.put(store, credential);
        check();
        atomicWrite(this.accountsPath, store);
      }
      return { ...identity, credential };
    });
  }

  async switch(name) {
    return this.locked([this.authPath, this.accountsPath], (check) => {
      const auth = this.readAuth();
      const store = this.readAccounts();
      const target = Object.hasOwn(store.accounts, name) ? [name, store.accounts[name]] : Object.entries(store.accounts).find(([, entry]) => entry.name === name);
      if (!target) throw new Error("没有找到已保存的账号，先执行 /account list。");
      // 先保存原账号（即使尚未命名），再改认证槽；写入失败不能丢失旧登录。
      if (auth[PROVIDER] !== undefined) this.put(store, auth[PROVIDER]);
      const [id] = target;
      check();
      atomicWrite(this.accountsPath, store);
      check();
      atomicWrite(this.authPath, { ...auth, [PROVIDER]: store.accounts[id].credential });
      return { id, name: store.accounts[id].name };
    });
  }

  async remove(id) {
    return this.locked([this.accountsPath], (check) => {
      const store = this.readAccounts();
      if (!Object.hasOwn(store.accounts, id)) throw new Error("没有找到已保存的账号。");
      delete store.accounts[id];
      check();
      atomicWrite(this.accountsPath, store);
    });
  }

  async recordUsage(id, usage) {
    return this.locked([this.accountsPath], (check) => {
      const store = this.readAccounts();
      if (!store.accounts[id]) return;
      store.accounts[id].usage = usage;
      check();
      atomicWrite(this.accountsPath, store);
    });
  }
}
