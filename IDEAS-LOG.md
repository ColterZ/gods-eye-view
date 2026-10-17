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
