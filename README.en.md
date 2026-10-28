# dsh-artifact-linker

**Every artifact your agent delivers is one click away — no more "copy the path → open Explorer → paste into the address bar → Enter".**
**让 DSH 交付的每一个产物，都能点一下就到位 —— 不用再「复制路径 → 打开文件管理器 → 贴到地址栏 → 回车」。**

**English** · [简体中文](README.md) · [Interaction](#interaction) · [Install](#install) · [Config](#config) · [Boundaries](#what-it-does-not-do) · [Troubleshooting](#troubleshooting)

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
| **Host** (`lib/index.js`) | Registers a **resident system-prompt section** so "declare artifacts with full absolute paths" holds in *every* session and *every* preset — no skill needs to be loaded. Exposes eight loopback-only routes for path resolution, `stat`, reveal, open, save-as and copy-file. |
| **Client** (`lib/client.js`) | Turns artifact names in the transcript into clickable targets: left click reveals, right click opens a seven-item menu (sidebar preview, open, reveal, save-as, copy file, copy path, add to composer). **No resident UI, no scanning, no timers.** |

The host half closes the loop: even when the model only says `result.h5`, the route layer resolves it against the session workspace, then falls back to a shallow recursive basename search, and returns the real absolute path.

## What it looks like

Hover an artifact name and it picks up a Codex-style blue dashed outline — that is the only visual hint, nothing is rewritten in your transcript. Right click for the full menu:

![Context menu](https://raw.githubusercontent.com/loyalchiiina/dsh-artifact-linker/main/docs/context-menu.png)

## Interaction

Click behaviour is decided by the modifier key — no first-time setup:

| Action | Result |
| --- | --- |
| **Left click** on a file name / path | Reveal in File Explorer *with the file selected* |
| **Ctrl / Shift / Cmd + click** | Open with the system's default application |
| **Alt + click** | Copy the full absolute path to the clipboard |
| **Right click** on an artifact | Inline menu — seven actions, listed below |
| **Right click** on non-artifact text | Fully passed through, the host's native menu appears as usual |
| **Hover** | Cursor becomes a pointer *only after* the file is confirmed to exist |
| File missing / unresolvable | Silent pass-through or a one-shot toast. **Never pretends to succeed.** |

### Right-click menu

| Item | What it does |
| --- | --- |
| **Preview in sidebar** | Opens the file in DSH's built-in right sidebar — the same route as clicking a file link in chat. That viewer handles PDF, Word, Excel, PowerPoint, Markdown, plain text, CSV, images, audio and video; an extension it cannot render is redirected to the default app instead of showing a blank pane |
| **Open with default app** | Hands the file to the OS association (Explorer / Excel / VLC / …) |
| **Reveal in Explorer** | Opens the containing folder and selects the file |
| **Save as…** | Copies the file to a location you pick |
| **Copy file** | Puts the file *itself* on the clipboard (`CF_HDROP`), so you can paste it into Explorer, mail or chat |
| **Copy path** | Puts the real absolute path on the clipboard |
| **Add to composer** | Inserts the path into the input box for the next message |

## How paths resolve

A single path may arrive in four shapes, tried in order:

1. **Absolute** — used as-is (`E:\project\out\case.h5`, `\\nas\share\a.zip`). Both drive letters and UNC are recognised.
2. **Relative** — joined against the session workspace (`out\case.h5` → `<workspace>\out\case.h5`).
3. **Workspace roots** — every known profile and session workspace is tried, not only the current one.
4. **Bare file name** — a shallow recursive basename search (depth 2 by default), used only when exactly one match is found. Multiple matches are surfaced as candidates instead of guessing. When a mention swallows leading words (`结果#1_速度云图.png` arriving as `#1_速度云图.png`), segments are shrunk from the left until one resolves.

Results are cached — 10 s for `stat`, 30 s for the basename index — so repeated hovers from DOM re-renders do not hammer the disk, while a just-deleted file still flips to "gone" quickly.

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
- **Never draws a chip for a file that does not exist.** Chat text is full of filename-shaped fragments — log excerpts, example paths, error messages. Turning those into chips produces a clickable target that only ever answers "not resolved", which is worse than not recognising the file at all. So there is an existence gate: on hover the client resolves asynchronously and only becomes a pointer / dashed highlight when the file is really there. Confirmed non-artifacts stay plain text and the right-click falls through to the host's native menu. Results are cached for 30 s.
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
│   ├── index.js          # host: prompt section + 8 loopback routes
│   └── client.js         # client: __ModuleLoader__ bundle, read-only DOM
├── locale/{zh,en}.json   # meta.title / meta.description
├── icon.svg
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE
```

## License

MIT © loyalchiiina
