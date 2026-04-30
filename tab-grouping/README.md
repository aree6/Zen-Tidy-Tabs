# Zen Tab Grouping

Sorts and groups Zen Browser tabs by topic using local AI, OpenRouter, or deterministic fuzzy grouping.

## Features

- **AI-powered grouping** using local browser ML or OpenRouter models
- **Hybrid mode** chains OpenRouter → Local AI → Fuzzy
- **Strict modes** keep OpenRouter / Local AI / Fuzzy isolated
- **Success / failure animations** (configurable)
- **Clear-button protection** so grouped tabs are not accidentally closed
- **Context-menu actions** to sort into tab groups or folders
- **Favicon tinting** for pinned tabs and groups

## Installation

Copy the `tab-grouping/` folder into your Zen Browser mods directory and enable it.

## Preferences

| Preference | Type | Default | Description |
|------------|------|---------|-------------|
| `zen.tidytabs.grouping-strength` | string (0-1) | `0.5` | Aggressiveness of grouping |
| `zen.tidytabs.group-leftovers-as-misc` | checkbox | true | Bucket ungrouped tabs into "Miscellaneous" |
| `zen.tidytabs.ai.group-namer` | dropdown | `local` | Backend engine |
| `zen.tidytabs.openrouter.api-key` | string | "" | OpenRouter API key |
| `zen.tidytabs.behavior.protected-hosts` | string | "" | Comma-separated hosts to never auto-group |
| `zen.tidytabs.behavior.patch-clear-button` | checkbox | true | Protect grouped tabs from clear-button |
| `zen.tidytabs.ui.enable-failure-animation` | checkbox | true | Shake on failure |
| `zen.tidytabs.ui.enable-success-animation` | checkbox | true | Pulse on success |
| `zen.tidytabs.menu.sort-groups` | checkbox | true | Show sort-into-groups menu item |
| `zen.tidytabs.menu.sort-folders` | checkbox | true | Show sort-into-folders menu item |
| `zen.tidytabs.ui.enable-pinned-favicon-bg` | checkbox | true | Tint pinned tabs from favicon |
| `zen.tidytabs.ui.enable-group-favicon-bg` | checkbox | true | Tint groups from first tab's favicon |

## Standalone

This mod does **not** require the tree-connectors mod. Install it on its own.
