# pi-save-my-stuffs

A pi extension that backs up your pi configuration to a git remote. It commits your settings, extensions, skills, themes, and prompts on session start, again after you change them, and once more when you quit.

## What gets backed up

The extension mirrors an allowlist from `~/.pi/agent` into a private git repo:

- `settings.json`
- `extensions/`
- `skills/`
- `themes/`
- `prompts/`

Missing paths are skipped. Packages installed under `npm/` and `git/` are not copied because the `packages` array in `settings.json` already records how to reinstall them.

Secrets stay out even if a file name matches inside the allowlist. The backup repo carries a `.gitignore` that excludes `auth.json`, `models-store.json`, `*.pem`, `*.key`, `.env*`, `*credential*`, and `*secret*`.

## Install

Install as a pi git package:

```
pi install git:github.com/ngctro/pi-save-my-stuffs@v0.1.0
```

Drop the `@v0.1.0` suffix to track `main` instead of a tagged release. Restart pi after installing. Until you run setup, the status line shows `not configured`.

## Set up a backup repo

Run `/save-my-stuffs setup` inside pi. If the `gh` CLI is logged in, the command asks for a visibility choice (private is the default) and a repo name, creates `<owner>/pi-backup` if it does not exist, writes the config, and pushes the first backup.

Without `gh`, the command asks for any git URL or local path instead, so a bare repo on a NAS works too.

## Commands

| Command | What it does |
|---|---|
| `/save-my-stuffs` | Show repo, branch, watched paths, and the last sync result |
| `/save-my-stuffs setup` | Create or attach a backup repo and push |
| `/save-my-stuffs sync` | Back up now |
| `/save-my-stuffs enable` | Resume automatic backups |
| `/save-my-stuffs disable` | Stop automatic backups |

## Configuration

Config lives at `~/.pi/save-my-stuffs/config.json`. Delete it to start over.

```json
{
  "repo": "owner/pi-backup",
  "branch": "main",
  "enabled": true,
  "debounceMinutes": 2,
  "extraPaths": []
}
```

`repo` accepts `owner/name` for GitHub, or any URL or path used verbatim. `extraPaths` lists additional paths inside `~/.pi/agent` to mirror; they are not watched. Invalid fields fall back to defaults.

## How syncing behaves

Each sync fetches the remote, rebuilds the mirror from the allowlist, commits any delta as `pi-backup: <hostname> <timestamp>`, and pushes. A rejected push retries once on top of the fresh remote, so two machines can share one repo and the latest sync wins per file. Concurrent syncs queue behind each other, and a crashed run converges on the next sync.

## Verify

Run the end-to-end checks against throwaway sandboxes and bare remotes:

```
bun scripts/verify.ts
```
