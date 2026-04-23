# Tidy Tabs TODO

## Completed in this pass

- [x] Fix clear-flow bug: preserve grouped/folder tabs more reliably in `closeAllUnpinnedTabs` patch by using container-aware detection.
- [x] Fix nested-folder flow: avoid duplicate `addTabs` attachments when a child folder is created and already contains moved tabs.
- [x] Improve pipeline heuristics: choose engine (OpenRouter / local AI / fuzzy) using tab-count and title-signal checks.
- [x] Improve naming robustness: use stable numeric suffixing for duplicate group labels.
- [x] Improve reuse: centralize container map upsert logic with `upsertContainerByLabel` + `getLabelKey`.
- [x] Expose protected-host behavior in `preferences.json`.
- [x] Align docs/comments with current engine behavior and heuristics.

## Next high-impact items

- [ ] Add optional completion feedback toast after sort with compact stats (`engine`, `groups`, `moved tabs`).
- [ ] Add lightweight telemetry counters in logs (only local console) to compare engine quality over time.
- [ ] Tighten OpenRouter response validation for malformed nested structures before flattening.
- [ ] Add a soft cap for per-group tab count (configurable) to prevent giant catch-all groups.
- [ ] Add a quick “Dry Run Group Preview” mode (no moves, log-only) for debugging complex workspaces.

## Nice-to-have UX polish

- [ ] Improve menu labeling clarity for non-technical users (explicitly mention pinned behavior for folder mode).
- [ ] Add an optional setting to keep currently selected tab fixed in place after sort.
- [ ] Add optional alphabetical reordering of groups/folders after grouping.
