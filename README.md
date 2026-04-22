# Tidy Tabs

Sort your tabs with Firefox local AI, preserve grouped tabs when clearing, and now render folder tree connectors directly from this mod.

## What's integrated

- AI tab sorting into existing groups/folders and new topic groups.
- URL-based grouping (group by domain).
- Hybrid mode (AI first, falls back to URL if AI yields no groups).
- Clear button patch that keeps grouped/folder tabs safe.
- Integrated Zen Folder Tree Connectors logic (no separate script needed).

## How to sort

Right-click any tab in the left sidebar to open the context menu. You will see:

- **Sort by Topic into Groups** — AI groups tabs by semantic topic (e.g., "Cars", "Cooking").
- **Sort by Topic into Folders** — Same as above, but places them into Zen Folders (pinned).
- **Sort by URL into Groups** — Groups tabs by domain/hostname (e.g., `youtube.com`, `github.com`).
- **Sort by URL into Folders** — Same as above, but into Zen Folders.
- **Sort by Hybrid into Groups** — Tries AI topic grouping first; if that fails, falls back to URL grouping.
- **Sort by Hybrid into Folders** — Same as above, but into Zen Folders.

> **Note:** Zen Folders pin your tabs. Regular groups do not.

## User config

Only the essentials are exposed in `preferences.json`. Advanced tuning values still run via built-in defaults.

| Label | Pref | Default |
|---|---|---|
| Enable AI | `browser.ml.enabled` | `true` |
| Tree Connectors: Enable | `zen.tidytabs.tree.enabled` | `true` |
| Sort: Enable Failure Animation | `zen.tidytabs.ui.enable-failure-animation` | `true` |
| Behavior: Preserve Grouped Tabs on Clear | `zen.tidytabs.behavior.patch-clear-button` | `true` |
| AI: Similarity Threshold | `zen.tidytabs.ai.similarity-threshold` | `0.45` |

> **Tip:** For Similarity Threshold, **lower** values mean stricter matching (fewer, tighter groups) and **higher** values mean looser matching (more, broader groups). Type your value and press Enter to apply.
