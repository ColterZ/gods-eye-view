# Ordered Upgrade Spec: Stage 5 Meteorite Ablation, Aerodynamics & Field-Recovery Physics

**Target Repo:** `C:\Users\Don\Documents\GodsEyeView-Meteor` (branch `meteor-intelligence`)
**Execution Mode:** Sequential Goal Loop / Antigravity (`agy`) for file-only edits + Hermes test/build/browser verification after each phase.

---

## Execution Order & Acceptance Criteria

### Phase 1: Terrain Elevation Intersection (`groundElevationM`)
- **Problem:** `integrateFragmentDarkFlight` in `src/layers/meteors/darkFlight.js` currently integrates down to sea level (`s.alt <= 0`). Continental recovery sites (e.g. Sims Corner, WA at `~690 m` ASL) sit hundreds of meters above sea level; falling an extra `690 m` through boundary-layer shear (`15–35 s` extra fall time) shifts `3g–50g` fragments `300–1,500 m` downwind.
- **Implementation:**
  1. Add `groundElevationM` parameter to `integrateFragmentDarkFlight` (defaulting to `event?.location?.groundElevationM ?? 0`, with documented site elevations in `foundStones.js` / `asgard.js` — `690 m` for Sims Corner plateau, and Open-Meteo `elevation` field from the sounding response when available).
  2. Terminate RK4 integration at `s.alt <= groundElevationM` and linearly interpolate the final step to `alt = groundElevationM`.
  3. Expose `groundElevationM` (`Ground Elevation ASL (m)`) as an editable row in `stoneFit.parameterReport` and the right-rail `#meteor-panel` Auto-Fit table.
- **Verification:** Unit test in `src/layers/meteors/index.test.mjs` asserting that `groundElevationM = 690` terminates tracks at `690 m` and reduces fall time vs `0 m`.

---

### Phase 2: Coupled Hypersonic Ablation (`dm/dt`) & Luminous-to-Dark Transition (`v > 3 km/s`)
- **Problem:** Camera termini (`45.5 km` for Sims Corner) occur while fragments are still moving above the `~3.0 km/s` ablation threshold. Currently `massKg` is held constant (`dm/dt = 0`) with an empirical `highAltFactor` drag multiplier.
- **Implementation:**
  1. Add coupled mass-loss differential equation inside `derivAt(s)` in `src/layers/meteors/darkFlight.js` whenever `vRel > V_ABLATION_THRESHOLD_MS` (`3000 m/s`):
     $$\frac{dm}{dt} = -\frac{1}{2} \Lambda \frac{A \, \rho_{\text{air}} \, v_{\text{rel}}^3}{Q_{\text{abl}}} = -\sigma_{\text{abl}} \, \Gamma \, A \, \rho_{\text{air}} \, v_{\text{rel}}^3$$
     where $\sigma_{\text{abl}} \in [0.008, 0.045]\text{ s}^2/\text{km}^2$ (`default 0.018 s²/km²` for ordinary chondrites).
  2. Evolve `s.mass` alongside `(lat, lon, alt, vx, vy, vz)` in RK4, recomputing fragment `diameter` and `area` as mass ablates until `vRel <= 3000 m/s` (dark-flight onset).
  3. Record `darkFlightOnsetAltKm`, `ablationMassLossPct`, and burnout flag (`s.mass < 0.0005 kg`) on each trajectory.
  4. Expose `ablationSigma` (`Ablation Coefficient σ (s²/km²)`) in `stoneFit.parameterReport` and the right-rail Auto-Fit table.
- **Verification:** Unit test verifying mass loss occurs above `3 km/s`, stops below `3 km/s`, and records `ablationMassLossPct`.

---

### Phase 3: Transverse Fragmentation Impulse / Bow-Shock Lateral Ejection ($v_\perp$)
- **Problem:** Deterministic spine trajectories have `0` cross-track ejection velocity, and Monte Carlo relies on arbitrary position jitter rather than shock-wave repulsion during breakup.
- **Implementation:**
  1. Implement the Artemieva–Shuvalov / Passechnik bow-shock transverse velocity model at each fragmentation flare (`F1` and `F2`):
     $$v_\perp = C_T \sqrt{\frac{\rho_{\text{air}}(z_{\text{break}})}{\rho_m}} \, v_{\text{break}} \left(\frac{m}{m_0}\right)^{-1/6}$$
     where $C_T \in [0.1, 1.5]$ (`default 0.55`).
  2. Apply $\pm v_\perp$ cross-track components to the `OVER / UNDER` corridor envelopes and radial azimuth angles $\phi \in [0, 2\pi)$ in the Monte Carlo ensemble.
  3. Expose `lateralImpulseCoeff` (`Bow-Shock Lateral Impulse C_T`) in `stoneFit.parameterReport` and the right-rail Auto-Fit table.
- **Verification:** Unit test verifying cross-track spread scales physically with atmospheric density at breakup and $m^{-1/6}$.

---

### Phase 4: Magnus / Aerodynamic Lift & Oriented vs. Tumbling Gliding ($C_L / C_D$)
- **Problem:** Tabular and oriented ("shield") stones develop aerodynamic lift ($L/D \approx 0.03\text{–}0.15$) during the `150–300 s` subsonic fall, shifting outlier stones up/down-range or cross-track outside the pure-drag ellipse.
- **Implementation:**
  1. Add aerodynamic lift acceleration $\vec{a}_L = \frac{1}{2} \rho_{\text{air}} v_{\text{rel}}^2 \frac{C_L A}{m} \hat{e}_L$ perpendicular to $\vec{v}_{\text{rel}}$ in `integrateFragmentDarkFlight`, parameterized by `liftToDragRatio` ($C_L / C_D$, `0` for tumbling spheres, `0.04–0.14` for tabular/oriented chondrites) and lift azimuth angle.
  2. Sample stochastic tumbling/gliding lift in Monte Carlo and expose `liftToDragRatio` in `stoneFit.parameterReport`.
- **Verification:** Unit test confirming non-zero `liftToDragRatio` displaces landing coordinates relative to pure ballistic drag.

---

### Phase 5: Vertical Wind (`w`) / Orographic Wave & Boundary-Layer Turbulence
- **Problem:** Small stones (`3g–30g`) fall at `15–28 m/s`, so `1–3 m/s` vertical updrafts/downdrafts and PBL gust shear shift landing zones by hundreds of meters.
- **Implementation:**
  1. Extend `parseOpenMeteoSounding` and `interpolateWind(sounding, altM)` to support vertical wind component `w` (`m/s`, derived from pressure vertical velocity or terrain-induced lee-wave parameter) and altitude-dependent turbulent gust variance $\sigma_u(z), \sigma_v(z), \sigma_w(z)$.
  2. Subtract `wind.w` in `vRelZ = s.vz - wind.w` inside `derivAt(s)`.
- **Verification:** Unit test confirming positive updraft `w > 0` increases fall time and downwind drift for `<30 g` stones.

---

### Phase 6: Impact Terminal Velocity, Kinetic Energy & Soil Penetration Depth
- **Problem:** Field hunters need to know whether each mass class sits on the surface or embeds in soil/turf/hardpan.
- **Implementation:**
  1. At ground impact (`alt === groundElevationM`), record `impactSpeedMs = Math.hypot(s.vx, s.vy, s.vz)`, `impactAngleDeg`, `impactEnergyJ = 0.5 * s.mass * impactSpeedMs ** 2`, and Poncelet soil penetration depth `penetrationDepthCm` across 3 surface presets (`Soft Soil / Plowed Field`, `Grassland / Sagebrush Steppe`, `Hardpan / Compacted Gravel`).
  2. Display `Impact Speed (m/s)`, `Kinetic Energy (J)`, and `Est. Burial Depth (cm)` in the Right-Rail `Mass Cascade Tracks` and `Found Stones & Recovery Editor` tables.
- **Verification:** Unit test asserting realistic terminal speeds (`~15–25 m/s` for `3–10g`, `~65–95 m/s` for `1 kg`) and monotonic penetration depth.

---

### Phase 7: Weibull Progressive Fracture Cascade ($\sigma_{\text{frag}} = \sigma_0 (m_0 / m)^\alpha$)
- **Problem:** Multi-stage fragmentation currently uses fixed `50/50` F1/F2 lobe weights rather than deriving flare altitudes and child mass distributions from aerodynamic ram pressure $P_{\text{dyn}}(z) = \rho(z) v^2$ vs. Weibull size-dependent tensile strength.
- **Implementation:**
  1. Model parent-to-daughter fracture when $P_{\text{dyn}}(z) \ge \sigma_0 (m_0 / m)^\alpha$ ($\alpha \approx 0.18$), automatically computing fragment survival fractions between `Sub-Bolide F1 (Upper)` and `Sub-Bolide F2 (Terminal)` and power-law mass distribution exponent.
  2. Surface the Weibull strength parameters ($\sigma_0$ MPa, exponent $\alpha$) in the `Doppler Radar, Satellite Stereo & Yield Diagnostics` dropdown.
- **Verification:** Full test suite (`node --test src/layers/meteors/index.test.mjs`), production build (`npx vite build`), and live headless browser CDP check.
