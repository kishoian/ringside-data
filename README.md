# ringside-data

Hourly leaderboard data for the Ringside browser extension, served from GitHub.

## Sources and scales

| Category | Primary source | Score |
|---|---|---|
| Text | Artificial Analysis LLM leaderboard | Intelligence Index v5.0 |
| Code | Artificial Analysis Terminal-Bench 4.0 evaluation page | Terminal-Bench 4.0 pass rate, percent |
| Image | Artificial Analysis text-to-image leaderboard | Overall Elo |
| Video | Artificial Analysis text-to-video leaderboard | Overall Elo, with audio |

Code uses a single benchmark for all rows. It does not substitute Intelligence Index or mix legacy coding indexes with Terminal-Bench results. Artificial Analysis currently lists fewer models on the dedicated Terminal-Bench 4.0 page than it previously exposed on the general models page, so the code category contains only models with a currently published score. Video uses the overall audio pool; scores from silent video and individual content categories are separate pools and are excluded.

Artificial Analysis updated the Intelligence Index to v5.0 in October 2026. Text includes only models with a published v5.0 score; prior-version scores are not mixed into the new ranking. The weekly snapshot resets once on this methodology change so deltas do not compare different index versions. Snapshot keys distinguish model variants, preventing a lower-effort variant from being compared with the highest-scoring variant in its family.

OpenRouter enriches context and pricing; its per-token prices are converted to per-million-token units. Arena.ai provides optional supplementary human ratings when accessible. Its failure does not erase the primary ratings.

## Refresh

```sh
npm ci
npm test
npm run refresh
```

The script decodes Next.js Flight JSON strings and follows the media boards' referenced overall data maps. It writes `leaderboard.json` only after validating all four primary categories. Empty categories, non-finite scores, or a loss of over half a category's rows fail the run before overwriting published data. Substantial intentional source changes therefore require review.

`updatedAt` records the successful collection time, not the date a benchmark was performed. `categoryMeta` names each scale and links its source; `sources` records optional failures. The extension rejects downloads older than 48 hours and reports partial data when supplementary sources fail.

GitHub Actions runs hourly, serializes refresh jobs, tests before collection, and commits the validated leaderboard and weekly snapshot. A primary source failure fails the workflow instead of publishing an empty category.
