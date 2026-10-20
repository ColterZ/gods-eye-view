# God's Eye View — Multi-Sensor Meteor & Dark-Flight Physics Engine: Master Architecture, Literature Reference & Troubleshooting Guide

**Repository:** `ColterZ/gods-eye-view` (branch `meteor-intelligence`)  
**Engine Version:** Stage 5 Universal Multi-Sensor Pipeline (`commits 4d780593 → 292be330`)  
**Scope:** End-to-end physical modeling, multi-bolide fragmentation cascades, RK4 dark-flight integration, multi-sensor corroboration (ASGARD, GMN, CNEOS, ARES, NEXRAD, GOES GLM/ABI, EarthScope Seismic, AMS), ground-truth calibration, and diagnostic playbook for future engineers and AI agents.

---

## 1. System Architecture & Module Map

The meteor intelligence system strictly follows the repository's layer lifecycle pattern (`state → source → model → rendering → controls → lifecycle`) across server providers and client physics/rendering modules:

| Layer / Role | File Path | Responsibility |
| :--- | :--- | :--- |
| **Upstream Providers (Server)** | `server/providers/meteors/asgard.js` | Scrapes and parses NASA MSFC ASGARD multi-camera optical event reports, extracting 3D trajectories (`startLat/Lon/AltKm`, `endLat/Lon/AltKm`, `azimuth`, `entryAngle`, `entryVelocity`), narrative yields/altitudes (feet/miles/MPH/tons TNT), camera stations, and curated NASA ARES confirmed meteorite falls. |
| | `server/providers/meteors/cneos.js` | Ingests NASA/JPL CNEOS USG satellite bolide catalog (`energy`, `impact-e`, `lat/lon/alt`, ECI/ECEF velocity components `vx, vy, vz`) and converts 3D ECEF velocity vectors into local ENU trajectory angles (`azimuth`, `radiantAzimuth`, `entryAngle`, `entryVelocity`) via `computeLocalTrajectoryAngles()`. |
| | `server/providers/meteors/gmn.js` | Ingests Global Meteor Network (GMN) multi-camera orbital & atmospheric solutions (`startAltKm`, `endAltKm`, `entryVelocity`, photometric mass, shower code). |
| | `server/providers/meteors/ams.js` | Ingests American Meteor Society (AMS) witness fireball logs, sightlines, and video/photo reports. |
| | `server/providers/meteors/sounding.js` | Queries Open-Meteo Historical Forecast / ERA5 Reanalysis (`1000 hPa → 30 hPa`, surface to ~24 km) for the exact event timestamp and coordinates, returning geopotential altitude, temperature, pressure, and $(u, v, w)$ wind vectors. |
| | `server/providers/meteors/seismic.js` | Queries EarthScope / IRIS FDSN station waveforms and arrival times for acoustic/seismic N-wave airburst multilateration. |
| **Cross-Source Corroboration** | `src/layers/meteors/corroboration.js` | Spatiotemporally links events across `ARES`, `ASGARD`, `GMN`, `CNEOS`, and `AMS` without silently merging distinct sensor records. Synchronizes confirmed `ARES` ground falls with corroborated `ASGARD`/`GMN` camera directional vectors while strictly preserving `ARES` ground strewn-field coordinates. |
| **Multi-Model Physics Engine** | `src/layers/meteors/darkFlight.js` | Implements the CIRA-72 / US Standard Atmosphere 1976 model, Gritsevich $(\alpha, \beta)$ ballistic-ablation scaling, multi-bolide Weibull fracture cascade (`F1..FN`), progressive mass-tiered shedding, 4th-order Runge-Kutta (RK4) 3D dark-flight integrator with Mach/Reynolds/Knudsen drag, 160-fragment seeded Monte Carlo ensemble, and Poncelet soil impact penetration. |
| **Multi-Sensor Validation & Audit** | `src/layers/meteors/validation.js` | Computes 3D double-ended entry/dark-flight uncertainty cones, NOAA WSR-88D NEXRAD Doppler radar beam intersection gates, GOES-16/18/19 GLM parallax & ABI Band 7/13 IR diagnostics, seismic N-wave ray tracing, Over/Under ground yield sanity bounds, and the 6-part **Independent NASA & Field-Hunter KMZ Audit**. |
| **Ground-Truth Calibration** | `src/layers/meteors/foundStones.js` | Maintains documented recovered stones (`McDonough`, `Sims Corner`, `Wadsworth`, `Hopewell`, `Amo`) and runtime user-injected stone maps. Computes mass-matched RK4 residuals and Tikhonov-regularized 2-stage parameter optimization (`autoFitDarkFlightToFoundStones`). |
| **3D Globe Visualization** | `src/layers/meteors/rendering.js` | Renders the 3D luminous entry spine, sub-bolide burst spheres (`F1..FN`), 3D uncertainty cones, mass-sorted dark-flight trajectories (`1 kg → 3g`), retardation knees, $1\sigma / 2\sigma$ covariance ellipses, NEXRAD radar polygons, and Found Stone markers on the Cesium globe. |
| **Interactive Diagnostics UI** | `src/layers/meteors/panel.js` | Renders `#meteor-panel` with 12 live fine-tuning sliders, multi-bolide breakup tables, NEXRAD/GOES/Seismic sensor cards, and the 6-part Independent Audit table. |

---

## 2. Physical Equations & Mathematical Formulation

### 2.1 Coordinate Systems & Local Horizon Transformation (`cneos.js`)
For satellite-detected bolides (NASA/JPL CNEOS) reporting geocentric ECEF velocity $(v_x, v_y, v_z)$ at geodetic latitude $\phi$ and longitude $\lambda$, the local East-North-Up (ENU) velocity components are:

$$\begin{bmatrix} v_E \\ v_N \\ v_U \end{bmatrix} = \begin{bmatrix} -\sin\lambda & \cos\lambda & 0 \\ -\sin\phi\cos\lambda & -\sin\phi\sin\lambda & \cos\phi \\ \cos\phi\cos\lambda & \cos\phi\sin\lambda & \sin\phi \end{bmatrix} \begin{bmatrix} v_x \\ v_y \\ v_z \end{bmatrix}$$

- **Propagation Azimuth (heading toward which the meteoroid travels):**
  $$\theta_{\text{az}} = \left(\text{atan2}(v_E, v_N) \cdot \frac{180^\circ}{\pi} + 360^\circ\right) \bmod 360^\circ$$
- **Radiant Azimuth (direction from which the meteoroid arrived):**
  $$\theta_{\text{rad}} = (\theta_{\text{az}} + 180^\circ) \bmod 360^\circ$$
- **Entry Elevation Angle (below/above local horizontal):**
  $$\gamma = \text{atan2}\!\left(-v_U, \sqrt{v_E^2 + v_N^2}\right) \cdot \frac{180^\circ}{\pi}$$

---

### 2.2 Atmosphere Model (`atmosphereTemperature`, `atmospherePressure`, `getAtmosphere`)
The engine implements the 7-layer **US Standard Atmosphere 1976 / CIRA-72** from $z = 0\text{ m}$ to $85\text{ km}$:
- Ideal gas density: $\rho(z) = \frac{P(z)}{R_{\text{gas}} T(z)}$ with $R_{\text{gas}} = 287.058\text{ J/(kg}\cdot\text{K)}$
- Speed of sound: $c_s(z) = \sqrt{\gamma_{\text{air}} R_{\text{gas}} T(z)}$ with $\gamma_{\text{air}} = 1.4$
- Dynamic viscosity via **Sutherland's Law**:
  $$\mu(T) = \mu_0 \left(\frac{T}{T_0}\right)^{3/2} \frac{T_0 + S}{T + S}, \quad \mu_0 = 1.7894\times 10^{-5}\text{ Pa}\cdot\text{s}, \; T_0 = 288.15\text{ K}, \; S = 110.4\text{ K}$$
- Molecular mean free path:
  $$\ell(z) = \frac{\mu(T)}{P(z)} \sqrt{\frac{\pi R_{\text{gas}} T(z)}{2}}$$

---

### 2.3 Multi-Bolide Weibull Fracture Cascade (`computeWeibullFractureCascade`)
As the meteoroid descends at speed $V(z)$, aerodynamic ram pressure is:

$$p_{\text{dyn}}(z) = \rho(z) V(z)^2$$

Following **Weibull (1951)**, **Passey & Melosh (1980)**, **Borovička, Spurný & Brown (2020)**, and **Moscati et al. (2026)**, structural failure occurs when $p_{\text{dyn}}(z)$ exceeds the size-scaled tensile/compressive strength $S$. When a parent body of mass $M_p$ and strength $S_p$ fractures into child fragments of mass $m_c$, the child strength increases as a power law of the volume/mass ratio:

$$S_c = S_p \left(\frac{M_p}{m_c}\right)^\alpha, \quad \alpha \approx 0.18\text{–}0.25 \text{ (ordinary chondrites)}$$

This produces **1 to 5 discrete fragmentation episodes (`Sub-Bolide F1 .. FN`)** along the 3D entry spine:
1. **Upper Flare (`F1`, typically `32–44 km`, $p_{\text{dyn}} \approx 0.4\text{–}1.2\text{ MPa}$):** Initial disruption along pre-existing shock veins (`Borovička et al. 2020` first peak). Sheds outer-crust spall fragments and dust.
2. **Intermediate Bursts (`F2..FN-1`, `24–31 km`, $p_{\text{dyn}} \approx 1.5\text{–}3.2\text{ MPa}$):** Secondary splitting into independent sub-bolides that continue decelerating along the 3D spine.
3. **Terminal Disruption / Continuum Release Zone (`20–24 km`, $p_{\text{dyn}} \approx 2.8\text{–}5.0\text{ MPa}$):** Final fragmentation where surviving stones separate by ballistic coefficient $B = m / (C_d A)$ and enter individual **retardation knees** (`12–21 km`).

#### Why Small Fragments (`3g–30g`) Must Peel Off Progressively Along the Lower Breakup Column (Not All at 42 km and Not All at a Single 20 km Point)
 This is a critical physical subtlety:
- **If a 3g grain is released naked at 42 km at 18 km/s:** Its area-to-mass ratio $A/m \propto m^{-1/3}$ is $6.9\times$ larger than a $1\text{ kg}$ stone. Over 90% of naked 3g grains released at 42 km completely ablate, and any survivor stops dead at `~36–39 km` where stratospheric winds blow it 10–15 km *behind* (up-range of) the main breakup.
- **If all 7 masses (`1 kg` down to `3g`) are forced to detach at the exact same 20.0 km point:** All 7 tracks overlap as a single rigid straight line down to 20.0 km (halfway down from a 40 km bolide), where the 3g track makes an artificial razor-sharp kink.
- **Physical Progressive Shedding (`buildSubBolideSweep`):** During the terminal fragmentation cascade (`~25 km → 20 km`), outer-crust spall (`3g`, `10g`, `30g`) peels off progressively earlier along the 3D spine (`~22.4 km → 21.2 km`), while denser interior blocks (`100g → 1 kg`) hold together down to `20.6 km → 20.0 km`. Each mass band therefore branches smoothly off the parent spine at its own physical altitude and curves through its own **retardation knee** (`~19.9 km` for `3g`, `~18.6 km` for `10g`, `~15.9 km` for `100g`, `~12.6 km` for `1 kg`).

---

### 2.4 Why Small Stones (`3g–10g`) Visually Curve Twice on Jet-Stream / Wind-Sheared Falls (e.g. 2025-11-11 Florida)
A falling meteorite's 3D trajectory has **three distinct physical segments**:
1. **Segment 1 — Hypersonic/Supersonic Coast (above the Retardation Knee, $z > z_{\text{knee}}$):**
   The fragment is still traveling at $V \gg c_s$ (`7,000 m/s → 340 m/s`) along the meteoroid's entry azimuth $\theta_{\text{az}}$ (e.g. `221° SW` on 2025-11-11). Wind speed (`10–55 m/s`) is $<1\%$ of fragment speed, so the track points straight along $\theta_{\text{az}}$.
2. **Segment 2 — The Retardation Knee & Upper-Tropospheric Jet Stream Drift ($z_{\text{knee}} \to 3\text{ km}$):**
   At the **retardation knee** ($V \le 340\text{ m/s}$, occurring at `~19.9 km` for `3g` vs `~12.6 km` for `1 kg` — roughly **halfway down** from a `42 km` fireball to the ground), cosmic forward momentum is exhausted. The fragment now falls at terminal velocity $V_T(z) = \sqrt{\frac{2mg}{\rho(z) A C_d}}$ (`~26–45 m/s` for `3g`).
   - On **2025-11-11 off Florida**, the subtropical jet stream between `9 km` and `17 km` blows at **`55.8 m/s` (`125 mph`) toward `67°–84° ENE/E`**. Because the cross-wind (`25–55 m/s`) exceeds or matches the `3g` stone's vertical fall speed, the `3g` trajectory bends sharply at its retardation knee (`~19 km`) from **Southwest (`221°`)** to **East-Southeast (`~120°`)**.
3. **Segment 3 — Planetary Boundary Layer / Trade-Wind Shear ($2.5\text{ km} \to 0\text{ km}$):**
   Below `2.5 km` on 2025-11-11, the wind shifts by `90°` into a low-level northeasterly trade wind (`12.8 m/s` from `358°`, blowing toward **`178° due South`**), curving the final 2 km of the `3g` track southward into the ocean.

---

### 2.5 3D Equations of Motion & RK4 Integrator (`integrateFragmentDarkFlight`)
In the local spherical-Earth East-North-Up (ENU) frame at $(\phi, \lambda, z)$ with Earth radius $R = R_\oplus + z$, the 7-state ODE system $(x=\lambda, y=\phi, z, v_x, v_y, v_z, m)$ is integrated via 4th-order Runge-Kutta:

$$\begin{aligned}
\frac{d\phi}{dt} &= \frac{v_y}{R_\oplus + z}, \qquad \frac{d\lambda}{dt} = \frac{v_x}{(R_\oplus + z)\max(0.01, \cos\phi)}, \qquad \frac{dz}{dt} = v_z \\
\frac{dv_x}{dt} &= a_{\text{aero},x} + 2\Omega_\oplus(v_y \sin\phi - v_z \cos\phi) \\
\frac{dv_y}{dt} &= a_{\text{aero},y} - 2\Omega_\oplus v_x \sin\phi \\
\frac{dv_z}{dt} &= a_{\text{aero},z} - \left(g_0 - \Omega_\oplus^2 (R_\oplus + z)\cos^2\phi\right) + 2\Omega_\oplus v_x \cos\phi \\
\frac{dm}{dt} &= -\frac{1}{2} \sigma_{\text{abl}} C_d A \rho(z) |\mathbf{v}_{\text{rel}}|^3 \quad (\text{active when } |\mathbf{v}_{\text{rel}}| > V_{\text{abl}} = 3000\text{ m/s})
\end{aligned}$$

where:
- **Drag Coefficient $C_d(\text{Ma}, \text{Re}, \text{Kn})$ (`computeDragCoefficient`):**
  - Free-molecular slip ($\text{Kn} > 10$): $C_d = 2.1$
  - Hypersonic continuum ($\text{Ma} > 4$): $C_d = 0.72$
  - Supersonic ($1.2 < \text{Ma} \le 4$): $C_d = 0.72 + 0.34 e^{-4.5(\text{Ma} - 1.2)}$
  - Transonic wave-drag peak ($0.8 < \text{Ma} \le 1.2$): $C_d = 0.58 + 0.48 e^{-8|\text{Ma} - 1.0|}$
  - Subsonic Stokes / transitional ($\text{Re} < 1000$): Schiller-Naumann $C_d = \frac{24}{\text{Re}}(1 + 0.15 \text{Re}^{0.687})$
  - Subsonic turbulent continuum ($\text{Re} \ge 1000, \text{Ma} \le 0.8$): $C_d = 0.56$ (coupled with cross-sectional shape factor $\Gamma = 1.15$, yielding effective non-spherical chondrite drag $C_d \Gamma \approx 0.65\text{–}0.75$ per **Towner et al. 2022** / **Haider & Levenspiel 1989**).
- **Parent-Wake Headwind Entrainment (`derivAt`):**
  The horizontal wind $\mathbf{w} = (u, v)$ is decomposed into along-track $w_\parallel = \mathbf{w}\cdot\hat{\mathbf{t}}$ and cross-track $w_\perp = \mathbf{w}\cdot\hat{\mathbf{n}}$. Opposing upper-air headwinds ($w_\parallel < 0$) are damped ($0.12 w_\parallel$) to model parent-carrier wake shielding during deceleration, while tailwinds ($w_\parallel \ge 0$) and cross-track wind drift ($w_\perp$) act at $100\%$.

---

## 3. Primary Scientific Literature & Operational Citations

1. **Moscati, M., Fenucci, M., Faggioli, L., Micheli, M., Ocaña, F., & Cano, J. L. (2026).** *"From orbit to ground: Pre-impact meteorite strewn field predictions."* Astronomy & Astrophysics / arXiv:2609.01722v1 (ESA Planetary Defence Office `Meerkat / Aegis` strewn-field pipeline).
   - *Used for:* Continuous 3D trajectory propagation, Weibull strength scaling $S_c = S_p(M_p/m_c)^\alpha$, bimodal chondrite strength distributions ($[0.04, 0.12] \cup [0.9, 5.0]\text{ MPa}$), Passey & Melosh transverse breakup impulse, and linear sub-step DEM terrain intersection.
2. **Towner, M. C., Jansen-Sturgeon, T., Cupák, M., Sansom, E. K., Devillepoix, H. A. R., Bland, P. A., et al. (2022).** *"Dark-flight Estimates of Meteorite Fall Positions: Issues and a Case Study Using the Murrili Meteorite Fall."* The Planetary Science Journal, 3(2), 44.
   - *Used for:* Non-spherical drag calibration (Haider & Levenspiel 1989 sphericity $\varphi$, Miller & Bailey 1979 transonic sphere tables), 3D Coriolis + centrifugal terms, wind profile sensitivity, and the **Murrili (2015)** benchmark (`451 m` end-to-end accuracy in our engine).
3. **Moilanen, J., Gritsevich, M., & Lyytinen, E. (2021).** *"Determination of strewn fields for meteorite falls."* Monthly Notices of the Royal Astronomical Society, 503(3), 3337–3350 (Finnish Fireball Network `DFMC`).
   - *Used for:* Gritsevich dimensionless ballistic $(\alpha)$ and ablation $(\beta)$ parameters, shape-change coefficient $\mu = 2/3$, ablation cessation at $v_{\text{abl}} \approx 3\text{ km/s}$ ($T_{\text{stag}} \approx 1800\text{ K}$), and starting fragments on the luminous trajectory spine above terminal breakup.
4. **Borovička, J., Spurný, P., & Brown, P. (2020).** *"Small asteroids as regular meteors / Two-stage fragmentation of ordinary chondrites."* In * Meteoroids: Sources of Meteors on Earth and Beyond* (Cambridge Univ. Press); and **Spurný, P. et al. (2014)**, *A&A* 570, A39 (*Benešov*).
   - *Used for:* Multi-stage fragmentation cascade (`0.04–0.12 MPa` upper flare vs `0.9–5.0 MPa` lower burst), progressive erosion/spall shedding of small grains (`3g–30g`), and the Gamma convention.
5. **Fries, M., & Fries, J. (2010).** *"Doppler weather radar as a meteorite recovery tool."* Meteoritics & Planetary Science, 45(9), 1476–1487 (NASA JSC ARES `Jörmungandr`).
   - *Used for:* NOAA WSR-88D NEXRAD Doppler radar sweep gate geometry, terminal-velocity fall-time mass inversion ($\Delta t = t_{\text{sweep}} - t_{\text{bolide}}$), and Type A/B/C radar echo verification.
6. **Passey, Q. R., & Melosh, H. J. (1980).** *"Effects of atmospheric breakup on crater field formation."* Icarus, 42(2), 211–233.
   - *Used for:* Bow-shock transverse fragmentation impulse velocity $V_T = C_T \sqrt{\rho_{\text{air}} / \rho_m} V_{\text{breakup}}$.
7. **Goodall, J. (2019–2026).** *"StrewnLAB / Strewnify Monte Carlo Meteorite Strewn Field Simulator"* (`Sims Corner`, `Blacksville/McDonough`, `Windfall/Wadsworth`).
   - *Used for:* Check #6 (`fieldHunterKmzAudit`) cross-comparison and CNEOS $\pm 0.05^\circ$ quantization uncertainty cones.

---

## 4. Diagnostic & Troubleshooting Playbook for Future AI Models & Engineers

When troubleshooting a fall that looks wrong in 3D or on the ground, **never hardcode per-event coordinate overrides**. Run through these **9 invariant checks** in order:

### Invariant 1: Never Let Synthetic `ARES` Catalog Numbers Override a Live Camera (`ASGARD` / `GMN`) Trajectory
- **Past Bug (`McDonough GA`):** `ares:mcdonough-ga` had a placeholder `azimuth: 142.0° (SE)` in `asgard.js` that shadowed the real NASA ASGARD multi-camera triangulation `asgard:20250626-162457` (`azimuth: 233.0° WSW`), sending the entire strewn field in the wrong direction.
- **Rule:** Curated `ARES_FALLS` entries in `server/providers/meteors/asgard.js` must **never** include synthetic `trajectory` objects when a corroborated live `ASGARD` or `GMN` camera event exists. Let `corroboration.js` and `darkFlight.js` borrow the directional trajectory from the real camera partner.

### Invariant 2: Never Let Camera Sky Coordinates (`endLat`, `endLon`) Overwrite an `ARES` Ground Strewn-Field Location
- **Past Bug (`Gateway AR` 37.4 km off, `Houston TX` 21.0 km off):** When `corroboration.js` matched an `ARES` ground fall (`alt = 0 km`) with an `ASGARD` camera track (`endAlt = 46–58 km`), doing `aresEv.trajectory = { ...camEv.trajectory }` copied the camera's `57.6 km` high-altitude cutoff `(endLat, endLon)` onto `aresEv.trajectory`. Then `darkFlight.js` line 827 initialized `lat = t.endLat`, shifting the ground target `21–37 km` up-range!
- **Rule:** In `corroboration.js`, copy only directional/altitude camera fields (`azimuth`, `entryAngle`, `entryVelocity`, `startAltKm`, `endAltKm`, `startLat`, `startLon`) onto `aresEv.trajectory`, and always force `aresEv.trajectory.endLat = aresEv.location.lat` and `aresEv.trajectory.endLon = aresEv.location.lon`.

### Invariant 3: Never Trigger `refProbe` Ground-to-Sky Inversion Simply Because `rawAltKm <= 24`
- **Past Bug (`Murrili 2015` 6.84 km error, `Near-Vertical Plunge` 4.5 km shift):** `darkFlight.js` previously had `else if (... || rawAltKm <= 24 || ...)`, which assumed *any* event with `rawAltKm <= 24` was a `0 km` ground coordinate and ran `refProbe` backwards to subtract wind drift. When a real camera tracked a fireball down to `17.96 km` (*Murrili*), it subtracted the wind drift twice!
- **Rule:** `refProbe` sky-origin inversion must **only** run when `hasGroundAnchorage` is true (`event.source === 'ares'`, `aresMatch`, `nexradGate.polygon.length >= 3`, or `foundStones.length > 0`). Camera endpoints at `12–24 km` without a ground anchor must integrate **forward** from `(rawLat, rawLon, rawAltKm)`.

### Invariant 4: High-Altitude Camera/Satellite Cutoffs (`> 24 km`) Must Project Forward Along the 3D Spine All the Way to `effectiveReleaseAltM`
- **Past Bug (`2025-11-11 Florida` small stones behind breakup):** `dropKm` was calculated down to `zRelKm = 35 km` (`dropKm = 7 km`), but `effectiveAltM` was assigned `20 km`. That moved the 3D spine 8.5 km backwards (up-range NE) of the 42 km CNEOS bolide!
- **Rule:** Whenever projecting a high-cutoff sky point `(lat, lon, terminalAltM)` down to `effectiveReleaseAltM`, `effectiveDropKm` MUST equal `(terminalAltM - effectiveReleaseAltM) / 1000` so `(effectiveLat, effectiveLon, effectiveAltM)` is strictly collinear with `(rawLat, rawLon, terminalAltM)` along `(azimuthDeg, entryAngleDeg)`.

### Invariant 5: Never Add Artificial High-Altitude Drag Multipliers (`highAltFactor`)
- **Past Bug (`Sims Corner WA`):** An artificial `highAltFactor` up to `55×` above `22 km` acted like a brick wall at `31–41 km`, stopping fragments dead in the stratosphere where upper winds blew them backwards.
- **Rule:** Always use pure US Standard Atmosphere dynamic pressure $q = \frac{1}{2}\rho(z) v_{\text{rel}}^2$.

### Invariant 6: Check `vDarkMs` Unit Scaling When Modifying Gritsevich $(\alpha, \beta)$ Parameters
- **Past Bug:** Dividing `entryVelMs` by `1000` twice in `beta` reduced `vDarkMs` to the `3,000 m/s` clamp for every fireball, causing `3g` stones to stop within `1.3 km` of release and make an acute `100°` corner.
- **Rule:** `vDarkMs` at the continuum release zone (`~20 km`) must remain in the physical `[6400, 7600] m/s` band so fragments transition smoothly through their mass-sorted retardation knees (`12.6 km` for `1 kg` → `19.9 km` for `3g`).

### Invariant 7: Single-Stone Falls (`foundStones.length < 2`) Must Use Locked Spatial Regularization in `autoFit`
- **Past Bug (`Wadsworth OH`):** With only 1 recovered stone (`617g` eucrite), allowing `autoFitDarkFlightToFoundStones` to shift `latDeltaDeg / lonDeltaDeg` over-tuned the wind/terminus and pulled the `100g` reference point `1.68 km` off-track.
- **Rule:** When `stones.length < 2`, `singleStoneMode` locks `latOffsets = [0]`, `lonOffsets = [0]`, `azDeltas = [0]` and increases the shift penalty weight (`0.85`).

### Invariant 8: Antimeridian (`±180°`) Wrapping & Terrain DEM (`groundElevationM`) Schema
- **Past Bug:** Pacific fireballs crossing `180°E` returned `null` inside `integrateFragmentDarkFlight` (`Math.abs(state.lon) > Math.PI`), producing `massSweep: []`. High-mountain soundings storing `sounding.summary.groundElevationM` defaulted to `0 m`.
- **Rule:** Wrap `state.lon` into $[-\pi, \pi]$ at every RK4 step, and resolve `prelimGroundElevM` across `sounding.groundElevationM ?? sounding.summary.groundElevationM ?? event.location.elevationM`.

### Invariant 9: Partner Arrow Occlusion (`_hiddenByDarkFlight`) During Globe Camera Moves
- **Past Bug:** `applyOcclusionVisibility()` in `rendering.js` ran on every globe pan/zoom and reset `entity.show = true` on corroborated partner arrows that `renderMeteorDarkFlight()` had hidden.
- **Rule:** Always check `if (entity._hiddenByDarkFlight) { entity.show = false; continue; }` at the top of `applyOcclusionVisibility()`.

---

## 5. Quick CLI Verification Commands

Any engineer or AI agent can run the full verification suite in under 20 seconds from `C:\Users\Don\Documents\GodsEyeView-Meteor`:

```bash
# 1. Run the 19-test unit & multi-fall benchmark suite (Sims Corner, McDonough, Wadsworth, Hopewell, Amo, Cockburn Island)
node --test src/layers/meteors/index.test.mjs

# 2. Verify production bundle compilation
npm run build
```
