import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readLastSync,
  runGh,
  startWatching,
  stopWatching,
  sync,
  type SyncOutcome,
} from "./engine";
import {
  ALLOWLIST,
  DEFAULT_CONFIG,
  defaultAgentDir,
  defaultStateDir,
  loadConfig,
  saveConfig,
  type ExtensionConfig,
} from "./paths";

const SUBCOMMANDS = ["setup", "sync", "status", "enable", "disable"];

function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case "pushed":
      return `pushed ${outcome.files} file(s) (${outcome.commit.slice(0, 7)})`;
    case "clean":
      return "already up to date";
    case "failed":
      return `failed: ${outcome.reason}`;
  }
}

function displayUrl(repo: string): string {
  if (repo.includes("://") || repo.startsWith("/") || repo.startsWith("~")) return repo;
  return `https://github.com/${repo}`;
}

function statusText(outcome: SyncOutcome): string {
  if (outcome.kind === "failed") return "backup failed";
  return `backed up ${new Date().toTimeString().slice(0, 5)}`;
}

function stderrTail(text: string): string {
  const t = text.trim();
  return t.length <= 200 ? t : t.slice(-200);
}

function watchedCount(agentDir: string): number {
  return ALLOWLIST.filter((p) => fs.existsSync(path.join(agentDir, p.src))).length;
}

function loadOrNotify(ctx: ExtensionContext, stateDir: string): ExtensionConfig | null {
  const config = loadConfig(stateDir);
  if (!config?.repo) {
    ctx.ui.notify("save-my-stuffs: not configured — run /save-my-stuffs setup", "warning");
    return null;
  }
  return config;
}

async function cmdStatus(ctx: ExtensionContext, stateDir: string): Promise<void> {
  const config = loadOrNotify(ctx, stateDir);
  if (!config) return;
  const last = readLastSync(stateDir);
  ctx.ui.notify(
    [
      `repo: ${displayUrl(config.repo)} (${config.branch})`,
      `enabled: ${config.enabled}`,
      `watched paths: ${watchedCount(defaultAgentDir())}`,
      `last sync: ${last ? `${last.at} — ${describeOutcome(last.outcome)}` : "never"}`,
    ].join("\n"),
    "info",
  );
}

async function cmdSync(ctx: ExtensionContext, stateDir: string): Promise<void> {
  if (!loadOrNotify(ctx, stateDir)) return;
  const outcome = await sync({ agentDir: defaultAgentDir(), stateDir });
  ctx.ui.notify(`save-my-stuffs: ${describeOutcome(outcome)}`, outcome.kind === "failed" ? "error" : "info");
}

async function cmdToggle(ctx: ExtensionContext, stateDir: string, enable: boolean): Promise<void> {
  const config = loadOrNotify(ctx, stateDir);
  if (!config) return;
  saveConfig(stateDir, { ...config, enabled: enable });
  if (enable) {
    startWatching({
      agentDir: defaultAgentDir(),
      debounceMinutes: config.debounceMinutes,
      onChange: () => {
        void sync({ agentDir: defaultAgentDir(), stateDir }).then((o) => {
          if (ctx.hasUI) ctx.ui.setStatus("save-my-stuffs", statusText(o));
        });
      },
    });
  } else {
    stopWatching();
    if (ctx.hasUI) ctx.ui.setStatus("save-my-stuffs", "backup off");
  }
  ctx.ui.notify(`save-my-stuffs: backups ${enable ? "enabled" : "disabled"}`, "info");
}

async function cmdSetup(ctx: ExtensionContext, stateDir: string): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("save-my-stuffs: setup needs an interactive UI", "warning");
    return;
  }
  const auth = await runGh(["auth", "status"]);
  let repo: string;
  if (auth.code !== 0) {
    const url = await ctx.ui.input("Git remote URL or path:", "git@github.com:me/pi-backup.git");
    if (!url?.trim()) return;
    repo = url.trim();
  } else {
    const visibility = await ctx.ui.select("Backup repo visibility:", ["private (recommended)", "public"]);
    if (!visibility) return;
    const name = (await ctx.ui.input("Repo name:", "pi-backup"))?.trim() || "pi-backup";
    const who = await runGh(["api", "user", "--jq", ".login"]);
    const owner = who.stdout.trim();
    if (!owner) {
      ctx.ui.notify("save-my-stuffs: could not determine GitHub user via gh", "error");
      return;
    }
    repo = `${owner}/${name}`;
    const view = await runGh(["repo", "view", repo]);
    if (view.code !== 0) {
      const flag = visibility.startsWith("public") ? "--public" : "--private";
      const created = await runGh(["repo", "create", repo, flag]);
      if (created.code !== 0) {
        ctx.ui.notify(`save-my-stuffs: repo create failed: ${stderrTail(created.stderr)}`, "error");
        return;
      }
    }
  }
  saveConfig(stateDir, { ...DEFAULT_CONFIG, repo });
  const outcome = await sync({ agentDir: defaultAgentDir(), stateDir });
  if (outcome.kind !== "failed") {
    startWatching({
      agentDir: defaultAgentDir(),
      debounceMinutes: DEFAULT_CONFIG.debounceMinutes,
      onChange: () => {
        void sync({ agentDir: defaultAgentDir(), stateDir }).then((o) => {
          if (ctx.hasUI) ctx.ui.setStatus("save-my-stuffs", statusText(o));
        });
      },
    });
  }
  ctx.ui.notify(
    `save-my-stuffs: backing up to ${displayUrl(repo)} — ${describeOutcome(outcome)}`,
    outcome.kind === "failed" ? "error" : "info",
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const stateDir = defaultStateDir();
    const config = loadConfig(stateDir);
    if (!config?.repo) {
      if (ctx.hasUI) ctx.ui.setStatus("save-my-stuffs", "not configured — run /save-my-stuffs setup");
      return;
    }
    if (!config.enabled) {
      if (ctx.hasUI) ctx.ui.setStatus("save-my-stuffs", "backup off");
      return;
    }
    stopWatching();
    const finish = (outcome: SyncOutcome, announce: boolean): void => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("save-my-stuffs", statusText(outcome));
      if (!announce) return;
      if (outcome.kind === "pushed") {
        ctx.ui.notify(`save-my-stuffs: backed up ${outcome.files} file(s) to ${displayUrl(config.repo)}`, "info");
      } else if (outcome.kind === "failed") {
        ctx.ui.notify(`save-my-stuffs: ${describeOutcome(outcome)}`, "error");
      }
    };
    void sync({ agentDir: defaultAgentDir(), stateDir }).then((o) => finish(o, true));
    startWatching({
      agentDir: defaultAgentDir(),
      debounceMinutes: config.debounceMinutes,
      onChange: () => {
        void sync({ agentDir: defaultAgentDir(), stateDir }).then((o) => finish(o, false));
      },
    });
  });

  pi.on("session_shutdown", async () => {
    stopWatching();
    const stateDir = defaultStateDir();
    const config = loadConfig(stateDir);
    if (!config?.repo || !config.enabled) return;
    const timeout = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 10_000);
      if (typeof t.unref === "function") t.unref();
    });
    await Promise.race([sync({ agentDir: defaultAgentDir(), stateDir }), timeout]).catch(() => undefined);
  });

  pi.registerCommand("save-my-stuffs", {
    description: "Back up ~/.pi/agent to a git remote",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "status";
      const stateDir = defaultStateDir();
      switch (sub) {
        case "status":
          return cmdStatus(ctx, stateDir);
        case "sync":
          return cmdSync(ctx, stateDir);
        case "setup":
          return cmdSetup(ctx, stateDir);
        case "enable":
          return cmdToggle(ctx, stateDir, true);
        case "disable":
          return cmdToggle(ctx, stateDir, false);
        default:
          ctx.ui.notify(`save-my-stuffs: unknown subcommand "${sub}"`, "warning");
      }
    },
  });
}
