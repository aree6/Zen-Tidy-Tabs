# Tidy Tabs

Sort your tabs with Firefox local AI, preserve grouped tabs when clearing, and now render folder tree connectors directly from this mod.

## What's integrated

- AI tab sorting into existing groups/folders and new topic groups.
- URL-based grouping (group by domain).
- Hybrid mode (AI fed with both the tab title **and** the URL hostname for richer signals).
- Minimal, flat tab-group styling (folders keep their native look).
- Clear button patch that keeps grouped/folder tabs safe.
- Integrated Zen Folder Tree Connectors logic (no separate script needed).

## How to sort

Right-click any **empty area of the sidebar** (between tabs, near the bottom, on the separator) to open the Tidy Tabs context menu. Each entry has a Lucide icon and can be toggled on/off in preferences.

- **Sort by Topic into Groups** — AI groups tabs by semantic topic using the tab title (e.g., "Cars", "Cooking").
- **Sort by Topic into Folders** — Same as above, but places tabs into Zen Folders (pinned).
- **Sort by URL into Groups** — Groups tabs by domain/hostname (e.g., `youtube.com`, `github.com`).
- **Sort by URL into Folders** — Same as above, but into Zen Folders.
- **Sort by Hybrid into Groups** — AI grouping where the input combines **tab title + hostname**, so the model gets both semantic and domain signals.
- **Sort by Hybrid into Folders** — Same as above, but into Zen Folders.

> **Note:** Zen Folders auto-pin your tabs. Regular groups do not. Right-clicking directly on a tab still shows Zen's native tab menu untouched.

## User config

| Label | Pref | Default |
|---|---|---|
| Enable AI | `browser.ml.enabled` | `true` |
| Tree Connectors: Enable | `zen.tidytabs.tree.enabled` | `true` |
| Sort: Enable Failure Animation | `zen.tidytabs.ui.enable-failure-animation` | `true` |
| Behavior: Preserve Grouped Tabs on Clear | `zen.tidytabs.behavior.patch-clear-button` | `true` |
| AI: Similarity Threshold | `zen.tidytabs.ai.similarity-threshold` | `0.45` |
| Menu: Show 'Sort by Topic into Groups' | `zen.tidytabs.menu.topic-groups` | `true` |
| Menu: Show 'Sort by Topic into Folders' | `zen.tidytabs.menu.topic-folders` | `true` |
| Menu: Show 'Sort by URL into Groups' | `zen.tidytabs.menu.url-groups` | `true` |
| Menu: Show 'Sort by URL into Folders' | `zen.tidytabs.menu.url-folders` | `true` |
| Menu: Show 'Sort by Hybrid into Groups' | `zen.tidytabs.menu.hybrid-groups` | `true` |
| Menu: Show 'Sort by Hybrid into Folders' | `zen.tidytabs.menu.hybrid-folders` | `true` |

> **Tip:** For Similarity Threshold, **lower** values mean stricter matching (fewer, tighter groups) and **higher** values mean looser matching (more, broader groups). Disable any menu entries you don't use to keep the right-click menu clean.
