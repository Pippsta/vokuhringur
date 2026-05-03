# Vökuhringur

Static page that visualises and predicts the sleep–wake pattern of `Edson`, who has non-24-hour sleep–wake cycle. Awake-evidence comes from two sources: chess.com game endpoints (machine-recorded) and friend observations (manual).

Read-only. No backend, no auth. Deployable by git push.

## Refresh (5 min)

**Chess data:**

1. Re-run the chess.com export script to get a fresh `eidurm_games.xlsx`.
   Recipe: [`../../reference/chess-com-export-recipe.md`](../../reference/chess-com-export-recipe.md). The script writes the xlsx to the `Claude/` root.
2. Copy / replace the xlsx into this folder (`projects/Vokuhringur/eidurm_games.xlsx`).

**Friend data:**

1. Open `friend_awake_times.xlsx`, append new rows in column A (`Awake Timestamp`), save.
   Times are entered in Iceland local time (= UTC, since Iceland has no DST).

**Then, regardless of which source changed: double-click `refresh.cmd`.**

It runs `convert.py` to regenerate `observations.json`, stages the data files, and commits + pushes. If the project isn't a git repo yet, it'll just regenerate the JSON locally and tell you to set up git when you're ready.

If you'd rather do it by hand:

```
python convert.py
git add observations.json friend_awake_times.xlsx eidurm_games.xlsx
git commit -m "data refresh"
git push
```

Tip: the xlsx files are in OneDrive, so editing `friend_awake_times.xlsx` from the Excel app on your phone or web Excel is enough — OneDrive syncs the change to your dev machine, and `refresh.cmd` does the rest.

Dependencies: `openpyxl` (already required by the upstream export). No other packages.

## Files

- `eidurm_games.xlsx` — raw chess.com export.
- `friend_awake_times.xlsx` — manual friend observations, single column `Awake Timestamp`.
- `convert.py` — both xlsx files → `observations.json`. Drops daily/correspondence chess games.
- `refresh.cmd` — Windows double-click wrapper: runs `convert.py`, stages the data files, commits, pushes. Falls back gracefully if git isn't set up yet.
- `observations.json` — bundled data the page reads. Wrapper object with `subject`, `sources`, `generated_at`, `counts`, and `observations: [{ ts, source }]` where `source` is `"chess"` or `"friend"`. Sorted ascending.
- `model.js` — period-and-phase prediction model (ES module). Public API: `collapseSessions`, `fitTau`, `predict`. Loaded by both pages below.
- `index.html` — **the dashboard**. Mobile-first, narrow column. Single big verdict card for "now" with confidence colour-band, "last seen" line, a compact 14-day double-plotted mini-raster, a quick predict-anywhere input, and a `Details →` link. The page friends actually open day-to-day.
- `details.html` — **the detailed view**. Full meta line, density chart, full drift raster (2025-01-01 → today + 14 d), model performance + calibration tables, full predict panel with debug, and a `← Dashboard` link back to `index.html`. Linked from the dashboard footer.

## Run locally

The page uses `fetch()` to load `observations.json`, which browsers block on `file://` URLs. Serve over HTTP instead:

```
python -m http.server 8765
```

Then open <http://localhost:8765/>. Any static server works — `npx serve`, VS Code Live Server, etc.

## Data-quality notes (conversion of 2026-05-02)

**Chess endpoints (1187 kept of 1193 input rows)**

- 6 daily/correspondence games excluded — endpoint is too weak as awake-evidence (final move can be hours or days after the player was last awake).
- 2 `chess960` variant games kept; the variant doesn't change the awake-signal.
- No null `EndTime` values, no duplicate end times.
- Date range: 2017-12-28 → 2026-03-28. **~90 % of chess observations fall in 2025**, dominated by Feb–Aug 2025. Only one chess observation between Aug 2025 and now.
- **Heavy session clustering**: 114 game-pairs are <5 min apart, 417 are 5–15 min apart. Loop 3 must avoid treating a back-to-back rapid session as N independent observations.

**Friend observations (50 kept of 50 input rows)**

- Range: 2025-07-06 → 2026-05-02 (the latest is current to today). 34 in July 2025, then 16 spread across Feb–May 2026.
- Minute-precision (no seconds), no nulls, no duplicates.
- Treated as UTC; assumes the entries were made in Iceland local time.
- **Fills the recency gap** in the chess data — `predict(now)` is no longer extrapolating 9 months past the last observation.

**Both sources together: 1237 observations, 2017-12-28 → 2026-05-02.**

**Observation bias** (cross-source caveat for Loop 3): chess endpoints capture "when Edson chose to play chess online"; friend observations capture "when a friend happened to see / hear from him". Both are presence-evidence. Absence-evidence is weak in both.

## Architecture

- Single static HTML page, vanilla JS, Observable Plot for the chart.
- `predict(events, tau, queryMs) -> { pAwake: number, confidence: "high" | "medium" | "low", debug }` is the locked interface; the visualization treats it as a black box.
- Iceland is UTC year-round. All timestamps in `observations.json` are UTC and equal local time — no DST handling needed.

## Model (Loop 3)

Lives in `model.js`. Steps:

1. **Session collapsing.** Adjacent chess observations within 30 minutes of each other are grouped into one session, represented by the session's median timestamp. Friend observations always pass through. Stops a 12-game chess session from out-voting 12 friend sightings.
2. **Period fit.** Search τ ∈ [22 h, 27 h] in 0.02 h steps. Score each candidate by recency-weighted Rayleigh R of the collapsed events' phases (only events from the last 365 days, weighted `exp(−Δt / 90 days)`). Pick max R.
3. **Predict at query t.** Restrict to events in the last 90 days. Recency-weight `exp(−Δt / 30 days)`. Compute weighted von Mises KDE on the phase circle (κ = 8, ≈ 1.3 h bandwidth). Map to pAwake = 0.5 + 0.4 · R · normalised_density(φ_q), so a tight wake cluster (high R) gives wide-swing predictions and a diffuse cluster (low R) keeps predictions near 0.5.
4. **Confidence.** Three indicators:
   - Effective sample size (`ESS = (Σw)² / Σw²`).
   - Staleness — days since the latest event ≤ query.
   - Rayleigh R — concentration of recent phases.
   - Low if ESS < 5 OR staleness > 30 d OR R < 0.3. High if ESS > 20 AND staleness < 7 d AND R > 0.6. Else medium.

The model is deliberately conservative: a single global period is fit, even though the raster shows alternating lock-and-drift episodes. A piecewise / state-space approach is a future-loop idea; for now, low R (≈ 0.36 on the full data) honestly reflects that the signal is real but not tight.

## Calibration & baselines

Run automatically on every page load and shown in the **Model performance** panel. Method:

- Chronological 80 / 20 split on collapsed events.
- Each held-out event = positive (label 1, awake).
- Each positive's matched synthetic negative = same instant shifted back by τ / 2 (the antipodal phase, expected sleep). Synthetic, because we have no direct asleep-evidence — only awake-presence.
- For each labelled sample, predict using only the training set and score against (a) our model, (b) flat 50 / 50, (c) "awake during 08:00–22:00 UTC" with pAwake 0.9 inside / 0.1 outside.

Latest run (2026-05-02 data, 1187 chess + 50 friend → 571 collapsed events):

| Model                           | Brier ↓ | Accuracy ↑ |
|---------------------------------|---------|------------|
| **Vökuhringur model**           | **0.234** | **0.587** |
| Flat 50/50 baseline             | 0.250   | 0.500      |
| Local-daytime (08–22 UTC)       | 0.347   | 0.578      |

Beats both baselines on Brier. Local-daytime is hurt badly because Edson's wake hours regularly fall outside 08–22 UTC — exactly the point of the project.

Confidence-bin breakdown on the held-out 230 samples:

- **high**: 0 samples — the model never claims high confidence anywhere in the data, which is correct given the global R = 0.36 (signal is real but not tight).
- **medium**: 180 samples · accuracy 0.58 · Brier 0.234.
- **low**: 50 samples · accuracy 0.60 · Brier 0.232.

Caveats with this evaluation:

- Synthetic negatives are an approximation; the model's true asleep-discrimination is only as good as the period fit and the phase shift assumption. Real asleep-evidence (sleep tracker, etc.) would be a stronger test.
- Brier 0.234 vs 0.250 is a 6 % relative reduction in MSE — modest absolute lift, but better than baseline on the right side.
- The empty "high" bucket is the model behaving honestly on weak-signal data, not a code bug.
