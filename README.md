# omp-jev-skills

OMP-only extension for Oh My Pi 18.3.4+. Ranks **discovered skills** from
OMP slash-command metadata (`source: "skill"`, canonical `path`).

## Install

```sh
omp install github:5c0r/omp-jev-skills#feat/omp-jev-skills
```

This branch install is for PR review. After merge to default branch, use
`omp install github:5c0r/omp-jev-skills`. Git installs use OMP's bundled Judge;
the large `@oh-my-pi/pi-coding-agent` package is a **development-only** type/test
dependency, not a runtime dependency. No TypeSafe API key is configured here.

## Use

- `/jev-skills <task>`: show scored matches and Judge diagnostics.
- `jev_skills` model-facing tool: same search, with `task` string parameter.
- `/jev-skills-config` or `/jev-skills-config status`: show active-profile
  settings and file path (`omp config path` gives the profile directory).
- `/jev-skills-config set <key> <value>`: update settings for subsequent calls,
  including after restart.

| Setting | Default | Values |
| --- | --- | --- |
| `debug` | `true` | `true`, `false` |
| `autoSuggest` | `false` | `true`, `false` |
| `checkCalls` | `false` | `true`, `false` |
| `threshold` | `0.65` | finite number from 0 to 1 |
| `timeoutMs` | `10000` | integer from 100 to 20000 |

Config lives at `<active agent dir>/jev-skills.json`, separate from plugin files.
Writes lock, fresh-read, then atomically replace file; a crash holding
`jev-skills.json.lock` fails closed until stale lock is removed manually.

Each discovered skill gets a native Judge yes probability; bounded 16-skill
batches cover the full inventory. Accepted hits include canonical `skill://`
URI, description, source `SKILL.md` location, score/gauge. Output displays top
five per group with explicit omitted counts; all candidates are still judged.
Debug mode shows rejected/unjudged groups. Results report actual provider/model,
elapsed time, token usage/cost, and any Judge error. Judge calls
can incur provider charges.

Skill commands must be enabled in OMP for this metadata-backed inventory.
`autoSuggest` adds up to three optional suggestions before a prompt.
`checkCalls` advises only on recognized `read` calls targeting a discovered
`skill://` URI or that skill's actual `SKILL.md` path. Judge state contains the
supplied finder task or, for hooks, the latest session prompt, plus discovered
skill names/descriptions. The extension does not append local skill paths,
file contents, or read arguments (including `i`); prompts themselves may
contain sensitive text. It cannot see every skill invocation or force a load.
Normal OMP reading and approvals stay unchanged. If Judge lacks auth, fails,
returns malformed answers, or times out, explicit search reports it; automatic
hooks do nothing (including after a partially scored batch). No extra model
fallback.

## Develop

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```
