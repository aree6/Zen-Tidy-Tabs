# Tidy Tabs

Sort your tabs with a choice of three engines — a remote LLM via OpenRouter, Firefox's local AI, or a deterministic fuzzy fallback — preserve grouped tabs when clearing, and render folder tree connectors directly from this mod.

## What's integrated

- Topic-based tab grouping with three engines (auto-selected in this order):
  - **OpenRouter** — one-shot remote LLM grouping + naming. Active when you've set an API key and picked a model. Best quality; one HTTP request per sort.
  - **Local AI** (Firefox's on-device ML embeddings) when `browser.ml.enabled` is on and OpenRouter is not configured.
  - **Fuzzy** (deterministic token + hostname clustering) as the final fallback. No model required; also used when either remote engine errors out.
- Drops tabs into existing groups/folders when they match; creates new ones otherwise.
- Refined, minimal tab-group label styling (no colored accent line). Folders keep their native look.
- Clear-button patch that preserves grouped/folder tabs.
- Integrated Zen Folder Tree Connectors logic.

## How to sort

Right-click the **sidebar background** (the empty space in your tab area) to open Zen's workspace menu. Tidy Tabs appends two entries at the bottom with Lucide icons:

- **Tidy Tabs into Groups** — creates regular tab groups.
- **Tidy Tabs into Folders** — creates Zen Folders (which pin your tabs).

Both entries use the same engine under the hood:

- If **OpenRouter is configured** (API key + model selected), all loose tabs go to the chosen LLM in a single request. The model returns a JSON map of `{ "Topic": [tab numbers] }` which is then applied to the sidebar. Title + hostname are sent; full URLs are not.
- Else if **local AI is enabled** (`browser.ml.enabled = true`), Firefox's on-device embedding model clusters tabs and a second local model names each cluster.
- Else a **deterministic fuzzy pipeline** runs:
  1. Tokenize each tab's title + hostname (stopwords removed).
  2. Seed clusters by hostname.
  3. Merge clusters whose token sets overlap above a Jaccard threshold.
  4. Name each cluster by its most frequent descriptive token, falling back to a prettified hostname.

Any OpenRouter failure (network, rate limit, bad JSON, timeout) silently degrades to the fuzzy engine so sorting never breaks.

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
| Group leftovers as 'Miscellaneous' | `zen.tidytabs.group-leftovers-as-misc` | `true` |
| OpenRouter API Key | `zen.tidytabs.openrouter.api-key` | `""` |
| AI Group Namer | `zen.tidytabs.ai.group-namer` | `local` |

> **Tip:** **Grouping Strength** (0–1) is a single knob that drives both AI and fuzzy modes. **0 = conservative** (only near-identical tabs group); **1 = aggressive** (loosely-related tabs still group). Default `0.5` is balanced. Disable either menu entry if you only use one container style.

## Optional: OpenRouter for smarter grouping

By default, grouping runs fully on-device (local AI when `browser.ml.enabled` is on, otherwise fuzzy). If Firefox's local embeddings aren't producing clean groupings for you, you can route the **entire** grouping decision through a free OpenRouter LLM — one request per sort, no local embeddings involved.

1. Grab a free API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Paste it into **OpenRouter API Key** in the mod settings.
3. Pick a model from **AI Group Namer**:

| Option | Model | Why |
|---|---|---|
| `local` *(default)* | Firefox on-device models | Offline, zero cost, private |
| `ling-flash` | `inclusionai/ling-2.6-flash:free` | Explicit "flash" model — lowest latency |
| `llama33-70b` | `meta-llama/llama-3.3-70b-instruct:free` | Most accurate free instruct model |
| `gemma3-27b` | `google/gemma-3-27b-it:free` | Balanced speed + quality |
| `glm-air` | `z-ai/glm-4.5-air:free` | Lightweight MoE with real-time mode |

### What actually gets sent

For every loose tab in the current workspace, the mod sends a numbered line like `3. [github.com] facebook/react`. **Only the title and hostname are transmitted** — paths and query strings are deliberately excluded so browsing history doesn't leak. Existing group names in the workspace are also sent as a hint so the model reuses them instead of inventing near-duplicates (`"Shopping"` vs `"E-commerce"`).

### Rate limits

Free-tier OpenRouter allows ~20 requests/minute and 200/day per model. Because each sort is a **single** request (regardless of how many tabs), you'd have to sort 200 times in a day to hit the cap.

### Failure behavior

If OpenRouter returns non-JSON, errors out, or times out (20 s), the mod silently falls back to the deterministic fuzzy engine so a sort always completes.
