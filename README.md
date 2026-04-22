# Tidy Tabs

Sort your tabs with Firefox local AI, preserve grouped tabs when clearing, and now render folder tree connectors directly from this mod.

## What's integrated

- Topic-based tab grouping with two engines:
  - **AI** (Firefox's local ML embeddings) when `browser.ml.enabled` is on.
  - **Fuzzy** (deterministic token + hostname clustering) when AI is off. No model required.
- Drops tabs into existing groups/folders when they match; creates new ones otherwise.
- Refined, minimal tab-group label styling (no colored accent line). Folders keep their native look.
- Clear-button patch that preserves grouped/folder tabs.
- Integrated Zen Folder Tree Connectors logic.

## How to sort

Right-click the **sidebar background** (the empty space in your tab area) to open Zen's workspace menu. Tidy Tabs appends two entries at the bottom with Lucide icons:

- **Tidy Tabs into Groups** — creates regular tab groups.
- **Tidy Tabs into Folders** — creates Zen Folders (which pin your tabs).

Both entries use the same engine under the hood:

- If **AI is enabled** (`browser.ml.enabled = true`), Firefox's local embedding model groups tabs by semantic topic derived from their titles (e.g., "Cars", "Cooking").
- If **AI is disabled**, a deterministic fuzzy pipeline kicks in:
  1. Tokenize each tab's title + hostname (stopwords removed).
  2. Seed clusters by hostname.
  3. Merge clusters whose token sets overlap above a Jaccard threshold.
  4. Name each cluster by its most frequent descriptive token, falling back to a prettified hostname.

> **Note:** Right-clicking directly on a tab still shows Zen's native tab menu untouched. Right-clicking a group label still shows the group's menu.

## User config

| Label | Pref | Default |
|---|---|---|
| Enable AI | `browser.ml.enabled` | `true` |
| Tree Connectors: Enable | `zen.tidytabs.tree.enabled` | `true` |
| Sort: Enable Failure Animation | `zen.tidytabs.ui.enable-failure-animation` | `true` |
| Behavior: Preserve Grouped Tabs on Clear | `zen.tidytabs.behavior.patch-clear-button` | `true` |
| Grouping Strength | `zen.tidytabs.grouping-strength` | `0.5` |
| Menu: Show 'Tidy Tabs into Groups' | `zen.tidytabs.menu.sort-groups` | `true` |
| Menu: Show 'Tidy Tabs into Folders' | `zen.tidytabs.menu.sort-folders` | `true` |

> **Tip:** **Grouping Strength** (0–1) is a single knob that drives both AI and fuzzy modes. **0 = conservative** (only near-identical tabs group); **1 = aggressive** (loosely-related tabs still group). Default `0.5` is balanced. Disable either menu entry if you only use one container style.
