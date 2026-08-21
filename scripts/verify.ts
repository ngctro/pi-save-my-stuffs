import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sync } from "../engine";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../paths";

let failures = 0;

function check(cond: boolean, claim: string): void {
  if (cond) {
    console.log(`PASS: ${claim}`);
  } else {
    failures++;
    console.error(`FAIL: ${claim}`);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sms-verify-"));
const agentDir = path.join(tmp, "home", ".pi", "agent");
const stateDir = path.join(tmp, "home", ".pi", "save-my-stuffs");

for (const d of ["extensions", "skills/demo", "skills/leak", "themes", "prompts", "secrets"]) {
  fs.mkdirSync(path.join(agentDir, d), { recursive: true });
}
fs.writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"dark"}');
fs.writeFileSync(path.join(agentDir, "extensions/hello.ts"), 'export default () => {};\n');
fs.writeFileSync(path.join(agentDir, "skills/demo/SKILL.md"), "# demo\n");
fs.writeFileSync(path.join(agentDir, "themes/x.json"), "{}\n");
fs.writeFileSync(path.join(agentDir, "prompts/y.md"), "hi\n");
fs.writeFileSync(path.join(agentDir, "secrets/auth.json"), '{"token":"t"}');
fs.writeFileSync(path.join(agentDir, "skills/leak/.env"), "SECRET=1\n");
fs.writeFileSync(path.join(agentDir, "extensions/key.pem"), "-----BEGIN PRIVATE KEY-----\n");
const embedded = path.join(agentDir, "extensions/embedded-tool");
fs.mkdirSync(embedded, { recursive: true });
fs.writeFileSync(path.join(embedded, "tool.ts"), "export const tool = 1;\n");
execFileSync("git", ["init", "--quiet"], { cwd: embedded });
execFileSync("git", ["-C", embedded, "add", "-A"], {});
execFileSync("git", ["-C", embedded, "commit", "--quiet", "-m", "init"], {
  env: { ...process.env, GIT_AUTHOR_NAME: "v", GIT_AUTHOR_EMAIL: "v@l", GIT_COMMITTER_NAME: "v", GIT_COMMITTER_EMAIL: "v@l" },
});

const remote = path.join(tmp, "remote.git");
execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
saveConfig(stateDir, { ...DEFAULT_CONFIG, repo: remote });

const first = await sync({ agentDir, stateDir, hostname: "verify-host" });
check(first.kind === "pushed", `initial sync pushes (got ${first.kind})`);

const clone1 = path.join(tmp, "clone1");
execFileSync("git", ["clone", "--quiet", remote, clone1]);
const expectedFiles: Array<[string, string]> = [
  ["settings.json", '{"theme":"dark"}'],
  ["extensions/hello.ts", 'export default () => {};\n'],
  ["skills/demo/SKILL.md", "# demo\n"],
  ["themes/x.json", "{}\n"],
  ["prompts/y.md", "hi\n"],
];
for (const [rel, want] of expectedFiles) {
  const got = fs.readFileSync(path.join(clone1, rel), "utf8");
  check(got === want, `cloned ${rel} matches source content`);
}
const walked: string[] = [];
(function walk(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    walked.push(path.relative(clone1, p));
  }
})(clone1);
check(
  !walked.some((p) => /auth\.json|(^|\/)\.env$|key\.pem/.test(p)),
  "trap secrets absent everywhere in cloned backup",
);
const readmePath = path.join(clone1, "README.md");
const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
check(readme.includes("Restore") && readme.includes("gh auth login"), "backup ships a restore guide");
check(readme.includes(remote), "restore guide references the actual remote");
check(
  fs.existsSync(path.join(clone1, "extensions/embedded-tool/tool.ts")),
  "nested git repo is copied as plain files, not a gitlink",
);
check(
  !git(remote, "ls-tree", "-r", "HEAD").includes("160000"),
  "no gitlink entries in backup tree",
);

fs.writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"light"}');
const second = await sync({ agentDir, stateDir, hostname: "verify-host" });
check(second.kind === "pushed", `second sync pushes after edit (got ${second.kind})`);
check(git(remote, "rev-list", "--count", "main").trim() === "2", "remote has exactly 2 commits");
check(git(remote, "show", "main:settings.json").includes("light"), "new settings content reached the remote");

fs.rmSync(path.join(agentDir, "skills/demo/SKILL.md"));
await sync({ agentDir, stateDir, hostname: "verify-host" });
const clone2 = path.join(tmp, "clone2");
execFileSync("git", ["clone", "--quiet", remote, clone2]);
check(!fs.existsSync(path.join(clone2, "skills/demo/SKILL.md")), "deleted skill stays deleted in fresh clone");

const worktree = path.join(stateDir, "repo");
fs.writeFileSync(path.join(worktree, "junk.txt"), "junk");
fs.mkdirSync(path.join(worktree, "stray-dir"), { recursive: true });
fs.writeFileSync(path.join(worktree, "stray-dir", "x"), "x");
await sync({ agentDir, stateDir, hostname: "verify-host" });
const remote2 = path.join(tmp, "remote2.git");
execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote2]);
const stateDir2 = path.join(tmp, "state2");
saveConfig(stateDir2, { ...DEFAULT_CONFIG, repo: remote2 });
await sync({ agentDir, stateDir: stateDir2, hostname: "verify-host" });
const listA = git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean).sort().join("\n");
const listB = git(path.join(stateDir2, "repo"), "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean).sort().join("\n");
check(listA.length > 0 && listA === listB, "crash debris converges to same tree as a fresh full sync");

const both = await Promise.all([
  sync({ agentDir, stateDir, hostname: "verify-host" }),
  sync({ agentDir, stateDir, hostname: "verify-host" }),
]);
check(both.every((o) => o.kind !== "failed"), `concurrent syncs both resolve without failure (${both.map((o) => o.kind).join(", ")})`);
const final = await sync({ agentDir, stateDir, hostname: "verify-host" });
check(final.kind === "clean", `final sync reports clean (got ${final.kind})`);
check(git(worktree, "status", "--porcelain").trim() === "", "worktree porcelain empty after final sync");

const repairState = path.join(tmp, "repair-remote.git");
execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", repairState]);
const repairWork = path.join(tmp, "repair-seed");
execFileSync("git", ["init", "--quiet", "-b", "main", repairWork]);
fs.cpSync(embedded, path.join(repairWork, "extensions/embedded-tool"), { recursive: true });
execFileSync("git", ["-C", repairWork, "add", "-A"], {});
execFileSync("git", ["-C", repairWork, "commit", "--quiet", "-m", "seed gitlink the way the old engine did"], {
  env: { ...process.env, GIT_AUTHOR_NAME: "v", GIT_AUTHOR_EMAIL: "v@l", GIT_COMMITTER_NAME: "v", GIT_COMMITTER_EMAIL: "v@l" },
});
if (execFileSync("git", ["-C", repairWork, "ls-tree", "-r", "HEAD"], { encoding: "utf8" }).includes("160000") === false) {
  throw new Error("seed failed to produce a gitlink; test premise broken");
}
execFileSync("git", ["-C", repairWork, "push", "--quiet", repairState, "main"], {});
const repairStateDir = path.join(tmp, "repair-state");
fs.mkdirSync(path.dirname(path.join(repairStateDir, "config.json")), { recursive: true });
saveConfig(repairStateDir, { ...DEFAULT_CONFIG, repo: repairState });
await sync({ agentDir, stateDir: repairStateDir, hostname: "verify-host" });
const repairedTree = execFileSync("git", ["--git-dir", path.join(repairStateDir, "repo", ".git"), "ls-tree", "-r", "HEAD"], { encoding: "utf8" });
check(!repairedTree.includes("160000"), "sync repairs an existing gitlink into plain files");
check(
  repairedTree.includes("extensions/embedded-tool/tool.ts"),
  "repaired backup holds the embedded repo contents",
);

const badDir = path.join(tmp, "badcfg");
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(
  path.join(badDir, "config.json"),
  JSON.stringify({ repo: 42, branch: 7, enabled: "yes", debounceMinutes: -3, extraPaths: "nope", junk: true }),
);
const bad = loadConfig(badDir);
check(
  bad !== null &&
    bad.repo === "" &&
    bad.branch === "main" &&
    bad.enabled === true &&
    bad.debounceMinutes === 2 &&
    bad.extraPaths.length === 0,
  "malformed config falls back to defaults for bad fields",
);
check(loadConfig(path.join(tmp, "missing-cfg")) === null, "missing config file returns null");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed. Sandbox: ${tmp}`);
  process.exit(1);
}
console.log(`\nAll checks passed. Sandbox kept at ${tmp}`);
