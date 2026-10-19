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
  const toggleSection = (header, bodyEl) => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    bodyEl.hidden = expanded;
  };

  /* ------------------------------------------------------------------ */
  /*  Section: Time & Source filters                                    */
  /* ------------------------------------------------------------------ */
  function renderFilterSection(chips) {
    const section = el('section', 'meteor-section meteor-filters', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-filters-body');
    el('span', 'meteor-section-title', header).textContent = t('Filters & Sources');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-filters-body';

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

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Scene & Action chips (shown when an event is selected)   */
  /* ------------------------------------------------------------------ */
  function renderActionSection(chips) {
    const section = el('section', 'meteor-section meteor-actions', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-actions-body');
    el('span', 'meteor-section-title', header).textContent = t('Scene & Actions');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-actions-body';

    for (const chip of chips) {
      if (chip.id.startsWith('window-') || chip.id.startsWith('source-')) continue;
      const b = btn(chip.label, `data-chip${chip.active ? ' active' : ''}`, chip.title);
      b.dataset.chipId = chip.id;
      b.disabled = !!chip.disabled;
      b.classList.toggle('busy', !!chip.busy);
      if (chip.params) b.dataset.params = JSON.stringify(chip.params);
      content.appendChild(b);
    }

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Event list (browser mode)                                */
  /* ------------------------------------------------------------------ */
  function renderEventList(list) {
    if (!list) return null;
    const section = el('section', 'meteor-section meteor-event-list', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-events-body');
    el('span', 'meteor-section-title', header).textContent = `${list.ariaLabel || t('Events')}`;
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-events-body';

    const ul = el('ul', 'meteor-event-list', content);
    for (const item of list.items || []) {
      const li = el('li', 'meteor-event-item', ul);
      li.dataset.eventId = item.id;
      const b = btn(item.text, 'meteor-event-link', null);
      b.dataset.eventId = item.id;
      b.classList.toggle('active', !!item.active);
      li.appendChild(b);
    }

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Selected event summary                                   */
  /* ------------------------------------------------------------------ */
  function renderInfoSection(infoText, infoTitle) {
    if (!infoText) return null;
    const section = el('section', 'meteor-section meteor-info', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-info-body');
    el('span', 'meteor-section-title', header).textContent = t('Event Summary');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-info-body';
    const pre = el('pre', 'meteor-info-text', content);
    pre.textContent = infoText;
    if (infoTitle) pre.title = infoTitle;

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Dark Flight diagnostics (shown when dark flight active)  */
  /* ------------------------------------------------------------------ */
  function renderDarkFlightSection(df) {
    if (!df) return null;
    const section = el('section', 'meteor-section meteor-dark-flight', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-df-body');
    el('span', 'meteor-section-title', header).textContent = t('Dark Flight Simulation');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-df-body';

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

    /* Auto-Fit tuning deltas */
    if (df.stoneFit?.tuning) {
      const sf = df.stoneFit;
      const tuning = sf.tuning;
      const summary = el('div', 'meteor-autofit-summary', content);
      el('span', 'meteor-autofit-label', summary).textContent = t('Auto-Fit Tuning');
      el('span', 'meteor-autofit-rms', summary).textContent = `RMS ${sf.baselineRmsM}m → ${sf.bestRmsM}m`;

      const tuneTable = el('table', 'meteor-param-table', content);
      const tuneTbody = el('tbody', null, tuneTable);
      const params = [
        { key: 'windScale', label: 'Wind Scale', unit: '×', editable: true },
        { key: 'shapeFactor', label: 'Shape Factor', unit: '', editable: true },
        { key: 'speedScale', label: 'Speed Scale', unit: '×', editable: true },
        { key: 'azimuthDeltaDeg', label: 'Azimuth Δ', unit: '°', editable: true },
        { key: 'upperFlareOffsetKm', label: 'Upper Flare Offset', unit: 'km', editable: true },
        { key: 'terminusShiftM', label: 'Terminus Shift', unit: 'm', editable: true },
      ];
      for (const p of params) {
        const tr = el('tr', null, tuneTbody);
        el('th', 'meteor-param-label', tr).textContent = p.label;
        const before = el('td', 'meteor-param-before', tr);
        before.textContent = (p.key === 'azimuthDeltaDeg' || p.key === 'terminusShiftM' || p.key === 'upperFlareOffsetKm')
          ? (p.key === 'upperFlareOffsetKm'
            ? (tuning.upperFlareOffsetKm > 0 ? `+${tuning.upperFlareOffsetKm}` : tuning.upperFlareOffsetKm) + ' km'
            : (tuning[p.key] >= 0 && p.key === 'azimuthDeltaDeg' ? '+' : '') + tuning[p.key] + (p.unit || ''))
          : (tuning[p.key] >= 0 ? tuning[p.key] : tuning[p.key]) + (p.unit || '');
        const after = el('td', 'meteor-param-after', tr);
        after.textContent = tuning[p.key] + (p.unit || '');
        if (p.editable) {
          const editor = input('number', `meteor-tuning-edit meteor-tuning-${p.key}`, null);
          editor.dataset.paramKey = p.key;
          editor.value = String(tuning[p.key]);
          editor.step = p.key.includes('Scale') ? '0.01' : '0.1';
          after.innerHTML = '';
          after.appendChild(editor);
        }
      }
    }

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Found Stones & Recovery Editor (editable)                 */
  /* ------------------------------------------------------------------ */
  function renderFoundStonesSection(comparisons) {
    const section = el('section', 'meteor-section meteor-found-stones', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-stones-body');
    el('span', 'meteor-section-title', header).textContent = t('Found Stones & Recovery');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-stones-body';

    const table = el('table', 'meteor-stone-table', content);
    const thead = el('thead', null, table);
    const headerTr = el('tr', null, thead);
    for (const h of ['Stone', 'Mass (g)', 'Latitude', 'Longitude', 'Type', 'Fragment', 'Actions']) {
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
      latInput.value = c.stone.latitude || '';
      latInput.step = '0.0001';
      latInput.dataset.stoneId = tr.dataset.stoneId;
      latInput.dataset.field = 'latitude';
      latCell.appendChild(latInput);

      const lonCell = el('td', null, tr);
      const lonInput = input('number', 'meteor-stone-lon-input', null);
      lonInput.value = c.stone.longitude || '';
      lonInput.step = '0.0001';
      lonInput.dataset.stoneId = tr.dataset.stoneId;
      lonInput.dataset.field = 'longitude';
      lonCell.appendChild(lonInput);

      const typeCell = el('td', null, tr);
      const typeInput = input('text', 'meteor-stone-type-input', null);
      typeInput.value = c.stone.type || '';
      typeInput.dataset.stoneId = tr.dataset.stoneId;
      typeInput.dataset.field = 'type';
      typeCell.appendChild(typeInput);

      const fragCell = el('td', null, tr);
      fragCell.textContent = c.fragmentationEpisode || '';

      const actionCell = el('td', 'meteor-stone-actions', tr);
      const flyBtn = btn('🛫', 'meteor-stone-fly', t('Fly to stone'));
      flyBtn.dataset.stoneId = tr.dataset.stoneId;
      flyBtn.title = t('Fly camera to this stone location');
      const delBtn = btn('🗑', 'meteor-stone-delete', t('Remove stone'));
      delBtn.dataset.stoneId = tr.dataset.stoneId;
      delBtn.title = t('Remove this found stone');
      actionCell.append(flyBtn, delBtn);

      const errorM = el('td', 'meteor-stone-error', tr);
      errorM.textContent = `Δ ${c.errorM}m`;
    }

    /* Add new stone row */
    if (currentSelected) {
      const addTr = el('tr', 'meteor-stone-add-row', tbody);
      const addCell = el('td', null, addTr);
      addCell.colSpan = 8;
      const addBtn = btn('＋ Add Found Stone', 'meteor-stone-add-btn', t('Add a new found stone at the cursor location'));
      addBtn.dataset.action = 'addStone';
      addCell.appendChild(addBtn);
    }

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Sensor diagnostics                                         */
  /* ------------------------------------------------------------------ */
  function renderValidationSection(val) {
    if (!val) return null;
    const section = el('section', 'meteor-section meteor-validation', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-val-body');
    el('span', 'meteor-section-title', header).textContent = t('Sensor Diagnostics');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-val-body';

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
    if (Array.isArray(val.sanityWarnings) && val.sanityWarnings.length > 0) {
      lines.push(`🔍 Sanity Checks: ${val.sanityWarnings.join(' | ')}`);
    }

    pre.textContent = lines.join('\n');

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Section: Mass cascades (dark flight fragment trajectories)         */
  /* ------------------------------------------------------------------ */
  function renderMassCascadeSection(df) {
    if (!df || !df.darkFlightTracks) return null;
    const section = el('section', 'meteor-section meteor-masscascade', null);
    const header = el('button', 'meteor-section-header', section);
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('aria-controls', 'meteor-mc-body');
    el('span', 'meteor-section-title', header).textContent = t('Mass Cascade Tracks');
    el('span', 'meteor-section-chevron', header).textContent = '▼';
    const content = el('div', 'meteor-section-body', section);
    content.id = 'meteor-mc-body';

    const table = el('table', 'meteor-param-table', content);
    const thead = el('thead', null, table);
    const hdrTr = el('tr', null, thead);
    for (const h of ['Episode', 'Mass (g)', 'Release Alt (km)', 'Landing (lat, lon)']) {
      el('th', null, hdrTr).textContent = h;
    }
    const tbody = el('tbody', null, table);
    const tracks = df.darkFlightTracks || [];
    for (const tk of tracks) {
      const tr = el('tr', null, tbody);
      el('td', null, tr).textContent = tk.episode || 'n/a';
      el('td', null, tr).textContent = tk.massGrams || '';
      el('td', null, tr).textContent = tk.releaseAltKm || '';
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

    header.addEventListener('click', () => {
      toggleSection(header, content);
    });
    return section;
  }

  /* ------------------------------------------------------------------ */
  /*  Main sync — builds or rebuilds the entire panel body               */
  /* ------------------------------------------------------------------ */
  function sync(descriptor) {
    if (destroyed || !descriptor) return;
    currentDescriptor = descriptor;
    currentChipsById = new Map((descriptor.chips || []).map((c) => [c.id, c]));
    currentListItems = descriptor.list?.items || [];

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

    /* Event list — shown when no event is selected */
    if (!currentSelected && descriptor.list) {
      const listSection = renderEventList(descriptor.list);
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
  }

  /* ------------------------------------------------------------------ */
  /*  Input event delegation                                             */
  /* ------------------------------------------------------------------ */
  body.addEventListener('click', (event) => {
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
      /* Collect all stone edits and dispatch as one setFoundStones call */
      const updated = (currentStones || []).map((c) => {
        if ((c.stone.id || c.stone.label) === stoneId) {
          return {
            ...c,
            stone: {
              ...c.stone,
              [field]: field === 'massGrams' ? parseFloat(rawValue) : rawValue,
            },
          };
        }
        return c;
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
    container.hidden = !enabled;
    if (enabled && !container.classList.contains('panel-open')) {
      container.classList.add('panel-open');
    } else if (!enabled) {
      container.classList.remove('panel-open');
    }
  }

  function destroy() {
    destroyed = true;
    container?.remove?.();
  }

  return { sync, destroy, setEnabled };
}
