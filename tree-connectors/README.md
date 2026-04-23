# Zen Tree Connectors

Visual tree connectors for Zen Browser folder tabs and tab groups.

## Features

- Draws elegant connector lines between folder/group parents and their children
- Supports both **zen-folder** containers and regular **tab-group** containers
- Optionally draws dashed connectors for **related (child) tabs**
- Auto-refreshes on DOM mutations, resizes, animations, and folder toggles
- Respects light/dark theme automatically

## Installation

Install as a Zen Browser userChrome mod. The mod runs entirely client-side.

## Preferences

| Preference | Type | Default | Description |
|---|---|---|---|
| `zen.treeconnectors.enabled` | checkbox | true | Master toggle for the mod |
| `zen.treeconnectors.include-related-tabs` | checkbox | true | Draw connectors for opener-based related tabs |
| `zen.treeconnectors.refresh-on-animations` | checkbox | true | Refresh connectors during CSS animations |
| `zen.treeconnectors.line-x` | string | 6 | Horizontal offset of connector lines |
| `zen.treeconnectors.stroke-width` | string | 2 | Width of connector strokes |
| `zen.treeconnectors.branch-radius` | string | 7 | Corner radius for branch bends |
| `zen.treeconnectors.opacity` | string | 0.25 | Opacity of connector lines (0-1) |

## Standalone

This mod is fully standalone and does **not** require any other Tidy Tabs features.
