# Tidy Tabs

Sort your tabs with Firefox local AI, preserve grouped tabs when clearing, and now render folder tree connectors directly from this mod.

## What's integrated

- AI tab sorting into existing groups/folders and new topic groups.
- Clear button patch that keeps grouped/folder tabs safe.
- Integrated Zen Folder Tree Connectors logic (no separate script needed).
- Runtime config via preferences so users can tune behavior and visuals.

## User config

Only the essentials are exposed in `preferences.json`. Advanced tuning values still run via built-in defaults.

| Label | Pref | Default |
|---|---|---|
| Enable AI | `browser.ml.enabled` | `true` |
| Grouping: Use Zen Folders | `zen.tidytabs.ui.use-zen-folders` | `true` |
| Tree Connectors: Enable | `zen.tidytabs.tree.enabled` | `true` |
| Sort: Enable Failure Animation | `zen.tidytabs.ui.enable-failure-animation` | `true` |
| Behavior: Preserve Grouped Tabs on Clear | `zen.tidytabs.behavior.patch-clear-button` | `true` |
| AI: Similarity Threshold | `zen.tidytabs.ai.similarity-threshold` | `0.45` |
| UI: Icon Size | `zen.tidytabs.ui.sort-button.icon-size` | `1.5rem` |
| UI: Icon Opacity | `zen.tidytabs.ui.sort-button.icon-opacity` | `0.8` |
| UI: Font Size | `zen.tidytabs.ui.sort-button.font-size` | `0.625rem` |

> **Tip:** Icon size and font size accept any CSS length (`1.5rem`, `24px`, `2vw`, etc.) so they scale with your screen. Opacity accepts `0`–`1`. Type your value and press Enter to apply.
