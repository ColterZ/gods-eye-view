# Meteor Intelligence Module — Ideas & Thoughts Log

## 2026-10-17 — Session Start

### Architecture Decisions
- **CNEOS as primary source**: Only machine-readable fireball API with velocity components. Public domain, no auth. CORS requires server-side proxy.
- **GMN for trajectories**: 85-column trajectory data, CC BY 4.0. Will add in Stage 2.
- **No AMS integration**: Scraping prohibited, no API. Would need direct contact with Mike Hankey.
- **Common event schema**: Three time fields (event/publication/retrieval), source-specific confidence, cross-source matches flagged never merged.

### Ideas for Future Considerations
- [ ] GMN trajectory enrichment — match CNEOS events to GMN trajectories by time+location
- [ ] Meteorite Landings layer — historical falls from data.nasa.gov
- [ ] NEXRAD radar context for strewn field analysis (Stage 4, needs validated methods)
- [ ] CMOR radiant data — no API, would need web scraping or direct contact
- [ ] AllSky7 camera network — contact required for access
- [ ] Strewn field prediction — implement own calculation using CNEOS trajectory + wind models
- [ ] Meteor shower flux from GMN — daily ZHR predictions
- [ ] Fireball witness reports from AMS — requires research agreement

## 2026-10-17 — Stage 1 Quality Upgrade Completed
- Fixed CNEOS proxy (`server/providers/meteors/cneos.js`) to pass `req-loc=true`, `vel-comp=true`, `sort=-date`, and a 5-year lookback window (`1825` days, up to 500 events), returning 177 located bolides with 112 full 3D velocity vectors `(vx, vy, vz)` instead of only 1 event.
- Added local ENU trajectory angle conversion (`computeLocalTrajectoryAngles`) computing entry elevation angle above horizon, compass heading (`azimuth`), and radiant bearing (`radiantAzimuth`) from ECEF `(vx, vy, vz)`.
-Skipped unlocated CNEOS rows gracefully instead of failing the entire snapshot.
- Added `src/layers/meteors/model.js` and upgraded `rendering.js`, `controls.js`, `lifecycle.js`:
  - World-overlay tactical cards (`overlayHost.setEntries('meteors', ...)`) for both ambient fireballs and protected selected fireball detail cards.
  - 3D globe rendering with log-scaled energy severity markers (`<0.5 kt`, `0.5–5 kt`, `≥5 kt`), ground footprint + altitude plumb tether, 3D atmospheric entry vector arrows (`PolylineArrowMaterialProperty`), and `EllipsoidalOccluder` horizon culling.
  - Row controls with `30D`, `90D`, `1Y`, `5Y` filter chips, `FOCUS` / `CNEOS ↗` / `CLEAR` action chips, live-counted severity & vector legend, multi-line telemetry readout (explicitly labeled delayed catalog, never live, and disclaiming meteorite fall inference), and an interactive 25-item event roster list with camera fly-to.
- Added unit tests in `src/layers/meteors/index.test.mjs` (6 suites/tests passing).

## 2026-10-17 — Stage 2 Multi-Source Fusion & Corroboration Completed
- Live endpoint discovery revealed `explore.globalmeteornetwork.org/gmn_rest_api` was returning HTTP 503, while GMN's official trajectory summary feed (`https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_latest_daily.txt` and `traj_summary_yesterday.txt`) is live, fast, and updated every 6 hours with 5,088 86-column optical trajectories.
- Created `server/providers/meteors/gmn.js` (`/api/gmn-meteors`): parses 86-column GMN trajectory summaries, extracts publication timestamp from file header, classifies parent body dynamical origin via Tisserand's parameter with respect to Jupiter ($T_J$), preserves 3D start/end coordinates, radiant, orbital elements, photometric mass ($\tau=0.7\%$), and station codes, with full CC BY 4.0 + Vida et al. (2020, 2021) attribution.
- Created `server/providers/meteors/asgard.js` (`/api/nasa-skyfalls`): parses all 210 camera-triangulated trajectories from NASA MSFC ASGARD's `skyfallmap` in a single request, enriches recent events from detail pages (supporting both `NASA Camera` and `Chicken Little` solver labels), and serves 18 curated NASA ARES radar-confirmed meteorite falls.
- Created `src/layers/meteors/corroboration.js`: non-destructive spatiotemporal matcher across `CNEOS`, `GMN`, `ASGARD`, and `ARES` (discovered 23 real cross-source corroborated events in the live 5Y window, including the 3-way Sims Corner WA match across ARES + CNEOS + ASGARD).
- Upgraded `src/layers/meteors/` with source filter chips (`ALL`, `CNEOS`, `GMN`, `ASGARD`, `FALLS`, `★ MATCHED`), `MATCH (...)` partner jump chip, external links (`GMN CAMERAS ↗`, `GMN FLUX ↗`, `AMS VIEWER ↗`), and 3D measured start-to-end trajectory arrows.

### Open Questions
- How to handle CNEOS location uncertainty? (alt is often null)
- Should we show all CNEOS events or filter by energy threshold?
- How to match CNEOS events to GMN trajectories? (time window + location radius)
- What's the right refresh interval? (CNEOS updates periodically, not real-time)
- Should stale data be hidden or just flagged?

### Technical Notes
- CNEOS API: https://ssd-api.jpl.nasa.gov/fireball.api
- CNEOS docs: https://ssd-api.jpl.nasa.gov/doc/fireball.html
- GMN REST API: https://explore.globalmeteornetwork.org/gmn_rest_api
- GMN data: https://globalmeteornetwork.org/data/traj_summary_data/
- Meteorite Landings: https://data.nasa.gov/dataset/meteorite-landings-api
- NOAA NEXRAD: s3://unidata-nexrad-level2 (no auth)

### Risks
- CNEOS CORS blocked — must proxy through Vite middleware
- GMN 1000 row limit — need pagination for large queries
- NEXRAD data is huge — need spatial filtering
- CMOR no API — may need to skip or use external links
- AMS scraping prohibited — respect terms

---
*This log is for review during and after implementation runs.*
