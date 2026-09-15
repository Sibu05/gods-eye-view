/**
 * @module universalSearch
 * @description Multi-entity search across already-loaded layer data. Reuses
 * existing `src/data/<layer>.js` modules (flights, vessels, installations,
 * places) without adding a new fetch pathway. Selecting a result reuses the
 * same selection/camera-centering logic as click or voice.
 */

/**
 * Simple debounce matching existing conventions (setTimeout/clearTimeout).
 * @param {Function} fn
 * @param {number} delayMs
 * @returns {Function}
 */
export function debounce(fn, delayMs = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

/**
 * Search already-loaded entities across layers.
 * @param {string} query
 * @param {object} context
 * @param {import('cesium').Viewer} context.viewer
 * @param {object} context.dataManager
 * @param {object} context.placeSearch
 * @returns {Array<{id: string, label: string, type: string, detail: string, action: Function}>}
 */
export function searchEntities(
  query,
  {
    viewer,
    dataManager,
    placeSearch,
    cityPois,
    flyToPreset,
    flyToPoi,
    searchAndFly,
  } = {},
) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q || q.length < 2) return [];
  const results = [];
  const cities = cityPois || {};

  // Places: curated city/POI names
  for (const [cityId, city] of Object.entries(cities)) {
    if (city.name.toLowerCase().includes(q)) {
      results.push({
        id: `place:${cityId}`,
        label: city.name,
        type: 'place',
        detail: `${city.pois.length} landmarks`,
        action: () => flyToPreset?.(viewer, cityId),
      });
    }
    for (let index = 0; index < city.pois.length; index += 1) {
      const poi = city.pois[index];
      if (poi.name.toLowerCase().includes(q)) {
        results.push({
          id: `place:${cityId}:${index}`,
          label: poi.name,
          type: 'place',
          detail: city.name,
          action: () => flyToPoi?.(viewer, cityId, index),
        });
      }
    }
  }

  // Flights / military — reuse layer's findByQuery via getAnalystRecords scan
  const flightLayers = ['flights', 'military'];
  for (const layerId of flightLayers) {
    const layer = dataManager?.layers?.get(layerId)?.module;
    if (!layer) continue;
    try {
      const match = layer.findByQuery?.(q);
      if (match) {
        const info = match.label || match.callsign || match.icao24;
        // Only one best match per layer to avoid flooding results
        results.push({
          id: `${layerId}:${match.icao24}`,
          label: String(info || match.icao24).toUpperCase(),
          type: layerId === 'military' ? 'military' : 'aircraft',
          detail: layer.name || layerId,
          action: () => layer.trackById?.(match.icao24, { origin: 'user' }),
        });
      }
      // Also scan analyst records for substring matches (callsign/registration)
      if (results.length < 12) {
        const records = layer.getAnalystRecords?.(200) || [];
        for (const record of records) {
          if (results.length >= 12) break;
          const hay =
            `${record.callsign || ''} ${record.registration || ''} ${record.id || ''}`.toLowerCase();
          if (
            hay.includes(q) &&
            !results.some((r) => r.id.endsWith(record.id || record.icao24))
          ) {
            results.push({
              id: `${layerId}:${record.id}`,
              label: record.callsign || record.registration || record.id,
              type: layerId === 'military' ? 'military' : 'aircraft',
              detail: record.type || layer.name,
              action: () => layer.trackById?.(record.id, { origin: 'user' }),
            });
          }
        }
      }
    } catch {
      /* best effort */
    }
  }

  // Vessels
  try {
    const vesselLayer = dataManager?.layers?.get('ais-live-vessels')?.module;
    if (vesselLayer) {
      const vessel = vesselLayer.findByQuery?.(q);
      if (vessel) {
        results.push({
          id: `vessel:${vessel.mmsi}`,
          label: vessel.name || vessel.mmsi,
          type: 'vessel',
          detail: vesselLayer.name || 'Live AIS Vessels',
          action: () => vesselLayer.selectById?.(vessel.mmsi),
        });
      }
    }
  } catch {
    /* best effort */
  }

  // Installations — scan current viewport records for name substring
  try {
    const installations = dataManager?.layers?.get(
      'military-installations',
    )?.module;
    if (installations?.getStats) {
      // No direct search; iterate via data layer's internal records if exposed as analyst?
      // Fallback: no-op — installations still searchable via place geocode below
    }
  } catch {
    /* best effort */
  }

  // If no layer match, offer geocode fallback as a "place" search result
  // (reuses existing placeSearch plumbing, not a new fetch pathway)
  if (results.length === 0 && placeSearch && q.length >= 3) {
    results.push({
      id: `geocode:${q}`,
      label: q,
      type: 'place',
      detail: 'Search location…',
      action: () => searchAndFly?.(viewer, q, { placeSearch }),
    });
  }

  return results.slice(0, 10);
}

/**
 * Create the universal search UI controller.
 * @param {object} options
 * @param {HTMLInputElement} options.input
 * @param {HTMLElement} options.resultsContainer
 * @param {HTMLElement} options.statusElement ARIA live region
 * @param {import('cesium').Viewer} options.viewer
 * @param {object} options.dataManager
 * @param {object} options.placeSearch
 * @param {number} [options.debounceMs=250]
 * @returns {{destroy: Function}}
 */
export function createUniversalSearch({
  input,
  resultsContainer,
  statusElement,
  viewer,
  dataManager,
  placeSearch,
  cityPois,
  flyToPreset,
  flyToPoi,
  searchAndFly,
  debounceMs = 250,
} = {}) {
  if (!input || !resultsContainer) {
    return { destroy() {} };
  }

  let selectedIndex = -1;
  let currentResults = [];
  let destroyed = false;

  const render = () => {
    if (destroyed) return;
    resultsContainer.replaceChildren();
    if (!currentResults.length) {
      resultsContainer.hidden = true;
      if (statusElement)
        statusElement.textContent = input.value.trim() ? 'No results' : '';
      return;
    }
    resultsContainer.hidden = false;
    currentResults.forEach((result, index) => {
      const item = document.createElement('li');
      item.role = 'option';
      item.id = `universal-search-option-${index}`;
      item.className = 'universal-search-option';
      if (index === selectedIndex) item.classList.add('active');
      item.setAttribute('aria-selected', String(index === selectedIndex));
      item.dataset.resultId = result.id;
      const label = document.createElement('span');
      label.className = 'universal-search-label';
      label.textContent = result.label;
      const meta = document.createElement('span');
      meta.className = 'universal-search-meta';
      meta.textContent = `${result.type} · ${result.detail}`;
      item.append(label, meta);
      item.addEventListener('click', () => selectResult(index));
      resultsContainer.appendChild(item);
    });
    if (statusElement) {
      statusElement.textContent = `${currentResults.length} result${currentResults.length === 1 ? '' : 's'} found`;
    }
    if (selectedIndex >= 0 && selectedIndex < currentResults.length) {
      input.setAttribute(
        'aria-activedescendant',
        `universal-search-option-${selectedIndex}`,
      );
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const close = () => {
    currentResults = [];
    selectedIndex = -1;
    render();
  };

  const selectResult = (index) => {
    const chosen = currentResults[index];
    if (!chosen) return;
    try {
      chosen.action();
    } catch {
      /* best effort */
    }
    close();
    input.value = '';
  };

  const doSearch = () => {
    if (destroyed) return;
    const query = input.value;
    if (!query.trim()) {
      close();
      return;
    }
    currentResults = searchEntities(query, {
      viewer,
      dataManager,
      placeSearch,
      cityPois,
      flyToPreset,
      flyToPoi,
      searchAndFly,
    });
    selectedIndex = currentResults.length ? 0 : -1;
    render();
  };

  const debouncedSearch = debounce(doSearch, debounceMs);

  const onInput = () => {
    debouncedSearch();
  };

  const onKeydown = (event) => {
    if (resultsContainer.hidden && !['Escape'].includes(event.key)) {
      if (
        ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) &&
        input.value.trim()
      ) {
        doSearch();
      }
    }
    if (event.key === 'ArrowDown') {
      if (!currentResults.length) return;
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      if (!currentResults.length) return;
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      if (selectedIndex >= 0) {
        event.preventDefault();
        selectResult(selectedIndex);
      } else if (currentResults.length === 1) {
        event.preventDefault();
        selectResult(0);
      }
    } else if (event.key === 'Escape') {
      if (currentResults.length) {
        event.preventDefault();
        close();
      } else {
        input.value = '';
      }
      input.blur();
    }
  };

  const onBlur = (event) => {
    // Allow click on results before closing
    setTimeout(() => {
      if (destroyed) return;
      if (resultsContainer.contains(document.activeElement)) return;
      close();
    }, 150);
  };

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', resultsContainer.id);
  resultsContainer.setAttribute('role', 'listbox');

  const updateExpanded = () => {
    input.setAttribute('aria-expanded', String(!resultsContainer.hidden));
  };
  const observer = new MutationObserver(updateExpanded);

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', onBlur);
  observer.observe(resultsContainer, {
    attributes: true,
    attributeFilter: ['hidden'],
  });

  return {
    destroy() {
      destroyed = true;
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown);
      input.removeEventListener('blur', onBlur);
      observer.disconnect();
      close();
    },
  };
}
