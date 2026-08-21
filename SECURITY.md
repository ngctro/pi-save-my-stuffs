# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest tagged release | yes |
| older tags | no |

## Reporting a vulnerability

Open a private security advisory via GitHub (Security tab, then Report a vulnerability). Do not open a public issue for anything exploit-related.

The extension shells out to `git` and `gh` with fixed argument arrays, reads JSON config from `~/.pi/save-my-stuffs/`, and never evaluates remote content. Reports about the backup repo's access controls belong with your git host, not here.
