# Zen Tab Grouping

A standalone mod that sorts and groups your Zen Browser tabs by topic using either on-device AI embeddings or OpenRouter.

## Features

- **AI-powered grouping** using local browser ML or OpenRouter models
- **Fuzzy fallback** clustering when AI is unavailable
- **Rescue passes** ensure every tab lands in a group
- **Success / failure animations** (configurable)
- **Clear-button protection** so grouped tabs are not accidentally closed
- **Context-menu actions** to sort into tab groups or folders

## Installation

Copy the `tab-grouping/` folder into your Zen Browser mods directory and enable it.

## Preferences

All preferences live under the `zen.tabgrouping.` branch.

| Preference | Type | Default | Description |
|------------|------|---------|-------------|
| `grouping-strength` | string (0-1) | `0.5` | Aggressiveness of grouping |
| `group-leftovers-as-misc` | checkbox | true | Bucket ungrouped tabs into "Miscellaneous" |
| `ai.group-namer` | dropdown | `local` | Backend for topic naming |
| `openrouter.api-key` | string | "" | OpenRouter API key |
| `behavior.protected-hosts` | string | "" | Comma-separated hosts to never auto-group |
| `behavior.patch-clear-button` | checkbox | true | Protect grouped tabs from clear-button |
| `ui.enable-failure-animation` | checkbox | true | Shake on failure |
| `ui.enable-success-animation` | checkbox | true | Pulse on success |
| `menu.sort-groups` | checkbox | true | Show sort-into-groups menu item |
| `menu.sort-folders` | checkbox | true | Show sort-into-folders menu item |

## Standalone

This mod does **not** require the tree-connectors mod. Install it on its own.
