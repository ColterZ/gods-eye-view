import { t } from '../../i18n/index.js';

/**
 * Create the meteor / fireball context panel that mounts into the right-hand
 * rail (#meteor-panel).  The panel is the presentation partner of the meteor
 * layer's `getRowControls` full descriptor: it receives the descriptor via
 * `sync()` on every layer refresh and renders the browsing / event / dark-flight
 * views with collapsible sections, editable found-stone rows, auto-fit tuning
 * deltas and sensor diagnostics.
 *
 * All mutations flow back to the layer through `setLayerParams`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container The #meteor-panel element.
 * @param {HTMLElement} [opts.countBadge] The #meteor-panel-count badge.
 * @param {HTMLElement} [opts.body] The #meteor-panel-body scroller.
 * @param {(id: string, params: object, options?: object) => void} [opts.setLayerParams]
 * @returns {{ sync: (descriptor: object) => void, destroy: () => void }}
 */
export function createMeteorPanel({
  container,
  countBadge,
  body,
  setLayerParams = () => {},
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement || !container || !body) return null;

  let destroyed = false;
  let currentDescriptor = null;
  let currentChipsById = new Map();
  let currentListItems = [];
  let currentStones = [];
  let currentTuning = null;
  let currentDarkFlight = null;
  let currentValidation = null;
  let currentStoneFit = null;
  let currentSelected = null;
  let currentDarkFlightActive = false;
  let lastSignature = null;
  let lastSelected = null;
  const sectionExpandedState = new Map();

  /* ------------------------------------------------------------------ */
  /*  Small DOM helpers                                                 */
  /* ------------------------------------------------------------------ */
  const el = (tag, className, parent) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  };
  const btn = (label, className, title) => {
    const b = el('button', className || 'data-btn', null);
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };
  const input = (type, className, placeholder) => {
    const i = el('input', `data-input ${className || ''}`, null);
    i.type = type;
    if (placeholder) i.placeholder = placeholder;
    return i;
  };
  const makeSection = (sectionKey, titleText, className, defaultExpanded = true) => {
    const expanded = sectionExpandedState.has(sectionKey)
      ? sectionExpandedState.get(sectionKey)
      : defaultExpanded;
    const section = el('section', `meteor-section ${className || ''}`.trim(), null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.dataset.sectionKey = sectionKey;
    header.setAttribute('aria-expanded', String(expanded));
    header.setAttribute('aria-controls', `meteor-${sectionKey}-body`);
    el('span', 'meteor-section-title', header).textContent = titleText;
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = `meteor-${sectionKey}-body`;
    content.hidden = !expanded;
    header.addEventListener('click', () => {
      const nowExpanded = header.getAttribute('aria-expanded') !== 'true';
      sectionExpandedState.set(sectionKey, nowExpanded);
      header.setAttribute('aria-expanded', String(nowExpanded));
      content.hidden = !nowExpanded;
    });
    return { section, header, content };
  };

  /* ------------------------------------------------------------------ */
  /*  Section: Time & Source filters                                    */
  /* ------------------------------------------------------------------ */
  function renderFilterSection(chips) {
    const { section, content } = makeSection(
      'filters',
      t('Filters & Sources'),
      'meteor-filters',
      true,
    );

    const timeGroup = el('div', 'meteor-chip-group', content);
    el('span', 'meteor-chip-group-label', timeGroup).textContent = t('Time window');
    for (const chip of chips.filter((c) => c.id.startsWith('window-'))) {
      const b = btn(chip.label, `data-chip${chip.active ? ' active' : ''}`, chip.title);
      b.dataset.chipId = chip.id;
      b.disabled = !!chip.disabled;
      if (chip.params) b.dataset.params = JSON.stringify(chip.params);
      timeGroup.appendChild(b);
    }

    const sourceGroup = el('div', 'meteor-chip-group', content);
    el('span', 'meteor-chip-group-label', sourceGroup).textContent = t('Source');
    for (const chip of chips.filter((c) => c.id.startsWith('source-'))) {
      const b = btn(chip.label, `data-chip${chip.active ? ' active' : ''}`, chip.title);
      b.dataset.chipId = chip.id;
      b.disabled = !!chip.disabled;
      if (chip.params) b.dataset.params = JSON.stringify(chip.params);
      sourceGroup.appendChild(b);
    }

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Scene & Action chips (shown when an event is selected)   */
  /* ------------------------------------------------------------------ */
  function renderActionSection(chips) {
    const { section, content } = makeSection(
      'actions',
      t('Scene & Actions'),
      'meteor-actions',
      true,
    );

    for (const chip of chips) {
      if (chip.id.startsWith('window-') || chip.id.startsWith('source-')) continue;
      const b = btn(chip.label, `data-chip${chip.active ? ' active' : ''}`, chip.title);
      b.dataset.chipId = chip.id;
      b.disabled = !!chip.disabled;
      b.classList.toggle('busy', !!chip.busy);
      if (chip.params) b.dataset.params = JSON.stringify(chip.params);
      content.appendChild(b);
    }

    const vpShotBtn = btn(
      '📷 SCREENSHOT',
      'data-chip',
      t('Capture a screenshot of the current viewport'),
    );
    vpShotBtn.dataset.screenshotMode = 'viewport';
    const boxShotBtn = btn(
      '📐 BOX CAPTURE',
      `data-chip${globalThis.window?.__gevScreenshot?.isActive?.() ? ' active' : ''}`,
      t('Click and drag a rectangle on the ground to generate an image'),
    );
    boxShotBtn.dataset.screenshotMode = 'box';
    content.append(vpShotBtn, boxShotBtn);

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Event list (browser mode)                                */
  /* ------------------------------------------------------------------ */
  function renderEventList(list, defaultOpen = true) {
    if (!list) return null;
    const { section, content } = makeSection(
      'events',
      `${list.ariaLabel || t('Events')}`,
      'meteor-event-list',
      defaultOpen,
    );

    const ul = el('ul', 'meteor-event-list', content);
    for (const item of list.items || []) {
      const li = el('li', 'meteor-event-item', ul);
      li.dataset.eventId = item.id;
      const b = btn(item.text, 'meteor-event-link', null);
      b.dataset.eventId = item.id;
      b.classList.toggle('active', !!item.active);
      li.appendChild(b);
    }

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Selected event summary                                   */
  /* ------------------------------------------------------------------ */
  function renderInfoSection(infoText, infoTitle) {
    if (!infoText) return null;
    const { section, content } = makeSection(
      'info',
      t('Event Trajectory, Speed & Context'),
      'meteor-info',
      true,
    );
    const pre = el('pre', 'meteor-info-text', content);
    pre.textContent = infoText;
    if (infoTitle) pre.title = infoTitle;
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Dark Flight diagnostics (shown when dark flight active)  */
  /* ------------------------------------------------------------------ */
  function renderDarkFlightSection(df) {
    if (!df) return null;
    const { section, content } = makeSection(
      'dark-flight',
      t('Dark Flight & Auto-Fit Tuning'),
      'meteor-dark-flight',
      true,
    );

    const table = el('table', 'meteor-param-table', content);
    const tbody = el('tbody', null, table);

    const rows = [
      ['Regime', df.regime || 'n/a'],
      ['2σ Footprint', df.ellipse2Sigma
        ? `${((df.ellipse2Sigma.semiMajorM * 2) / 1000).toFixed(1)}×${((df.ellipse2Sigma.semiMinorM * 2) / 1000).toFixed(1)} km (axis ${df.ellipse2Sigma.orientationDeg}°)`
        : 'n/a'],
    ];
    if (df.sounding) {
      rows.push([
        'Wind Sounding',
        `Peak ${df.sounding.peakWindSpeedMs ?? 0} m/s at ${df.sounding.peakWindAltitudeKm ?? 0} km`,
      ]);
    }

    for (const [label, value] of rows) {
      const tr = el('tr', null, tbody);
      el('th', 'meteor-param-label', tr).textContent = label;
      el('td', 'meteor-param-value', tr).textContent = value;
    }

    /* Auto-Fit parameter report: BASELINE → FITTED, with the delta and the
       solver's own bounds. `parameterReport` is authored by darkFlight.js so
       the labels, units and semantic readings stay in one place. */
    const report = df.stoneFit?.parameterReport;
    if (Array.isArray(report) && report.length > 0) {
      const sf = df.stoneFit;
      const summary = el('div', 'meteor-autofit-summary', content);
      el('span', 'meteor-autofit-label', summary).textContent = t('Auto-Fit Tuning');
      el('span', 'meteor-autofit-rms', summary).textContent =
        `RMS ${sf.baselineRmsM}m → ${sf.bestRmsM}m`;
      el('span', 'meteor-autofit-hint', summary).textContent =
        t('edit any value to override the fit');

      const tuneTable = el('table', 'meteor-param-table meteor-tune-table', content);
      const tuneHead = el('thead', null, tuneTable);
      const tuneHeadRow = el('tr', null, tuneHead);
      for (const h of ['Parameter', 'Baseline', 'Fitted', 'Δ Change']) {
        el('th', null, tuneHeadRow).textContent = h;
      }
      const tuneTbody = el('tbody', null, tuneTable);

      for (const p of report) {
        const tr = el('tr', null, tuneTbody);
        tr.dataset.paramKey = p.key;
        el('th', 'meteor-param-label', tr).textContent = p.label || p.key;

        el('td', 'meteor-param-before', tr).textContent = p.beforeFormatted ?? '—';

        const afterCell = el('td', 'meteor-param-after', tr);
        const editor = input('number', `meteor-tuning-edit meteor-tuning-${p.key}`, null);
        editor.dataset.paramKey = p.key;
        editor.value = String(p.afterValue ?? '');
        if (Number.isFinite(p.min)) editor.min = String(p.min);
        if (Number.isFinite(p.max)) editor.max = String(p.max);
        if (Number.isFinite(p.step)) editor.step = String(p.step);
        afterCell.appendChild(editor);
        const reading = el('span', 'meteor-param-reading', afterCell);
        reading.textContent = p.afterFormatted ?? '';
        reading.title = p.afterFormatted ?? '';

        const changed = Number(p.afterValue) !== Number(p.beforeValue);
        tr.classList.toggle('meteor-param-changed', changed);
        const delta = el('td', 'meteor-param-delta', tr);
        delta.textContent = changed ? p.deltaFormatted ?? '—' : '—';
      }
    }

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Found Stones & Recovery Editor (editable)                 */
  /* ------------------------------------------------------------------ */
  function renderFoundStonesSection(comparisons) {
    const { section, content } = makeSection(
      'found-stones',
      t('Found Stones & Recovery Editor'),
      'meteor-found-stones',
      true,
    );

    const table = el('table', 'meteor-stone-table', content);
    const thead = el('thead', null, table);
    const headerTr = el('tr', null, thead);
    for (const h of ['Stone', 'Mass (g)', 'Latitude', 'Longitude', 'Type', 'Fragment', 'Burial / V_imp', 'Δ Residual', 'Actions']) {
      el('th', null, headerTr).textContent = h;
    }
    const tbody = el('tbody', null, table);

    for (let i = 0; i < comparisons.length; i++) {
      const c = comparisons[i];
      const tr = el('tr', 'meteor-stone-row', tbody);
      tr.dataset.stoneId = c.stone.id || c.stone.label || `stone-${i}`;

      const labelCell = el('td', 'meteor-stone-label', tr);
      const labelInput = input('text', 'meteor-stone-label-input', null);
      labelInput.value = c.stone.label || '';
      labelInput.dataset.stoneId = tr.dataset.stoneId;
      labelInput.dataset.field = 'label';
      labelCell.appendChild(labelInput);

      const massCell = el('td', null, tr);
      const massInput = input('number', 'meteor-stone-mass-input', null);
      massInput.value = c.stone.massGrams || '';
      massInput.step = '0.1';
      massInput.dataset.stoneId = tr.dataset.stoneId;
      massInput.dataset.field = 'massGrams';
      massCell.appendChild(massInput);

      const latCell = el('td', null, tr);
      const latInput = input('number', 'meteor-stone-lat-input', null);
      latInput.value = String(c.stone.lat ?? c.stone.latitude ?? '');
      latInput.step = '0.0001';
      latInput.dataset.stoneId = tr.dataset.stoneId;
      latInput.dataset.field = 'lat';
      latCell.appendChild(latInput);

      const lonCell = el('td', null, tr);
      const lonInput = input('number', 'meteor-stone-lon-input', null);
      lonInput.value = String(c.stone.lon ?? c.stone.longitude ?? '');
      lonInput.step = '0.0001';
      lonInput.dataset.stoneId = tr.dataset.stoneId;
      lonInput.dataset.field = 'lon';
      lonCell.appendChild(lonInput);

      const typeCell = el('td', null, tr);
      const typeInput = input('text', 'meteor-stone-type-input', null);
      typeInput.value = c.stone.type || '';
      typeInput.dataset.stoneId = tr.dataset.stoneId;
      typeInput.dataset.field = 'type';
      typeCell.appendChild(typeInput);

      const fragCell = el('td', null, tr);
      fragCell.textContent = c.fragmentationEpisode || '';

      const penCell = el('td', 'meteor-stone-error', tr);
      const sim = c.simulated || {};
      penCell.textContent =
        sim.penetrationDepthCm != null && sim.impactSpeedMs != null
          ? `${sim.penetrationDepthCm}cm @ ${sim.impactSpeedMs}m/s`
          : '—';
      if (sim.penetrationBySurface) {
        penCell.title = `Impact Energy: ${sim.impactEnergyJ ?? 0} J · Soft soil: ${sim.penetrationBySurface.softSoilCm} cm · Grassland: ${sim.penetrationBySurface.grasslandCm} cm · Hardpan: ${sim.penetrationBySurface.hardpanCm} cm`;
      }

      const errorM = el('td', 'meteor-stone-error', tr);
      errorM.textContent = `Δ ${c.errorM}m`;

      const actionCell = el('td', 'meteor-stone-actions', tr);
      const flyBtn = btn('🛫', 'meteor-stone-fly', t('Fly to stone'));
      flyBtn.dataset.stoneId = tr.dataset.stoneId;
      flyBtn.title = t('Fly camera to this stone location');
      const delBtn = btn('🗑', 'meteor-stone-delete', t('Remove stone'));
      delBtn.dataset.stoneId = tr.dataset.stoneId;
      delBtn.title = t('Remove this found stone');
      actionCell.append(flyBtn, delBtn);
    }

    /* Add new stone / Reset stones row */
    if (currentSelected) {
      const addTr = el('tr', 'meteor-stone-add-row', tbody);
      const addCell = el('td', null, addTr);
      addCell.colSpan = 9;
      const addBtn = btn('＋ Add Found Stone', 'meteor-stone-add-btn', t('Add a new found stone to this event'));
      addBtn.dataset.action = 'addStone';
      const resetBtn = btn('↺ Reset Stones & Fit', 'meteor-stone-add-btn', t('Reset found stones and tuning to documented baseline'));
      resetBtn.dataset.action = 'resetStones';
      resetBtn.style.marginTop = '4px';
      addCell.append(addBtn, resetBtn);
    }

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Sensor diagnostics                                         */
  /* ------------------------------------------------------------------ */
  function renderValidationSection(val) {
    if (!val) return null;
    const { section, content } = makeSection(
      'validation',
      t('Doppler Radar, Satellite Stereo & Yield Diagnostics'),
      'meteor-validation',
      true,
    );

    const pre = el('pre', 'meteor-info-text', content);
    const lines = [];

    if (val.pathCones) {
      const pc = val.pathCones;
      lines.push(`📐 3D Flight-Path Uncertainty Cones (${pc.methodLabel}): 1σ Entry ±${(pc.entryRadius1SigmaM / 1000).toFixed(2)} km → Waist ±${(pc.waistRadius1SigmaM / 1000).toFixed(2)} km → Terminus ±${(pc.terminusRadius1SigmaM / 1000).toFixed(2)} km (2σ outer ±${(pc.terminusRadius2SigmaM / 1000).toFixed(2)} km · radiant ±${pc.angularUncertaintyDeg}° · vel ±${pc.velocityUncertaintyPct}%)`);
    }
    if (val.overUnder) {
      const ou = val.overUnder;
      const floorNote = ou.recoveredFloor
        ? `Recovered Floor: ${ou.recoveredFloor.totalGrams}g (${ou.recoveredFloor.stoneCount} stones, max ${ou.recoveredFloor.maxStoneGrams}g / ${ou.recoveredFloor.maxStoneDiamCm}cm) · `
        : '';
      lines.push(`⚖ Ground Yield & Stone Size Over/Under: ${floorNote}UNDER (1σ): ${ou.under1Sigma.totalYieldKg} kg (${ou.under1Sigma.totalYieldLb} lb, max stone ~${ou.under1Sigma.maxStoneGrams}g / ${ou.under1Sigma.maxStoneDiamCm}cm) · CONSENSUS: ${ou.consensusMedian.totalYieldKg} kg (${ou.consensusMedian.totalYieldLb} lb, max stone ~${ou.consensusMedian.maxStoneGrams}g / ${ou.consensusMedian.maxStoneDiamCm}cm) · OVER (2σ): ${ou.over2Sigma.totalYieldKg} kg (${ou.over2Sigma.totalYieldLb} lb, max stone ~${ou.over2Sigma.maxStoneGrams}g / ${ou.over2Sigma.maxStoneDiamCm}cm)`);
    }
    if (val.radarCheck) {
      const rc = val.radarCheck;
      lines.push(`📡 NEXRAD Doppler Radar Gate (${rc.station} · ${rc.gateTimeUtc.slice(11, 19)} UTC @ ${rc.gateAltitudeKm} km · Δt +${rc.elapsedSec}s · ${rc.reflectivityDbz} dBZ): ${rc.verdict}`);
    }
    if (val.goesDiag) {
      const gd = val.goesDiag;
      lines.push(`🛰 ${gd.satellite}: GLM 14km-ellipsoid parallax shift ${gd.parallaxShiftKm} km toward ${gd.parallaxBearingDeg}° · ${gd.abiBand7Swir}`);
    }
    if (val.weibullCascade?.summary) {
      lines.push(`💥 ${val.weibullCascade.summary}`);
    }
    if (Array.isArray(val.sanityWarnings) && val.sanityWarnings.length > 0) {
      lines.push(`🔍 Sanity Checks: ${val.sanityWarnings.join(' | ')}`);
    }

    pre.textContent = lines.join('\n');
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Mass cascades (dark flight fragment trajectories)         */
  /* ------------------------------------------------------------------ */
  function renderMassCascadeSection(df) {
    if (!df || !df.darkFlightTracks) return null;
    const { section, content } = makeSection(
      'mass-cascade',
      t('Mass Cascade Tracks & Burial Depth'),
      'meteor-masscascade',
      false,
    );

    const table = el('table', 'meteor-param-table', content);
    const thead = el('thead', null, table);
    const hdrTr = el('tr', null, thead);
    for (const h of ['Episode', 'Mass (g)', 'V_imp / Energy', 'Burial (cm)', 'Landing (lat, lon)']) {
      el('th', null, hdrTr).textContent = h;
    }
    const tbody = el('tbody', null, table);
    const tracks = df.darkFlightTracks || [];
    for (const tk of tracks) {
      const tr = el('tr', null, tbody);
      el('td', null, tr).textContent = tk.episode || 'n/a';
      el('td', null, tr).textContent = tk.massGrams || '';
      el('td', null, tr).textContent =
        tk.impactSpeedMs != null
          ? `${tk.impactSpeedMs} m/s (${Math.round(tk.impactEnergyJ || 0)} J)`
          : '';
      el('td', null, tr).textContent =
        tk.penetrationDepthCm != null ? `${tk.penetrationDepthCm} cm` : '';
      const landingCell = el('td', null, tr);
      landingCell.textContent = tk.landingLat ? `${tk.landingLat.toFixed(4)}, ${tk.landingLon.toFixed(4)}` : 'n/a';
      if (tk.landingLat) {
        const flyBtn = btn('🛫', 'meteor-mc-fly', t('Fly to this mass pin'));
        flyBtn.dataset.lat = String(tk.landingLat);
        flyBtn.dataset.lon = String(tk.landingLon);
        flyBtn.dataset.alt = '0';
        landingCell.appendChild(flyBtn);
      }
    }

    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Main sync — builds or rebuilds the entire panel body               */
  /* ------------------------------------------------------------------ */
  function sync(descriptor) {
    if (destroyed || !descriptor) return;

    /* A rebuild replaces every node, so typing in a stone field would lose
       focus and caret on the next notify. Capture the active editor first. */
    const active = document.activeElement;
    const focused = active && body.contains(active)
      ? {
          field: active.dataset?.field || null,
          paramKey: active.dataset?.paramKey || null,
          stoneId: active.dataset?.stoneId || null,
          className: active.className,
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
    const prevScrollTop = body.scrollTop || 0;

    const chipsById = new Map((descriptor.chips || []).map((c) => [c.id, c]));
    const nextSelected = chipsById.has('clear-selected')
      ? descriptor.list?.items?.find((i) => i.active)?.id || true
      : null;

    /* Skip the rebuild when nothing the panel renders has changed — a dark
       flight run notifies several times and each rebuild is a full teardown. */
    const signature = JSON.stringify([
      (descriptor.chips || []).map((c) => [c.id, c.active, c.label, c.busy]),
      descriptor.info,
      (descriptor.list?.items || []).map((i) => [i.id, i.lead, i.active]),
      (descriptor.legend || []).map((l) => [l.label, l.count]),
      descriptor.darkFlight ? Object.keys(descriptor.darkFlight).length : 0,
      descriptor.stoneFit?.bestRmsM ?? null,
      (descriptor.stoneFit?.comparisons || []).map((c) => [
        c.stone?.id,
        c.stone?.label,
        c.stone?.massGrams,
        c.stone?.lat ?? c.stone?.latitude,
        c.stone?.lon ?? c.stone?.longitude,
        c.stone?.type,
        c.errorM,
      ]),
      (descriptor.stoneFit?.parameterReport || []).map((p) => [
        p.key,
        p.afterValue,
        p.deltaFormatted,
      ]),
      descriptor.validation ? Object.keys(descriptor.validation).length : 0,
    ]);
    if (signature === lastSignature && nextSelected === lastSelected) {
      currentDescriptor = descriptor;
      return;
    }
    lastSignature = signature;

    currentDescriptor = descriptor;
    currentChipsById = chipsById;
    currentListItems = descriptor.list?.items || [];
    currentSelected = nextSelected;
    lastSelected = currentSelected;

    /* Extract dark-flight-specific blocks from the info text or state */
    currentDarkFlightActive = currentChipsById.has('toggle-dark-flight')
      ? currentChipsById.get('toggle-dark-flight').active || false
      : false;

    body.innerHTML = '';

    /* Filters section — always visible when layer is enabled */
    const filterChips = descriptor.chips.filter(
      (c) => c.id.startsWith('window-') || c.id.startsWith('source-'),
    );
    if (filterChips.length > 0) {
      body.appendChild(renderFilterSection(filterChips));
    }

    /* Scene & action chips (DARK FLIGHT, PLAY SCENE, FOCUS, CLEAR, modes) */
    const actionChips = descriptor.chips.filter(
      (c) => !c.id.startsWith('window-') && !c.id.startsWith('source-'),
    );
    if (actionChips.length > 0) {
      body.appendChild(renderActionSection(actionChips));
    }

    /* Legend */
    if (descriptor.legend && descriptor.legend.length > 0) {
      const legendSection = el('section', 'meteor-section meteor-legend', null);
      const legendGrid = el('div', 'meteor-legend-grid', legendSection);
      for (const item of descriptor.legend) {
        const row = el('div', 'meteor-legend-row', legendGrid);
        const swatch = el('span', 'meteor-legend-swatch', row);
        swatch.style.background = item.color;
        const label = el('span', 'meteor-legend-label', row);
        label.textContent = item.count != null
          ? `${item.label} ${item.count}`
          : item.label;
        if (item.blurb) label.title = item.blurb;
      }
      body.appendChild(legendSection);
    }

    /* Event list — open by default in browser mode; collapsible dropdown when an event is selected */
    if (descriptor.list) {
      const listSection = renderEventList(descriptor.list, !currentSelected);
      if (listSection) body.appendChild(listSection);
    }

    /* Info / Event summary */
    if (descriptor.info) {
      const infoSection = renderInfoSection(descriptor.info, descriptor.infoTitle);
      if (infoSection) body.appendChild(infoSection);
    }

    /* Dark flight section (if active or available in descriptor) */
    if (descriptor.darkFlight) {
      currentDarkFlight = descriptor.darkFlight;
      const dfSection = renderDarkFlightSection(descriptor.darkFlight);
      if (dfSection) body.appendChild(dfSection);
    }

    /* Found stones (editable) — shown when dark flight active with stones */
    if (descriptor.stoneFit?.comparisons) {
      currentStones = descriptor.stoneFit.comparisons;
      currentStoneFit = descriptor.stoneFit;
      const stonesSection = renderFoundStonesSection(descriptor.stoneFit.comparisons);
      if (stonesSection) body.appendChild(stonesSection);
    }

    /* Validation / sensor diagnostics */
    if (descriptor.validation) {
      currentValidation = descriptor.validation;
      const valSection = renderValidationSection(descriptor.validation);
      if (valSection) body.appendChild(valSection);
    }

    /* Mass cascade tracks */
    if (currentDarkFlight && currentDarkFlight.darkFlightTracks) {
      const mcSection = renderMassCascadeSection(currentDarkFlight);
      if (mcSection) body.appendChild(mcSection);
    }

    /* Update count badge */
    if (countBadge) {
      countBadge.textContent = String(descriptor.legend
        ? descriptor.legend.reduce((sum, l) => sum + (l.count || 0), 0)
        : currentListItems.length);
    }

    if (prevScrollTop > 0) {
      body.scrollTop = prevScrollTop;
    }

    /* Put the caret back where the operator left it. */
    if (focused) {
      const restored = [...body.querySelectorAll('input')].find(
        (node) =>
          node.className === focused.className &&
          (focused.stoneId
            ? node.dataset.stoneId === focused.stoneId
            : true) &&
          (focused.paramKey
            ? node.dataset.paramKey === focused.paramKey
            : true) &&
          (focused.field ? node.dataset.field === focused.field : true),
      );
      if (restored) {
        restored.focus();
        if (typeof focused.start === 'number') {
          try {
            restored.setSelectionRange(focused.start, focused.end);
          } catch {
            /* number inputs reject setSelectionRange; focus is enough. */
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Input event delegation                                             */
  /* ------------------------------------------------------------------ */
  body.addEventListener('click', (event) => {
    const shotChip = event.target?.closest?.('[data-screenshot-mode]');
    if (shotChip) {
      const mode = shotChip.dataset.screenshotMode;
      if (mode === 'viewport') {
        globalThis.window?.__gevScreenshot?.captureViewport?.({ openModal: true });
      } else if (mode === 'box') {
        const active = globalThis.window?.__gevScreenshot?.startBoxCapture?.();
        shotChip.classList.toggle('active', !!active);
      }
      return;
    }

    const chip = event.target?.closest?.('.data-chip');
    if (chip && !chip.disabled) {
      const params = JSON.parse(chip.dataset.params || '{}');
      setLayerParams('meteors', params, { origin: 'user' });
      return;
    }

    const eventLink = event.target?.closest?.('.meteor-event-link');
    if (eventLink) {
      const eventId = eventLink.dataset.eventId;
      if (eventId) {
        setLayerParams('meteors', { eventId, focus: true }, { origin: 'user' });
      }
      return;
    }

    const flyBtn = event.target?.closest?.('.meteor-stone-fly, .meteor-mc-fly');
    if (flyBtn) {
      const params = { flyToStone: true };
      if (flyBtn.dataset.stoneId) params.stoneId = flyBtn.dataset.stoneId;
      if (flyBtn.dataset.lat) params.lat = parseFloat(flyBtn.dataset.lat);
      if (flyBtn.dataset.lon) params.lon = parseFloat(flyBtn.dataset.lon);
      if (flyBtn.dataset.alt) params.alt = parseFloat(flyBtn.dataset.alt);
      setLayerParams('meteors', params, { origin: 'user' });
      return;
    }

    const addBtn = event.target?.closest?.('[data-action="addStone"]');
    if (addBtn) {
      setLayerParams('meteors', { addFoundStone: true }, { origin: 'user' });
      return;
    }

    const resetBtn = event.target?.closest?.('[data-action="resetStones"]');
    if (resetBtn) {
      setLayerParams('meteors', { resetFoundStones: true }, { origin: 'user' });
      return;
    }

    const delBtn = event.target?.closest?.('.meteor-stone-delete');
    if (delBtn) {
      setLayerParams('meteors', { removeStoneId: delBtn.dataset.stoneId }, { origin: 'user' });
      return;
    }
  });

  body.addEventListener('change', (event) => {
    const inputEl = event.target;
    if (!inputEl || !inputEl.classList.contains('meteor-stone-label-input')
        && !inputEl.classList.contains('meteor-stone-mass-input')
        && !inputEl.classList.contains('meteor-stone-lat-input')
        && !inputEl.classList.contains('meteor-stone-lon-input')
        && !inputEl.classList.contains('meteor-stone-type-input')
        && !inputEl.classList.contains('meteor-tuning-edit')) {
      return;
    }

    const stoneId = inputEl.dataset.stoneId;
    const field = inputEl.dataset.field;
    const paramKey = inputEl.dataset.paramKey;
    const rawValue = inputEl.value;

    if (stoneId && field) {
      /* The panel renders comparison wrappers ({ stone, errorM, ... }), but
         setCustomFoundStones expects a flat array of stone specs — pass the
         unwrapped stones or every entry fails validation and is dropped. */
      const updated = (currentStones || []).map((c) => {
        const stone = c.stone || c;
        const key = stone.id || stone.label;
        if (key !== stoneId) return { ...stone };
        const nextVal =
          field === 'massGrams' || field === 'lat' || field === 'lon' || field === 'latitude' || field === 'longitude'
            ? parseFloat(rawValue)
            : rawValue;
        const nextStone = {
          ...stone,
          [field]: nextVal,
        };
        if (field === 'lat' || field === 'latitude') {
          nextStone.lat = nextVal;
          nextStone.latitude = nextVal;
        } else if (field === 'lon' || field === 'longitude') {
          nextStone.lon = nextVal;
          nextStone.longitude = nextVal;
        }
        return nextStone;
      });
      setLayerParams('meteors', { setFoundStones: updated }, { origin: 'user' });
    } else if (paramKey) {
      const value = parseFloat(rawValue);
      if (!Number.isNaN(value)) {
        setLayerParams('meteors', { setCustomTuning: { [paramKey]: value } }, { origin: 'user' });
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Visibility control                                                */
  /* ------------------------------------------------------------------ */
  function setEnabled(enabled) {
    if (destroyed) return;
    const wasHidden = container.hidden;
    container.hidden = !enabled;
    if (enabled) {
      container.classList.add('panel-open');
      if (wasHidden) {
        container.classList.remove('layout-auto-collapsed');
        const collapseBtn = container.querySelector(
          '[data-collapse-target="meteor-panel"]',
        );
        if (collapseBtn) {
          if (!container.classList.contains('collapsed')) {
            container.classList.add('collapsed');
          }
          collapseBtn.click();
        } else {
          container.classList.remove('collapsed');
        }
      }
    } else {
      container.classList.remove('panel-open');
    }
  }

  function destroy() {
    destroyed = true;
    container?.remove?.();
  }

  return { sync, destroy, setEnabled };
}
