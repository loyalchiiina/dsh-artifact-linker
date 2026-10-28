# dsh-artifact-linker

**Every artifact your agent delivers is one click away — no more "copy the path → open Explorer → paste into the address bar → Enter".**
**让 DSH 交付的每一个产物，都能点一下就到位 —— 不用再「复制路径 → 打开文件管理器 → 贴到地址栏 → 回车」。**

**English** · [简体中文](README.zh.md) · [Interaction](#interaction) · [Install](#install) · [Config](#config) · [Boundaries](#what-it-does-not-do) · [Troubleshooting](#troubleshooting)

---

## The problem

DSH already previews images, code, PDFs and Office files in the sidebar. But **scripts, Fluent exports, packed archives, temporary dumps** have no previewer — all you get in the transcript is a bare file name, so opening one costs four mechanical steps:

1. Select and copy the path (assuming the model even printed one)
2. Open File Explorer
3. Paste into the address bar
4. Press Enter

Worse: the model often prints a **relative path or just a file name**, so step 1 fails outright and you have to go hunting for the file first.

This plugin removes all four steps **and** removes the root cause.

## What it does

Two halves, one contract.

| Half | Responsibility |
| --- | --- |
| **Host** (`lib/index.js`) | Registers a **resident system-prompt section** so "declare artifacts with full absolute paths" holds in *every* session and *every* preset — no skill needs to be loaded. Exposes six loopback-only routes for path resolution, `stat`, reveal and open. |
| **Client** (`lib/client.js`) | Turns artifact names in the transcript into clickable targets: left click reveals, right click opens a menu. **No resident UI, no scanning, no timers.** |

The host half closes the loop: even when the model only says `result.h5`, the route layer resolves it against the session workspace, then falls back to a shallow recursive basename search, and returns the real absolute path.

## What it looks like

Hover an artifact name and it picks up a Codex-style blue dashed outline — that is the only visual hint, nothing is rewritten in your transcript:

![Hover highlight](https://raw.githubusercontent.com/loyalchiiina/dsh-artifact-linker/main/docs/hover-highlight.png)

Right click for the three actions:

![Context menu](https://raw.githubusercontent.com/loyalchiiina/dsh-artifact-linker/main/docs/context-menu.png)

"Copy file path" puts the real absolute path on your clipboard:

![Copy path](https://raw.githubusercontent.com/loyalchiiina/dsh-artifact-linker/main/docs/copy-path.png)

## Interaction

Click behaviour is decided by the modifier key — no menu, no first-time setup:

| Action | Result |
| --- | --- |
| **Left click** on a file name / path | Reveal in File Explorer *with the file selected* |
| **Ctrl / Shift / Cmd + click** | Open with the system's default application |
| **Alt + click** | Copy the full absolute path to the clipboard |

### Interactions (v0.2 — no floating pill any more)

| Action | Result |
|---|---|
| **Left click** an artifact name | Reveals and selects the file in Explorer |
| **Right click** an artifact name | Inline menu: `📍 reveal` / `↗ open with default app` / `⧉ copy absolute path` |
| **Hover** an artifact name | Cursor turns into a pointer (the only visual hint) |
| Right click on **non-artifact** text | Fully passed through — the host's native menu appears as usual |
| File missing / unresolvable | Silent pass-through or a one-shot toast. **Never pretends to succeed.** |

The following describes the removed v0.1 design:

The panel refreshes on its own; there are also explicit refresh / flush-cache / clear / close controls.

## How paths resolve

A single path may arrive in three shapes, tried in order:

1. **Absolute** — used as-is (`E:\project\out\case.h5`, `\\nas\share\a.zip`). Both drive letters and UNC are recognised.
2. **Relative** — joined against the session workspace (`out\case.h5` → `<workspace>\out\case.h5`).
3. **Bare file name** — a shallow recursive basename search under the workspace (depth 2 by default), used only when exactly one match is found. Multiple matches are surfaced as candidates instead of guessing.

Results are cached with a 10 s TTL so that repeated queries from DOM re-renders do not hammer the disk, while a just-deleted file still flips to "gone" quickly.

## Install

```bash
# 1. Drop the package into DSH's local plugin directory
#    Windows: %USERPROFILE%\.dsh\local-plugins\dsh-artifact-linker

# 2. Declare the dependency in your profile's package.json
#    %USERPROFILE%\.dsh\profiles\<profile>\package.json  →  dependencies
#      "dsh-artifact-linker": "link:C:/Users/<you>/.dsh/local-plugins/dsh-artifact-linker"

# 3. Fully restart DSH — client bundles are NOT reloaded by Ctrl+R
```

> The host half needs `webServer` and `systemPrompt`; the client half is a `__ModuleLoader__` bundle. Peers declare `@deepseek-ai/dsh >=0.2.1-rc.3` — the installer compares the runtime version against that range and refuses a mismatch.

## Config

All tunables live in `cordis.patch.yml` (or the profile-level patch). Changing them requires a restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `injectRules` | `true` | Register the resident prompt section |
| `clientChips` | `true` | Client capsule + click takeover. `false` = pure injection mode |
| `allowOutside` | `true` | Allow resolving paths outside the workspace |
| `statTtlMs` | `10000` | Host-side `stat` cache lifetime |
| `searchMaxDepth` | `2` (max 8) | Recursion depth for bare-filename lookup |
| `rulesText` | built-in 6 lines | Replace the injected rules wholesale (array or multi-line string) |

On `allowOutside`: artifacts almost always live on a project drive (`E:\`, `D:\`) rather than inside the DSH workspace, so a strict default would make the plugin useless on first run. **Set it to `false` when shipping to other people** — that is the gate which stops this plugin from becoming "the model names any path and your machine opens it".

## What it does NOT do

- **Never modifies a single DOM node.** React owns the transcript; mutating its nodes causes blank renders on re-render. Clickability comes from a capture-phase `click` listener plus `caretRangeFromPoint` to work out which word was hit.
- **Never takes over markdown image or link syntax.** Rewriting `![](path)` into a chip would break the image.
- **Never writes a file, never phones home.** Zero telemetry. The only `spawn` calls are the explicit `/reveal` and `/open` routes, using `execFile` with an argument array (no shell, no injection surface), guarded by a loopback-origin check.
- **Never renames or moves anything.** Read-only by construction.
- **Does not unify with the official `present` card.** If an artifact was already delivered as a card, the injected rules tell the model not to repeat it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing clickable | Was DSH **fully restarted**? `dsh.client` bundles do not hot-reload |
| Capsule missing | `clientChips` is `true`; the loader reports `loaded without registering` if the bundle id mismatches `package.json` |
| Click does nothing | File may have been deleted — the capsule marks it `gone` |
| "outside workspace" | Either set `allowOutside: true`, or the path really is outside the project |
| Injection not working | `injectRules` is `true`; look for the host log `artifact path rules registered` |
| Theme colours look off | The plugin prefers `--dsw-alias-*` tokens, then self-detected light/dark, then hardcoded fallbacks |

## Layout

```
dsh-artifact-linker/
├── package.json          # dsh.bundle + dsh.client, peer >=0.2.1-rc.3
├── cordis.patch.yml      # the patch entry (never duplicate this id)
├── lib/
│   ├── index.js          # host: prompt section + 6 loopback routes
│   └── client.js         # client: __ModuleLoader__ bundle, read-only DOM
├── locale/{zh,en}.json   # meta.title / meta.description
├── icon.svg
├── scripts/probe-regex.mjs
├── README.md / README.zh.md
├── CHANGELOG.md
└── LICENSE
```

## License

MIT © loyalchiiina
