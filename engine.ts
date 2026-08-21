import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWLIST, atomicWrite, loadConfig } from "./paths";

export type SyncOutcome =
  | { kind: "pushed"; commit: string; files: number }
  | { kind: "clean" }
  | { kind: "failed"; reason: string };

export type LastSync = { at: string; outcome: SyncOutcome };

export type RunResult = { code: number; stdout: string; stderr: string };

const GITIGNORE = [
  "auth.json",
  "models-store.json",
  "*.pem",
  "*.key",
  ".env*",
  "*credential*",
  "*secret*",
  "node_modules/",
  ".DS_Store",
].join("\n");

class GitError extends Error {
  constructor(
    readonly desc: string,
    readonly stderr: string,
  ) {
    super(desc);
  }
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr });
      const code = "code" in err && typeof err.code === "number" ? err.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

function tail(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(-max);
}

async function runGit(cwd: string, args: string[], desc: string): Promise<RunResult> {
  const r = await run("git", args, cwd);
  if (r.code !== 0) throw new GitError(`${desc}: ${tail(r.stderr)}`, r.stderr);
  return r;
}

export function runGh(args: string[]): Promise<RunResult> {
  return run("gh", args);
}

function resolveRemote(repo: string): string {
  if (repo.includes("://") || repo.startsWith("/") || repo.startsWith("~")) return repo;
  return `https://github.com/${repo}.git`;
}

let queueTail: Promise<unknown> = Promise.resolve();

export function sync(opts: { agentDir: string; stateDir: string; hostname?: string }): Promise<SyncOutcome> {
  const result = queueTail.then(() => runSync(opts));
  queueTail = result.catch(() => undefined);
  return result;
}

async function runSync(
  opts: { agentDir: string; stateDir: string; hostname?: string },
  attempt = 0,
): Promise<SyncOutcome> {
  try {
    const outcome = await syncOnce(opts);
    persistLastSync(opts.stateDir, outcome);
    return outcome;
  } catch (err) {
    if (err instanceof GitError && err.stderr.includes("index.lock") && attempt === 0) {
      await new Promise((r) => setTimeout(r, 3_000));
      return runSync(opts, attempt + 1);
    }
    const reason = err instanceof GitError ? err.desc : `unexpected error: ${String(err).slice(0, 400)}`;
    const outcome: SyncOutcome = { kind: "failed", reason };
    persistLastSync(opts.stateDir, outcome);
    return outcome;
  }
}

async function syncOnce(opts: { agentDir: string; stateDir: string; hostname?: string }): Promise<SyncOutcome> {
  const config = loadConfig(opts.stateDir);
  if (!config?.repo) return { kind: "failed", reason: "not configured" };
  const branch = config.branch;
  const hostname = opts.hostname ?? os.hostname();
  const worktree = path.join(opts.stateDir, "repo");
  fs.mkdirSync(worktree, { recursive: true });

  if (!fs.existsSync(path.join(worktree, ".git"))) {
    await runGit(worktree, ["init", "-b", branch], "git init");
    await runGit(worktree, ["remote", "add", "origin", resolveRemote(config.repo)], "git remote add");
  }
  await runGit(worktree, ["config", "user.email", "pi-save-my-stuffs@localhost"], "git config user.email");
  await runGit(worktree, ["config", "user.name", "pi-save-my-stuffs"], "git config user.name");

  const committed = await convergeAndCommit(worktree, opts.agentDir, branch, hostname);
  if (!committed) return { kind: "clean" };

  let push = await run("git", ["push", "-u", "origin", branch], worktree);
  if (push.code !== 0 && /reject|non-fast-forward/i.test(push.stderr)) {
    await convergeAndCommit(worktree, opts.agentDir, branch, hostname);
    push = await run("git", ["push", "-u", "origin", branch], worktree);
  }
  if (push.code !== 0) throw new GitError(`git push: ${tail(push.stderr)}`, push.stderr);
  return pushedInfo(worktree);
}

async function convergeAndCommit(
  worktree: string,
  agentDir: string,
  branch: string,
  hostname: string,
): Promise<boolean> {
  await run("git", ["fetch", "origin"], worktree);
  if (await hasRemoteBranch(worktree, branch)) {
    await runGit(worktree, ["checkout", "-B", branch, `origin/${branch}`], "git checkout");
  }
  rebuildMirror(worktree, agentDir);
  fs.writeFileSync(path.join(worktree, ".gitignore"), GITIGNORE);
  await runGit(worktree, ["add", "-A"], "git add");
  if (!(await run("git", ["status", "--porcelain"], worktree)).stdout.trim()) return false;
  await runGit(worktree, ["commit", "-m", `pi-backup: ${hostname} ${new Date().toISOString()}`], "git commit");
  return true;
}

async function hasRemoteBranch(worktree: string, branch: string): Promise<boolean> {
  const r = await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], worktree);
  return r.code === 0;
}

function rebuildMirror(worktree: string, agentDir: string): void {
  for (const entry of fs.readdirSync(worktree, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(worktree, entry.name), { recursive: true, force: true });
  }
  for (const p of ALLOWLIST) {
    const src = path.join(agentDir, p.src);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(worktree, p.dest), {
      recursive: true,
      filter: (s) => path.basename(s) !== ".git",
    });
  }
}

async function pushedInfo(worktree: string): Promise<SyncOutcome> {
  const commit = (await runGit(worktree, ["rev-parse", "HEAD"], "git rev-parse")).stdout.trim();
  const names = (
    await runGit(worktree, ["diff-tree", "--root", "-r", "--name-only", "--no-commit-id", "HEAD"], "git diff-tree")
  ).stdout;
  return { kind: "pushed", commit, files: names.split("\n").filter(Boolean).length };
}

function persistLastSync(stateDir: string, outcome: SyncOutcome): void {
  const record: LastSync = { at: new Date().toISOString(), outcome };
  atomicWrite(path.join(stateDir, "last-sync.json"), JSON.stringify(record, null, 2));
}

export function readLastSync(stateDir: string): LastSync | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, "last-sync.json"), "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const o = obj.outcome;
  if (typeof obj.at !== "string" || typeof o !== "object" || o === null) return null;
  const fields = o as Record<string, unknown>;
  if (fields.kind === "clean") return { at: obj.at, outcome: { kind: "clean" } };
  if (fields.kind === "failed" && typeof fields.reason === "string") {
    return { at: obj.at, outcome: { kind: "failed", reason: fields.reason } };
  }
  if (fields.kind === "pushed" && typeof fields.commit === "string" && typeof fields.files === "number") {
    return { at: obj.at, outcome: { kind: "pushed", commit: fields.commit, files: fields.files } };
  }
  return null;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

let watchers: fs.FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function startWatching(opts: {
  agentDir: string;
  debounceMinutes: number;
  onChange: () => void;
}): void {
  stopWatching();
  const ms = Math.max(1, opts.debounceMinutes) * 60_000;
  const schedule = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      opts.onChange();
    }, ms);
  };
  for (const p of ALLOWLIST) {
    if (!p.watch) continue;
    const src = path.join(opts.agentDir, p.src);
    try {
      watchers.push(fs.watch(src, { recursive: true }, schedule));
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
    }
  }
}

export function stopWatching(): void {
  for (const w of watchers) w.close();
  watchers = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}
