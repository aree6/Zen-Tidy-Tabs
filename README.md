# Tidy Tabs

Sort your tabs with Firefox local AI, preserve grouped tabs when clearing, and now render folder tree connectors directly from this mod.

## What's integrated

- AI tab sorting into existing groups/folders and new topic groups.
- Clear button patch that keeps grouped/folder tabs safe.
- Integrated Zen Folder Tree Connectors logic (no separate script needed).
- Runtime config via preferences so users can tune behavior and visuals.

## User config

All settings are exposed in `preferences.json`.

### Core

| Label | Pref | Default |
|---|---|---|
| Enable AI | `browser.ml.enabled` | `true` |

### Behavior toggles

| Label | Pref | Default |
|---|---|---|
| Tree Connectors: Enable | `zen.tidytabs.tree.enabled` | `true` |
| Tree Connectors: Include Related Tabs | `zen.tidytabs.tree.include-related-tabs` | `true` |
| Tree Connectors: Refresh on Animations | `zen.tidytabs.tree.refresh-on-animations` | `true` |
| Sort: Reorder Groups First | `zen.tidytabs.ui.reorder-groups-first` | `true` |
| Sort: Enable Failure Animation | `zen.tidytabs.ui.enable-failure-animation` | `true` |
| Behavior: Preserve Grouped Tabs on Clear | `zen.tidytabs.behavior.patch-clear-button` | `true` |

### AI and grouping tuning

| Label | Pref | Default |
|---|---|---|
| AI: Similarity Threshold | `zen.tidytabs.ai.similarity-threshold` | `0.45` |
| AI: Existing Group Similarity | `zen.tidytabs.ai.group-similarity-threshold` | `0.65` |
| AI: Existing Group Boost | `zen.tidytabs.ai.existing-group-boost` | `0.1` |
| Grouping: Name Consolidation Distance | `zen.tidytabs.group.consolidation-distance-threshold` | `2` |

### Performance

| Label | Pref | Default |
|---|---|---|
| Performance: Embedding Batch Size | `zen.tidytabs.performance.embedding-batch-size` | `5` |
| Performance: Debounce Delay (ms) | `zen.tidytabs.performance.debounce-delay` | `250` |
| Performance: Max Init Checks | `zen.tidytabs.performance.max-init-checks` | `50` |
| Performance: Init Check Interval (ms) | `zen.tidytabs.performance.init-check-interval` | `100` |

### UI and animation

| Label | Pref | Default |
|---|---|---|
| UI: Min Tabs for Sort Button | `zen.tidytabs.ui.min-tabs-for-sort-button` | `0` |
| UI: Failure Wave Amplitude | `zen.tidytabs.ui.failure-animation.amplitude` | `8` |
| UI: Failure Wave Frequency | `zen.tidytabs.ui.failure-animation.frequency` | `20` |
| UI: Failure Wave Segments | `zen.tidytabs.ui.failure-animation.segments` | `100` |
| UI: Failure Pulse Duration (ms) | `zen.tidytabs.ui.failure-animation.pulse-duration` | `400` |
| UI: Failure Pulse Count | `zen.tidytabs.ui.failure-animation.pulse-count` | `3` |

### Tree connector visuals

| Label | Pref | Default |
|---|---|---|
| Tree: Trunk X Position | `zen.tidytabs.tree.line-x` | `6` |
| Tree: Stroke Width | `zen.tidytabs.tree.stroke-width` | `2` |
| Tree: Branch Radius | `zen.tidytabs.tree.branch-radius` | `7` |
| Tree: Connector Opacity | `zen.tidytabs.tree.opacity` | `0.25` |
| Tree: Branch Overshoot | `zen.tidytabs.tree.branch-overshoot` | `0` |
| Tree: Folder Indent (px) | `zen.tidytabs.tree.folder-indent-px` | `12` |
| Tree: Related Child Indent (px) | `zen.tidytabs.tree.related-child-indent-px` | `20` |
| Tree: Connector Offset (px) | `zen.tidytabs.tree.connector-offset-px` | `-15` |

### Sort button appearance

| Label | Pref | Default |
|---|---|---|
| UI: Sort Button Icon Size (px) | `zen.tidytabs.ui.sort-button.icon-size` | `24` |
| UI: Sort Button Icon Opacity (0 - 1) | `zen.tidytabs.ui.sort-button.icon-opacity` | `1` |
| UI: Sort Button Font Size (px) | `zen.tidytabs.ui.sort-button.font-size` | `10` |

> **Note:** all numeric preferences are surfaced as `string` inputs (the only free-form type Zen Marketplace supports). Type your value and press Enter to apply.
