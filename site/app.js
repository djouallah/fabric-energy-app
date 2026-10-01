    import { createAuth } from './auth.js';
    import { createDataSource } from './data.js';

    // =========================================================================
    // 1. CONSTANTS & THEME
    // =========================================================================

    const darkTheme = {
      backgroundColor: 'transparent',
      textStyle: { color: '#8b949e' },
      title: { textStyle: { color: '#e1e4e8' } },
      legend: { textStyle: { color: '#8b949e' }, pageTextStyle: { color: '#8b949e' } },
      tooltip: {
        backgroundColor: 'rgba(22,27,34,0.95)',
        borderColor: '#30363d',
        textStyle: { color: '#e1e4e8', fontSize: 12 },
      },
      categoryAxis: { axisLine: { lineStyle: { color: '#30363d' } }, axisTick: { lineStyle: { color: '#30363d' } }, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
      valueAxis: { axisLine: { lineStyle: { color: '#30363d' } }, axisTick: { lineStyle: { color: '#30363d' } }, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
      timeAxis: { axisLine: { lineStyle: { color: '#30363d' } }, axisTick: { lineStyle: { color: '#30363d' } }, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
    };
    echarts.registerTheme('dark-custom', darkTheme);

    const PALETTE = ['#58a6ff','#f0883e','#3fb950','#bc8cff','#f778ba','#d29922','#79c0ff','#56d364','#db6d28','#ff7b72','#7ee787','#a5d6ff'];
    const FUEL_COLORS = {
      'Black coal': '#444444',
      'Brown coal': '#8B4513',
      'Natural gas': '#f0883e',
      'Natural gas / fuel oil': '#d29922',
      'Natural gas / diesel': '#db6d28',
      'Coal seam methane': '#6b4c2a',
      'Wind': '#58a6ff',
      'Solar': '#f7c948',
      'Water': '#3fb950',
      'Bagasse': '#7ee787',
      'Diesel': '#ff7b72',
      'Kerosene': '#f778ba',
      'Waste coal mine gas': '#888888',
      'Grid': '#bc8cff',
      'Other': '#aaaaaa',
      '-': '#aaaaaa',
    };
    function fuelColor(name) { return FUEL_COLORS[name] || PALETTE[Math.abs([...name].reduce((h,c)=>h*31+c.charCodeAt(0)|0,0)) % PALETTE.length]; }

    // =========================================================================
    // 2. STATE & DOM UTILITIES
    // =========================================================================

    function setStatus(msg, type = "loading") {
      document.getElementById("statusText").textContent = msg;
      document.getElementById("status").className = type;
    }

    const crossFilter = { fuel: null, region: null, duids: [] };
    let _renderSeq = 0;

    function updateFilterTags() {
      const el = document.getElementById("activeFilters");
      el.innerHTML = "";
      if (crossFilter.fuel) {
        const tag = document.createElement("span");
        tag.className = "filter-tag";
        tag.textContent = crossFilter.fuel;
        tag.addEventListener("click", () => { crossFilter.fuel = null; renderAll(); });
        el.append(tag);
      }
      if (crossFilter.region) {
        const tag = document.createElement("span");
        tag.className = "filter-tag";
        tag.textContent = crossFilter.region;
        tag.addEventListener("click", () => { crossFilter.region = null; renderAll(); });
        el.append(tag);
      }
      for (const duid of crossFilter.duids) {
        const tag = document.createElement("span");
        tag.className = "filter-tag";
        tag.textContent = duid;
        tag.addEventListener("click", () => { crossFilter.duids = crossFilter.duids.filter(d => d !== duid); updateDuidTrigger(); renderAll(); });
        el.append(tag);
      }
    }

    // =========================================================================
    // 3. DUCKDB SETUP
    // =========================================================================

    let conn;

    // Chart grain control — change this one value to tune intraday vs daily:
    //   'today'  -> 5-min intraday only when viewing today; daily for any other range
    //   <number> -> 5-min intraday when the range spans <= N days (e.g. 7 or 30); daily beyond
    const INTRADAY_GRAIN = 'today';

    let _db = null;

    const _queryCache = new Map();
    function clearQueryCache() { _queryCache.clear(); }

    // opts.noCache: skip the result cache. Required for the render path — base scans write a
    // mutable TEMP TABLE and the chart queries over it have filter-invariant SQL, so a cached
    // result keyed on that constant string would survive a filter change and serve stale rows.
    // Remote-attached data (rayfin): make sure the SAS in the attached URL is current, and on a
    // failed read (HTTP 403 = expired SAS) re-attach once and retry.
    async function queryDb(c, sqlStr) {
      await data.ensureFresh();
      try { return await c.query(sqlStr); }
      catch (e) {
        if (!/\b403\b|HTTP/i.test(String(e?.message))) throw e;
        await data.ensureFresh(true);
        return c.query(sqlStr);
      }
    }

    async function runQuery(sqlStr, opts = {}) {
      if (!opts.noCache) {
        const cached = _queryCache.get(sqlStr);
        if (cached) return cached;
      }
      const result = await queryDb(conn, sqlStr);
      const numRows = Number(result.numRows);
      const fields = result.schema.fields;
      const columns = fields.map(f => {
        const col = result.getChild(f.name);
        const arr = col.toArray();
        if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
          return Array.from(arr, v => Number(v));
        }
        return arr;
      });
      const rows = new Array(numRows);
      for (let i = 0; i < numRows; i++) {
        const row = {};
        for (let j = 0; j < fields.length; j++) {
          row[fields[j].name] = columns[j][i];
        }
        rows[i] = row;
      }
      _queryCache.set(sqlStr, rows);
      return rows;
    }

    // =========================================================================
    // 4. HELPERS
    // =========================================================================

    // Grain: 5-min intraday ONLY when viewing today (single current day, browser-local date);
    // every other range uses inline daily aggregations on fct⋈dim.
    function getDateRange() {
      return { from: document.getElementById("dateFrom").value, to: document.getElementById("dateTo").value };
    }
    function rangeDays() {
      const { from, to } = getDateRange();
      return Math.round((new Date(to) - new Date(from)) / 86400000);
    }
    function isIntradayMode() {
      if (INTRADAY_GRAIN === 'today') {
        const { from, to } = getDateRange();
        const today = new Date().toLocaleDateString('en-CA');
        return from === today && to === today;
      }
      return rangeDays() <= Number(INTRADAY_GRAIN);
    }

    function padTime(time) { return String(time).padStart(4, '0'); }

    function formatTime(time) {
      const hh = String(Math.floor(time / 100)).padStart(2, '0');
      const mm = String(time % 100).padStart(2, '0');
      return `${hh}:${mm}`;
    }

    function formatDate(str) {
      const [y, m, d] = str.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
    }

    function buildTimeAxis(rows, timeDetail) {
      if (timeDetail) {
        const xKeys = [...new Set(rows.map(d => `${d.date}|${padTime(d.time)}`))].sort();
        const xLabels = xKeys.map(k => {
          const [dt, tm] = k.split('|');
          return formatDate(dt) + ' ' + formatTime(parseInt(tm));
        });
        return { xKeys, xLabels };
      }
      const xKeys = [...new Set(rows.map(d => d.date))].sort();
      const xLabels = xKeys.map(d => formatDate(d));
      return { xKeys, xLabels };
    }

    function buildLookup(rows, keyFn, valueFn) {
      const lookup = new Map();
      for (const row of rows) lookup.set(keyFn(row), valueFn(row));
      return lookup;
    }

    function dataZoomConfig(timeDetail) {
      return timeDetail
        ? [{ type: 'inside', start: 0, end: 100 }, { type: 'slider', start: 0, end: 100, height: 20, bottom: 35 }]
        : [];
    }

    function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

    async function downloadCSVDirect(sqlStr, filename) {
      const exportConn = await _db.connect();
      try {
        await data.ensureFresh();
        const reader = await exportConn.send(sqlStr);
        const chunks = [];
        let headerWritten = false;
        let rowCount = 0;
        for await (const batch of reader) {
          const cols = batch.schema.fields.map(f => f.name);
          let chunk = '';
          if (!headerWritten) {
            chunk += cols.join(',') + '\n';
            headerWritten = true;
          }
          const n = Number(batch.numRows);
          for (let i = 0; i < n; i++) {
            const vals = cols.map(c => {
              let v = batch.getChild(c).get(i);
              if (typeof v === 'bigint') v = Number(v);
              return v ?? '';
            });
            chunk += vals.join(',') + '\n';
          }
          chunks.push(chunk);
          rowCount += n;
          await yieldToUI();
        }
        const blob = new Blob(chunks, { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return rowCount;
      } finally {
        await exportConn.close();
      }
    }

    // =========================================================================
    // 5. SQL QUERY BUILDERS
    // =========================================================================

    // fct_summary joined to its dimension, inlined (replaces the old v_model VIEW). Use this only
    // where a query needs dim columns (Region / FuelSourceDescriptor / latitude / longitude);
    // fact-only queries should hit db.fct_summary directly to skip the join.
    const VMODEL = `(SELECT f.DUID, f.date, f.time, f.mw, f.price, f.cutoff,
                            d.Region, d.FuelSourceDescriptor, d.latitude, d.longitude
                     FROM db.fct_summary f JOIN db.dim_duid d ON f.DUID = d.DUID)`;

    const sql = {
      // --- WHERE clauses ---
      whereScada() {
        const region = document.getElementById("regionFilter").value || crossFilter.region;
        const fuel = document.getElementById("fuelFilter").value || crossFilter.fuel;
        const { from, to } = getDateRange();
        const clauses = [`sc.date >= '${from}' AND sc.date <= '${to}'`];
        if (region) clauses.push(`sc.Region = '${region}'`);
        if (fuel) clauses.push(`sc.FuelSourceDescriptor = '${fuel}'`);
        if (crossFilter.duids.length) clauses.push(`sc.DUID IN (${crossFilter.duids.map(d => `'${d}'`).join(',')})`);
        return clauses.join(" AND ");
      },

      wherePrice() {
        const region = document.getElementById("regionFilter").value || crossFilter.region;
        const { from, to } = getDateRange();
        const clauses = [`p.date >= '${from}' AND p.date <= '${to}'`];
        if (region) clauses.push(`p.Region = '${region}'`);
        if (!region && (crossFilter.duids.length || crossFilter.fuel)) {
          const fuel = document.getElementById("fuelFilter").value || crossFilter.fuel;
          let regionFilter;
          if (crossFilter.duids.length) {
            regionFilter = `p.Region IN (SELECT DISTINCT Region FROM db.dim_duid WHERE DUID IN (${crossFilter.duids.map(d => `'${d}'`).join(',')}))`;
          } else if (fuel) {
            regionFilter = `p.Region IN (SELECT DISTINCT Region FROM db.dim_duid WHERE FuelSourceDescriptor = '${fuel}')`;
          }
          if (regionFilter) clauses.push(regionFilter);
        }
        return clauses.join(" AND ");
      },

      // --- Formula-engine predicates over _base (unprefixed base columns) ---
      // _base is materialized for a date range only (§4.1 of docs/query-engine-spec.md); the
      // selected date subset + cross-filters (region/fuel/DUID) are applied HERE as WHERE preds,
      // so a drill/narrow is a re-aggregation of the existing base — no fact re-scan — and the
      // query string stays filter-specific so the visual cache keys correctly.
      genWhere() {
        const region = document.getElementById("regionFilter").value || crossFilter.region;
        const fuel = document.getElementById("fuelFilter").value || crossFilter.fuel;
        const { from, to } = getDateRange();
        const clauses = [`date >= '${from}' AND date <= '${to}'`];
        if (region) clauses.push(`Region = '${region}'`);
        if (fuel) clauses.push(`fuel = '${fuel}'`);
        if (crossFilter.duids.length) clauses.push(`DUID IN (${crossFilter.duids.map(d => `'${d}'`).join(',')})`);
        return clauses.join(" AND ");
      },

      // Price widens to whole regions: a fuel/DUID cross-filter with no explicit region shows price
      // for every region containing that fuel/DUID (mirrors the old wherePrice over the full base).
      priceWhere() {
        const region = document.getElementById("regionFilter").value || crossFilter.region;
        const { from, to } = getDateRange();
        const clauses = [`date >= '${from}' AND date <= '${to}'`];
        if (region) {
          clauses.push(`Region = '${region}'`);
        } else if (crossFilter.duids.length) {
          clauses.push(`Region IN (SELECT DISTINCT Region FROM db.dim_duid WHERE DUID IN (${crossFilter.duids.map(d => `'${d}'`).join(',')}))`);
        } else {
          const fuel = document.getElementById("fuelFilter").value || crossFilter.fuel;
          if (fuel) clauses.push(`Region IN (SELECT DISTINCT Region FROM db.dim_duid WHERE FuelSourceDescriptor = '${fuel}')`);
        }
        return clauses.join(" AND ");
      },

      // --- Filter population ---
      regions: "SELECT DISTINCT Region FROM db.dim_duid WHERE Region IS NOT NULL AND Region != 'WA1' ORDER BY Region",
      fuels: "SELECT DISTINCT FuelSourceDescriptor AS fuel FROM db.dim_duid WHERE FuelSourceDescriptor IS NOT NULL ORDER BY fuel",
      allDuids: "SELECT DUID, Region, FuelSourceDescriptor AS fuel FROM db.dim_duid WHERE DUID IS NOT NULL ORDER BY DUID",

      // --- Generation chart (formula engine: re-aggregates _base) ---
      // valCol is 'mw' (intraday) or 'mwh' (daily); seriesCol/seriesAlias are 'fuel' or 'DUID'.
      generation(seriesAlias, seriesCol, valCol, intraday) {
        if (intraday) {
          return `
            SELECT CAST(date AS VARCHAR) AS date, CAST(time AS INTEGER) AS time, ${seriesAlias}, SUM(${valCol})::DOUBLE AS total_mw, CAST(COUNT(*) AS INTEGER) AS row_cnt
            FROM _base
            WHERE ${sql.genWhere()}
            GROUP BY date, time, ${seriesCol}
            ORDER BY date, time`;
        }
        return `
          SELECT CAST(date AS VARCHAR) AS date, ${seriesAlias}, SUM(${valCol})::DOUBLE AS total_mw, CAST(COUNT(*) AS INTEGER) AS row_cnt
          FROM _base
          WHERE ${sql.genWhere()}
          GROUP BY date, ${seriesCol}
          ORDER BY date`;
      },

      // --- Price chart (formula engine: re-aggregates _base) ---
      // Region avg = SUM(price_sum)/SUM(price_cnt) — the EXACT flat AVG(price), not a two-stage
      // mean (§4.1 of docs/query-engine-spec.md).
      price(intraday) {
        if (intraday) {
          return `
            SELECT CAST(date AS VARCHAR) AS date, CAST(time AS INTEGER) AS time, Region, (SUM(price_sum)/SUM(price_cnt))::DOUBLE AS avg_price
            FROM _base
            WHERE ${sql.priceWhere()}
            GROUP BY date, time, Region
            ORDER BY date, time`;
        }
        return `
          SELECT CAST(date AS VARCHAR) AS date, Region, (SUM(price_sum)/SUM(price_cnt))::DOUBLE AS avg_price
          FROM _base
          WHERE ${sql.priceWhere()}
          GROUP BY date, Region
          ORDER BY date`;
      },

      // --- Map (formula engine: re-aggregates _base) ---
      // col is 'mw' (intraday) or 'mwh' (daily).
      mapScatter(col) {
        return `
          SELECT DUID, fuel, Region, lat::DOUBLE AS lat, lon::DOUBLE AS lon,
            AVG(${col})::DOUBLE AS mw
          FROM _base
          WHERE lat IS NOT NULL AND ${sql.genWhere()}
          GROUP BY DUID, fuel, Region, lat, lon`;
      },

      // COUNT(DISTINCT DUID) is invariant to the base's rollup grain, so count over _base.
      generatorCount() {
        return `SELECT CAST(COUNT(DISTINCT DUID) AS INTEGER) AS cnt FROM _base WHERE ${sql.genWhere()}`;
      },

      // --- Cutoff timestamp ---
      // Data-freshness ts from the fact's own `cutoff` column. Shown verbatim as stored — no
      // timezone conversion anywhere.
      cutoff: "SELECT CAST(MAX(cutoff) AS VARCHAR) AS last_update FROM db.fct_summary",
    };

    // --- Storage engine: materialize the ONE shared base scan (see docs/query-engine-spec.md) ---
    // The single place the fact is touched. ONE shared `_base` table (regular, not TEMP, so the
    // CSV-export connection sees it too — temp tables are connection-scoped), filtered by the DATE
    // RANGE ONLY (never by fuel/region/DUID — those are slicers applied in the formula engine). Carries
    // mwh|mw plus price_sum/price_cnt so the region price re-aggregates EXACTLY (§4.1). Every
    // chart/KPI then re-aggregates `_base`; a drill/narrow does zero fact scans.
    //
    // Containment (§5): `_base` is keyed on the range it was built for (`_baseRange`). A selection
    // that is a SUBSET of, or EQUAL to, that range (at the same grain) reuses the existing scan —
    // the FE just adds a date predicate. Only a selection that extends BEYOND it re-scans. So
    // year → a month inside it keeps the scan; only widening the range pays a new scan.
    let _baseRange = null;   // { from, to, intraday } the current _base was materialized for

    async function materializeBase() {
      const intraday = isIntradayMode();
      const { from, to } = getDateRange();
      // Reuse when the existing base covers the selection at the same grain (ISO dates compare lexically).
      if (_baseRange && _baseRange.intraday === intraday &&
          from >= _baseRange.from && to <= _baseRange.to) return;

      const time = intraday ? 'f.time,' : '';
      const val = intraday ? 'SUM(f.mw)::DOUBLE AS mw' : 'CAST(SUM(f.mw)/12.0 AS REAL) AS mwh';
      const grp = intraday ? 'f.DUID, f.date, f.time' : 'f.DUID, f.date';
      // noCache: a side-effecting DDL that must run when called; the containment guard above is
      // what prevents redundant rebuilds (caching its empty result would be a staleness hazard).
      await runQuery(`
        CREATE OR REPLACE TABLE _base AS
        SELECT f.DUID, f.date, ${time} d.Region, d.FuelSourceDescriptor AS fuel,
               d.latitude AS lat, d.longitude AS lon,
               ${val},
               SUM(f.price) AS price_sum, COUNT(f.price) AS price_cnt
        FROM db.fct_summary f JOIN db.dim_duid d ON f.DUID = d.DUID
        WHERE f.date >= '${from}' AND f.date <= '${to}'
        GROUP BY ${grp}, d.Region, d.FuelSourceDescriptor, d.latitude, d.longitude`,
        { noCache: true });
      _baseRange = { from, to, intraday };
    }

    // =========================================================================
    // 6. CHART RENDERERS
    // =========================================================================

    const charts = {};
    function getChart(id) {
      if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), 'dark-custom');
      return charts[id];
    }
    window.addEventListener('resize', () => { Object.values(charts).forEach(c => c.resize()); });

    // --- Generation by Fuel Type (stacked area) ---
    async function renderGeneration(seq) {
      const intraday = isIntradayMode();
      const unit = intraday ? 'MW' : 'MWh';
      const drillFuel = crossFilter.fuel;

      document.getElementById("title-generation").textContent = drillFuel
        ? `${drillFuel} by DUID (${unit})`
        : `Generation by Fuel Type (${unit})`;

      const valCol = intraday ? 'mw' : 'mwh';
      const seriesCol = drillFuel ? 'DUID' : 'fuel';
      const seriesAlias = drillFuel ? 'DUID AS series' : 'fuel AS series';

      const data = await runQuery(sql.generation(seriesAlias, seriesCol, valCol, intraday));
      if (seq !== _renderSeq || !data.length) return;

      const { xKeys, xLabels } = buildTimeAxis(data, intraday);
      const lookup = buildLookup(data,
        row => intraday ? `${row.date}|${padTime(row.time)}|${row.series}` : `${row.date}|${row.series}`,
        row => row.total_mw
      );

      // Sort series by total descending, limit to top 15 in drill mode
      const seriesTotals = {};
      for (const row of data) seriesTotals[row.series] = (seriesTotals[row.series] || 0) + row.total_mw;
      let seriesNames = Object.entries(seriesTotals).sort((a, b) => b[1] - a[1]).map(e => e[0]);
      if (drillFuel && seriesNames.length > 15) seriesNames = seriesNames.slice(0, 15);

      const largeMode = xKeys.length > 2000;
      const series = seriesNames.map((name, i) => ({
        name,
        type: 'line',
        stack: 'total',
        areaStyle: { opacity: 0.85 },
        lineStyle: { width: 0 },
        symbol: 'none',
        emphasis: { focus: 'series' },
        triggerLineEvent: true,
        sampling: 'lttb',
        large: largeMode,
        progressive: largeMode ? 500 : 0,
        itemStyle: { color: drillFuel ? PALETTE[i % PALETTE.length] : fuelColor(name) },
        data: xKeys.map(k => lookup.get(`${k}|${name}`) || 0),
      }));

      let hoveredSeries = '';
      const chart = getChart('chart-generation');
      chart.off('mouseover'); chart.off('mouseout');
      chart.on('mouseover', p => { if (p.seriesName) hoveredSeries = p.seriesName; });
      chart.on('mouseout', () => { hoveredSeries = ''; });
      chart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: params => {
          const target = hoveredSeries ? params.find(p => p.seriesName === hoveredSeries) : null;
          const p = target || params.filter(p => p.value > 0).sort((a, b) => b.value - a.value)[0];
          if (!p) return '';
          return `<div style="color:#8b949e;margin-bottom:2px">${params[0].axisValueLabel}</div><div style="font-weight:600">${p.marker} ${p.seriesName}: ${Math.round(p.value).toLocaleString()} ${unit}</div>`;
        }},
        legend: { type: 'scroll', top: 0, icon: 'none', itemGap: 12, selectedMode: false, data: seriesNames.map((name, i) => ({ name, textStyle: { color: drillFuel ? PALETTE[i % PALETTE.length] : fuelColor(name), fontSize: 11 } })) },
        grid: { left: 60, right: 20, top: 35, bottom: 25 },
        xAxis: { type: 'category', data: xLabels, boundaryGap: false, axisLabel: { rotate: intraday ? 45 : 0, fontSize: intraday ? 10 : 12 } },
        yAxis: { type: 'value', min: 0, name: unit, nameTextStyle: { color: '#8b949e', fontSize: 11 }, axisLabel: { formatter: v => v >= 1000 ? (v/1000).toFixed(0) + 'k' : v } },
        dataZoom: dataZoomConfig(intraday),
        series,
        animationDuration: 600,
        animationEasing: 'cubicOut',
      }, true);

      // Click: fuel view -> drill into fuel; DUID view -> select DUID
      chart.off('click');
      chart.on('click', (params) => {
        if (!params.seriesName) return;
        if (drillFuel) {
          const duid = params.seriesName;
          const idx = crossFilter.duids.indexOf(duid);
          if (idx >= 0) crossFilter.duids.splice(idx, 1);
          else crossFilter.duids.push(duid);
          updateDuidTrigger();
        } else {
          crossFilter.fuel = params.seriesName;
        }
        renderAll();
      });

      // KPIs
      const uniqueIntervals = intraday ? xKeys.length : [...new Set(data.map(d => d.date))].length;
      const totalGen = data.reduce((s, d) => s + d.total_mw, 0) / (uniqueIntervals || 1);
      document.getElementById('kpiGen').textContent = Math.round(totalGen).toLocaleString();
      document.getElementById('kpiGenSub').textContent = intraday ? 'Average MW' : 'Average MWh/day';

      const topFuel = Object.entries(seriesTotals).sort((a, b) => b[1] - a[1])[0];
      if (topFuel) {
        document.getElementById('kpiTopFuel').textContent = topFuel[0];
        const avgLabel = intraday ? 'MW avg' : 'MWh/day avg';
        document.getElementById('kpiTopFuelSub').textContent = `${Math.round(topFuel[1] / (uniqueIntervals || 1)).toLocaleString()} ${avgLabel}`;
      }

      // Latest MW: latest 5-min reading, respects region/fuel/DUID filters but ignores date
      const region = document.getElementById("regionFilter").value || crossFilter.region;
      const fuel = document.getElementById("fuelFilter").value || crossFilter.fuel;
      const mwFilters = [];
      if (region) mwFilters.push(`sc.Region = '${region}'`);
      if (fuel) mwFilters.push(`sc.FuelSourceDescriptor = '${fuel}'`);
      if (crossFilter.duids.length) mwFilters.push(`sc.DUID IN (${crossFilter.duids.map(d => `'${d}'`).join(',')})`);
      const mwWhere = mwFilters.length ? `AND ${mwFilters.join(' AND ')}` : '';
      // Region/Fuel filters need the dim; otherwise (incl. a DUID-only filter) stay on the fact.
      const mwSrc = (region || fuel) ? `${VMODEL} sc` : 'db.fct_summary sc';
      const latestMWResult = await runQuery(`
        SELECT SUM(sc.mw)::DOUBLE AS total_mw, CAST(sc.date AS VARCHAR) AS d, sc.time
        FROM ${mwSrc}
        WHERE sc.date = (SELECT MAX(date) FROM db.fct_summary)
          AND sc.time = (SELECT MAX(time) FROM db.fct_summary WHERE date = (SELECT MAX(date) FROM db.fct_summary))
          ${mwWhere}
        GROUP BY sc.date, sc.time`);
      if (latestMWResult.length) {
        document.getElementById('kpiLatestMW').textContent = Math.round(latestMWResult[0].total_mw).toLocaleString();
        document.getElementById('kpiLatestMWSub').textContent = `at ${formatTime(latestMWResult[0].time)}`;
      }
    }

    // --- Average Price by Region (line) ---
    async function renderPrice(seq) {
      const intraday = isIntradayMode();

      const data = await runQuery(sql.price(intraday));
      if (seq !== _renderSeq || !data.length) return;

      const { xKeys, xLabels } = buildTimeAxis(data, intraday);
      const lookup = buildLookup(data,
        row => intraday ? `${row.date}|${padTime(row.time)}|${row.Region}` : `${row.date}|${row.Region}`,
        row => row.avg_price
      );

      const regions = [...new Set(data.map(d => d.Region))].sort();

      const largeModeP = xKeys.length > 2000;
      const series = regions.map((region, i) => ({
        name: region,
        type: 'line',
        symbol: 'none',
        lineStyle: { width: largeModeP ? 1 : 2 },
        emphasis: { focus: 'series', lineStyle: { width: 3 } },
        triggerLineEvent: true,
        sampling: 'lttb',
        large: largeModeP,
        progressive: largeModeP ? 500 : 0,
        data: xKeys.map(k => {
          const v = lookup.get(`${k}|${region}`);
          return v != null ? Math.round(v * 100) / 100 : null;
        }),
      }));

      const chart = getChart('chart-price');
      chart.setOption({
        color: PALETTE,
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
        legend: { bottom: 0, textStyle: { fontSize: 11 } },
        grid: { left: 55, right: 15, top: 15, bottom: intraday ? 55 : 40 },
        xAxis: { type: 'category', data: xLabels, boundaryGap: false, axisLabel: { rotate: intraday ? 45 : 0, fontSize: intraday ? 10 : 12 } },
        yAxis: { type: 'value', name: '$/MWh', nameTextStyle: { color: '#8b949e', fontSize: 11 }, axisLabel: { formatter: v => '$' + v } },
        dataZoom: dataZoomConfig(intraday),
        series,
        animationDuration: 600,
      }, true);

      chart.off('click');
      chart.on('click', (params) => {
        if (params.seriesName) {
          crossFilter.region = crossFilter.region === params.seriesName ? null : params.seriesName;
          renderAll();
        }
      });

      // KPI: avg price
      const avgPrice = data.reduce((s, d) => s + d.avg_price, 0) / data.length;
      document.getElementById('kpiPrice').textContent = '$' + avgPrice.toFixed(1);

      // Latest Price: latest 5-min reading, respects region filter but ignores date.
      // price is region-level (denormalized per DUID), so collapse to one row per region first —
      // otherwise the cross-region average would be weighted by DUID count.
      const regionP = document.getElementById("regionFilter").value || crossFilter.region;
      const priceWhere = regionP ? `AND p.Region = '${regionP}'` : '';
      const latestPriceResult = await runQuery(`
        SELECT AVG(p.price)::DOUBLE AS avg_price, CAST(p.date AS VARCHAR) AS d, p.time
        FROM (
          SELECT Region, date, time, AVG(price) AS price
          FROM ${VMODEL}
          WHERE date = (SELECT MAX(date) FROM db.fct_summary)
            AND time = (SELECT MAX(time) FROM db.fct_summary WHERE date = (SELECT MAX(date) FROM db.fct_summary))
          GROUP BY Region, date, time
        ) p
        WHERE TRUE ${priceWhere}
        GROUP BY p.date, p.time`);
      if (latestPriceResult.length) {
        document.getElementById('kpiLatestPrice').textContent = '$' + latestPriceResult[0].avg_price.toFixed(1);
        document.getElementById('kpiLatestPriceSub').textContent = `at ${formatTime(latestPriceResult[0].time)}`;
      }
    }

    // --- Generator Map (geo scatter) ---
    let australiaMapRegistered = false;

    async function registerAustraliaMap() {
      if (australiaMapRegistered) return;
      const resp = await fetch('https://raw.githubusercontent.com/rowanhogan/australian-states/master/states.geojson');
      const geoJson = await resp.json();
      echarts.registerMap('australia', geoJson);
      australiaMapRegistered = true;
    }

    async function renderMap(seq) {
      await registerAustraliaMap();
      if (seq !== _renderSeq) return;

      const intraday = isIntradayMode();
      const unit = intraday ? 'MW' : 'MWh';
      const col = intraday ? 'mw' : 'mwh';

      const data = await runQuery(sql.mapScatter(col));
      if (seq !== _renderSeq || !data.length) return;

      const fuels = [...new Set(data.map(d => d.fuel))].sort();
      const maxMw = Math.max(...data.map(d => d.mw));

      const series = fuels.map(fuel => ({
        name: fuel,
        type: 'scatter',
        coordinateSystem: 'geo',
        data: data.filter(d => d.fuel === fuel).map(d => ({
          value: [d.lon, d.lat, d.mw],
          duid: d.DUID,
          region: d.Region,
          itemStyle: { opacity: 0.85 },
        })),
        symbolSize: d => Math.max(5, Math.sqrt(d[2] / maxMw) * 25),
        itemStyle: { color: fuelColor(fuel) },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(88,166,255,0.5)' }, scale: 1.3 },
      }));

      const chart = getChart('chart-map');
      chart.setOption({
        color: PALETTE,
        geo: {
          map: 'australia',
          roam: true,
          itemStyle: { areaColor: '#1a1f2e', borderColor: '#30363d', borderWidth: 1 },
          emphasis: { disabled: true },
          label: { show: false },
          zoom: 1.1,
          center: [134, -28],
        },
        tooltip: { trigger: 'item', formatter: p => {
          if (!p.data?.duid) return '';
          const d = p.data;
          return `<div style="font-weight:600">${d.duid}</div><div>${p.seriesName} &middot; ${d.region}</div><div style="margin-top:4px"><b>${Math.round(d.value[2]).toLocaleString()} ${unit}</b></div>`;
        }},
        series,
        animationDuration: 600,
      }, true);

      chart.off('click');
      chart.on('click', (params) => {
        const duid = params.data?.duid;
        if (duid) {
          const idx = crossFilter.duids.indexOf(duid);
          if (idx >= 0) crossFilter.duids.splice(idx, 1);
          else crossFilter.duids.push(duid);
          updateDuidTrigger();
          renderAll();
        }
      });

    }

    // =========================================================================
    // 7. WIRING (filters, CSV, DUID dropdown, renderAll, init)
    // =========================================================================

    // --- DUID multi-select dropdown ---
    let allDuids = [];

    function renderDuidList(filter = '') {
      const list = document.getElementById('duidList');
      list.innerHTML = '';
      const lc = filter.toLowerCase();
      const regionVal = document.getElementById("regionFilter").value;
      const fuelVal = document.getElementById("fuelFilter").value;
      const filtered = allDuids.filter(d =>
        d.DUID.toLowerCase().includes(lc) &&
        (!regionVal || d.Region === regionVal) &&
        (!fuelVal || d.fuel === fuelVal)
      );
      for (const d of filtered.slice(0, 150)) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = crossFilter.duids.includes(d.DUID);
        cb.addEventListener('change', () => {
          if (cb.checked) { if (!crossFilter.duids.includes(d.DUID)) crossFilter.duids.push(d.DUID); }
          else { crossFilter.duids = crossFilter.duids.filter(x => x !== d.DUID); }
          updateDuidTrigger();
          renderAll();
        });
        label.append(cb, ` ${d.DUID} (${d.Region}, ${d.fuel})`);
        list.append(label);
      }
    }

    function updateDuidTrigger() {
      const btn = document.getElementById('duidTrigger');
      btn.textContent = crossFilter.duids.length ? `${crossFilter.duids.length} selected` : 'All DUIDs';
    }

    document.getElementById('duidTrigger').addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = document.getElementById('duidPanel');
      const isOpen = panel.classList.toggle('open');
      if (isOpen) {
        document.getElementById('duidSearch').value = '';
        renderDuidList();
        document.getElementById('duidSearch').focus();
      }
    });
    document.getElementById('duidPanel').addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { document.getElementById('duidPanel').classList.remove('open'); document.querySelectorAll('.dd-panel.open').forEach(p => p.classList.remove('open')); });
    document.getElementById('duidSearch').addEventListener('input', e => renderDuidList(e.target.value));

    // --- Tab switching ---
    for (const btn of document.querySelectorAll('.tab-btn')) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById('view-dashboard').style.display = tab === 'dashboard' ? '' : 'none';
        document.getElementById('view-analyze').style.display = tab === 'analyze' ? '' : 'none';
        // Populate the SQL box the first time Analyze is opened; don't clobber manual edits after.
        if (tab === 'analyze' && !document.getElementById('analyzeSql').value.trim()) syncAnalyzeSql();
      });
    }

    // --- Analyze: dropdown open/close ---
    function setupDropdown(triggerId, panelId) {
      const trigger = document.getElementById(triggerId);
      const panel = document.getElementById(panelId);
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other panels
        document.querySelectorAll('.dd-panel.open').forEach(p => { if (p !== panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      });
      panel.addEventListener('click', e => e.stopPropagation());
    }
    setupDropdown('measTrigger', 'measPanel');
    setupDropdown('dimTrigger', 'dimPanel');

    function updateMeasTrigger() {
      const parts = [];
      if (document.getElementById('measGeneration').checked) parts.push('Generation');
      if (document.getElementById('measPrice').checked) parts.push('Price');
      document.getElementById('measTrigger').textContent = parts.length ? parts.join(', ') : 'None selected';
    }

    function updateDimTrigger() {
      const parts = [];
      if (document.getElementById('dimDate').checked) parts.push('Date');
      if (document.getElementById('dimTime').checked) parts.push('Time');
      if (document.getElementById('dimDUID').checked) parts.push('DUID');
      if (document.getElementById('dimFuel').checked) parts.push('Fuel');
      if (document.getElementById('dimRegion').checked) parts.push('Region');
      document.getElementById('dimTrigger').textContent = parts.length ? parts.join(', ') : 'None selected';
    }

    // --- Analyze: read checkboxes ---
    function getAnalyzeOptions() {
      return {
        measures: {
          generation: document.getElementById('measGeneration').checked,
          price: document.getElementById('measPrice').checked,
        },
        dimensions: {
          date: document.getElementById('dimDate').checked,
          time: document.getElementById('dimTime').checked,
          duid: document.getElementById('dimDUID').checked,
          fuel: document.getElementById('dimFuel').checked,
          region: document.getElementById('dimRegion').checked,
        },
      };
    }

    // --- Analyze: query builder ---
    function buildAnalyzeSQL(limit) {
      const { measures, dimensions } = getAnalyzeOptions();
      const hasGen = measures.generation;
      const hasPrice = measures.price;
      const raw = dimensions.time; // time dimension = 5-min raw, else daily

      // Daily (no time dim) over a daily base → re-aggregate the shared `_base` directly: one scan,
      // shared with the dashboard and visible to the export connection, both measures from one
      // source (no gen⋈price join). Price = SUM(price_sum)/SUM(price_cnt), the exact flat average.
      // Raw (5-min) or intraday mode falls back to scanning the fact via VMODEL below.
      if (!raw && !isIntradayMode()) {
        const sel = [], grp = [], ord = [];
        if (dimensions.date) { sel.push('CAST(date AS VARCHAR) AS date'); grp.push('date'); ord.push('date'); }
        if (dimensions.duid && hasGen) { sel.push('DUID'); grp.push('DUID'); ord.push('DUID'); }
        if (dimensions.fuel && hasGen) { sel.push('fuel'); grp.push('fuel'); }
        if (dimensions.region) { sel.push('Region AS region'); grp.push('Region'); }
        if (hasGen) sel.push('ROUND(SUM(mwh)::DOUBLE, 2) AS mwh');
        if (hasPrice) sel.push('ROUND((SUM(price_sum)/SUM(price_cnt))::DOUBLE, 2) AS price');
        const groupBy = grp.length ? `\nGROUP BY ${grp.join(', ')}` : '';
        const orderBy = ord.length ? `\nORDER BY ${ord.join(', ')}` : '';
        const inner = `SELECT ${sel.length ? sel.join(', ') : '*'}\nFROM _base\nWHERE ${sql.genWhere()}${groupBy}${orderBy}`;
        return limit ? `SELECT * FROM (${inner}) LIMIT ${limit}` : inner;
      }

      // Build SELECT / GROUP BY / ORDER BY from the selected dimensions — all optional, incl. Date.
      const sel = [];
      const grp = [];
      const ord = [];

      if (dimensions.date) {
        sel.push(hasGen ? 'CAST(sc.date AS VARCHAR) AS date' : 'CAST(p.date AS VARCHAR) AS date');
        grp.push(hasGen ? 'sc.date' : 'p.date');
        ord.push(hasGen ? 'sc.date' : 'p.date');
      }

      if (raw) {
        const timeAlias = hasGen ? 'sc' : 'p';
        sel.push(`lpad(CAST(${timeAlias}.time AS VARCHAR), 4, '0') AS time`);
        grp.push(`${timeAlias}.time`);
        ord.push(`${timeAlias}.time`);
      }

      if (dimensions.duid && hasGen) { sel.push('sc.DUID'); grp.push('sc.DUID'); ord.push('sc.DUID'); }
      if (dimensions.fuel && hasGen) { sel.push('sc.FuelSourceDescriptor AS fuel'); grp.push('sc.FuelSourceDescriptor'); }
      if (dimensions.region) {
        if (hasGen) { sel.push('sc.Region AS region'); grp.push('sc.Region'); }
        else { sel.push('p.Region AS region'); grp.push('p.Region'); }
      }

      // Measures
      if (hasGen) {
        if (raw) sel.push('ROUND(SUM(sc.mw)::DOUBLE, 2) AS mw');
        else sel.push('ROUND(SUM(sc.mwh)::DOUBLE, 2) AS mwh');
      }
      if (hasPrice) {
        sel.push('ROUND(AVG(p.price)::DOUBLE, 2) AS price');
      }

      // FROM clause
      let from;
      const scSrc = raw ? VMODEL
        : `(SELECT DUID, date, Region, FuelSourceDescriptor, latitude, longitude,
               CAST(SUM(mw)/12.0 AS REAL) AS mwh FROM ${VMODEL}
             GROUP BY DUID, date, Region, FuelSourceDescriptor, latitude, longitude)`;
      const prSrc = raw
        ? `(SELECT Region, date, time, AVG(price) AS price FROM ${VMODEL} GROUP BY Region, date, time)`
        : `(SELECT Region, date, AVG(price) AS price FROM ${VMODEL} GROUP BY Region, date)`;
      if (hasGen && hasPrice) {
        const timeJoin = raw ? 'AND sc.time = p.time' : '';
        from = `${scSrc} sc LEFT JOIN ${prSrc} p ON sc.date = p.date ${timeJoin} AND sc.Region = p.Region`;
      } else if (hasGen) {
        from = `${scSrc} sc`;
      } else {
        from = `${prSrc} p`;
      }

      // WHERE
      const where = hasGen ? sql.whereScada() : sql.wherePrice();

      const groupBy = grp.length ? `\nGROUP BY ${grp.join(', ')}` : '';
      const orderBy = ord.length ? `\nORDER BY ${ord.join(', ')}` : '';
      const inner = `SELECT ${sel.length ? sel.join(', ') : '*'}\nFROM ${from}\nWHERE ${where}${groupBy}${orderBy}`;

      if (limit) return `SELECT * FROM (${inner}) LIMIT ${limit}`;
      return inner;
    }

    // The Analyze SQL textarea is the source of truth for Preview/Download — it shows the
    // tool-generated query and the user can edit it freely. It's regenerated whenever the
    // builder inputs (measures / dimensions / filters) change, or via "Reset to generated".
    function syncAnalyzeSql() {
      const ta = document.getElementById('analyzeSql');
      if (ta) ta.value = buildAnalyzeSQL(null);
    }
    function getAnalyzeSql() {
      return document.getElementById('analyzeSql').value.trim().replace(/;+\s*$/, '');
    }

    // --- Analyze: ensure the base scan exists ---
    // The daily Analyze path (buildAnalyzeSQL) reads `_base`, so materialize it for the current
    // range first. Only when that path is actually in use — a raw/5-min export hits the fact
    // directly and must NOT trigger an unused base scan.
    async function ensureAnalyzeData() {
      const { dimensions } = getAnalyzeOptions();
      if (!dimensions.time && !isIntradayMode()) await materializeBase();
    }

    // --- Analyze: preview ---
    async function analyzePreview() {
      const base = getAnalyzeSql();
      if (!base) {
        document.getElementById('analyzeInfo').textContent = 'Enter a SQL query.';
        return;
      }

      const btn = document.getElementById('analyzePreview');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      const info = document.getElementById('analyzeInfo');
      const table = document.getElementById('analyzeTable');
      table.innerHTML = '';
      info.textContent = '';

      try {
        await ensureAnalyzeData();
        setStatus("Previewing...", "loading");
        const previewSql = `SELECT * FROM (\n${base}\n) LIMIT 20`;
        const rows = await runQuery(previewSql);

        if (!rows.length) {
          info.textContent = 'No data found for the selected filters.';
          setStatus(window._cutoffCached || "Connected", "connected");
          return;
        }

        const cols = Object.keys(rows[0]);
        let html = '<thead><tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        for (const row of rows) {
          html += '<tr>' + cols.map(c => `<td>${row[c] ?? ''}</td>`).join('') + '</tr>';
        }
        html += '</tbody>';
        table.innerHTML = html;

        const countSql = `SELECT COUNT(*) AS cnt FROM (\n${base}\n)`;
        const countResult = await runQuery(countSql);
        const total = countResult[0]?.cnt || rows.length;
        info.textContent = rows.length < total
          ? `Showing ${rows.length} of ${Number(total).toLocaleString()} rows`
          : `${Number(total).toLocaleString()} rows`;

        setStatus(window._cutoffCached || "Connected", "connected");
      } catch (e) {
        if (e.message && e.message.includes('Out of Memory')) {
          info.textContent = 'Out of memory. Apply filters or reduce the date range.';
        } else {
          info.textContent = 'Error: ' + e.message;
        }
        setStatus("Query error", "error");
        console.error('[Analyze]', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Preview';
      }
    }

    // --- Analyze: query plan (EXPLAIN) ---
    async function analyzePlan() {
      const base = getAnalyzeSql();
      const info = document.getElementById('analyzeInfo');
      if (!base) { info.textContent = 'Enter a SQL query.'; return; }

      const btn = document.getElementById('analyzePlan');
      btn.disabled = true;
      btn.textContent = 'Planning...';
      const table = document.getElementById('analyzeTable');
      table.innerHTML = '';
      info.textContent = '';

      try {
        await ensureAnalyzeData();   // the daily plan references _base — make sure it exists
        setStatus("Explaining...", "loading");
        const rows = await runQuery(`EXPLAIN ${base}`);
        const plan = rows.map(r => r.explain_value ?? Object.values(r).join('  ')).join('\n');
        const esc = plan.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        table.innerHTML = `<tbody><tr><td><pre style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.72rem;line-height:1.4;white-space:pre;overflow-x:auto;margin:0">${esc}</pre></td></tr></tbody>`;
        info.textContent = 'Query plan (EXPLAIN)';
        setStatus(window._cutoffCached || "Connected", "connected");
      } catch (e) {
        info.textContent = 'Error: ' + e.message;
        setStatus("Query error", "error");
        console.error('[Analyze plan]', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Show plan';
      }
    }

    // --- Analyze: download ---
    async function analyzeDownload() {
      const base = getAnalyzeSql();
      if (!base) {
        alert('Enter a SQL query.');
        return;
      }

      const btn = document.getElementById('analyzeDownload');
      btn.disabled = true;
      btn.textContent = 'Loading...';

      try {
        await ensureAnalyzeData();
        btn.textContent = 'Exporting...';
        setStatus("Exporting CSV...", "loading");
        const exportSql = `SELECT * FROM (\n${base}\n) LIMIT 1000000`;
        const { from, to } = getDateRange();
        const filename = `energy_export_${from}_${to}.csv`;
        const rowCount = await downloadCSVDirect(exportSql, filename);
        setStatus(`Exported ${rowCount.toLocaleString()} rows`, "connected");
        if (rowCount >= 1000000) {
          alert('Export capped at 1,000,000 rows. Apply filters or reduce the date range for complete data.');
        }
      } catch (e) {
        if (e.message && e.message.includes('Out of Memory')) {
          setStatus("Export failed: out of memory", "error");
          alert('Out of memory. Apply filters (region, fuel, DUID) or reduce the date range.');
        } else {
          setStatus("CSV export error: " + e.message, "error");
        }
        console.error('[Analyze CSV]', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Download CSV';
      }
    }

    document.getElementById('analyzePreview').addEventListener('click', analyzePreview);
    document.getElementById('analyzePlan').addEventListener('click', analyzePlan);
    document.getElementById('analyzeDownload').addEventListener('click', analyzeDownload);
    document.getElementById('analyzeSqlReset').addEventListener('click', syncAnalyzeSql);
    for (const id of ['measGeneration', 'measPrice']) {
      document.getElementById(id).addEventListener('change', () => { updateMeasTrigger(); clearAnalyzePreview(); });
    }
    for (const id of ['dimDate', 'dimTime', 'dimDUID', 'dimFuel', 'dimRegion']) {
      document.getElementById(id).addEventListener('change', () => { updateDimTrigger(); clearAnalyzePreview(); });
    }

    // --- Filter population ---
    async function populateFilters() {
      const regions = await runQuery(sql.regions);
      const fuels = await runQuery(sql.fuels);
      const regionSelect = document.getElementById("regionFilter");
      for (const r of regions) regionSelect.add(new Option(r.Region, r.Region));
      const fuelSelect = document.getElementById("fuelFilter");
      for (const f of fuels) fuelSelect.add(new Option(f.fuel, f.fuel));
      allDuids = await runQuery(sql.allDuids);

      // Set date range defaults: last 3 days up to max date in data
      const maxDateResult = await runQuery("SELECT CAST(MAX(date) AS VARCHAR) AS d FROM db.fct_summary");
      const minDateResult = await runQuery("SELECT CAST(MIN(date) AS VARCHAR) AS d FROM db.dim_calendar");
      const maxDate = maxDateResult[0].d;
      const minDate = minDateResult[0].d;
      const fromDate = new Date(maxDate);
      fromDate.setDate(fromDate.getDate() - 3);
      document.getElementById("dateTo").value = maxDate;
      document.getElementById("dateTo").min = minDate;
      document.getElementById("dateTo").max = maxDate;
      document.getElementById("dateFrom").value = fromDate.toISOString().split('T')[0];
      document.getElementById("dateFrom").min = minDate;
      document.getElementById("dateFrom").max = maxDate;
    }

    // --- Filter change listeners ---
    function clearAnalyzePreview() {
      document.getElementById('analyzeTable').innerHTML = '';
      document.getElementById('analyzeInfo').textContent = '';
      syncAnalyzeSql();   // builder inputs changed -> refresh the generated SQL
    }

    for (const id of ["dateFrom", "dateTo"]) {
      document.getElementById(id).addEventListener("change", () => {
        crossFilter.fuel = null;
        crossFilter.region = null;
        crossFilter.duids = [];
        updateDuidTrigger();
        // Don't clear the result cache: visual-cache keys encode the date range + filters, so a
        // new range is just a new key and a previously-seen range stays a hit (spec §6). The base
        // itself is reused/​rebuilt by materializeBase()'s containment check.
        clearAnalyzePreview();

        renderAll();
      });
    }

    for (const id of ["regionFilter", "fuelFilter"]) {
      document.getElementById(id).addEventListener("change", () => {
        crossFilter.fuel = null;
        crossFilter.region = null;
        crossFilter.duids = [];
        updateDuidTrigger();
        clearAnalyzePreview();

        renderAll();
      });
    }

    // --- Render all ---
    async function renderAll() {
      const seq = ++_renderSeq;
      if (!window._cutoffCached) setStatus("Querying...", "loading");
      document.querySelector('.charts').classList.add('loading');
      updateFilterTags();
      try {
        // Storage-engine pass: ensure _base covers the selected range (reused via containment, or
        // re-scanned if the range widened). Every chart/KPI below re-aggregates _base — no re-scan.
        await materializeBase();
        if (seq !== _renderSeq) return;
        await Promise.all([renderGeneration(seq), renderPrice(seq), renderMap(seq),
          runQuery(sql.generatorCount()).then(r => { if (seq === _renderSeq && r.length) document.getElementById('kpiGens').textContent = r[0].cnt.toLocaleString(); })
        ]);
        if (seq !== _renderSeq) return;
        document.querySelector('.charts').classList.remove('loading');
        if (!window._cutoffCached) {
          const cutoffResult = await runQuery(sql.cutoff);
          if (seq !== _renderSeq) return;
          if (cutoffResult.length && cutoffResult[0].last_update) {
            // Show the stored digits as-is — just drop the trailing +00 offset tag and label it
            // AEMO time. No timezone conversion, only relabeling.
            const ts = cutoffResult[0].last_update
              .replace(/[+-]\d{2}(:\d{2})?$/, '')      // drop trailing +00 offset
              .replace(/(\d{2}:\d{2}):\d{2}/, '$1')    // HH:MM:SS -> HH:MM
              .trim();
            window._cutoffCached = `Updated ${ts} AEMO TIME`;
          }
        }
        setStatus(window._cutoffCached || "Connected", "connected");
      } catch (e) {
        setStatus("Query error: " + e.message, "error");
        console.error(e);
      }
    }

    // --- Init ---
    async function startDashboard() {
      if (!window.crossOriginIsolated && window.coi?.shouldRegister?.() !== false) {
        // coi-serviceworker.js will reload the page once COI headers are active.
        // Don't start a download that would be interrupted by that reload.
        setStatus("Activating multi-threading...", "loading");
        return;
      }
      const { db, conn: c } = await data.init();
      _db = db;
      conn = c;
      await populateFilters();
      await renderAll();
    }

    // --- Providers: auth + data implementations are selected by config.js (see auth.js / data.js). ---
    const cfg = window.RAYFIN_WASM_CONFIG || {};
    const auth = createAuth(cfg);
    const data = createDataSource(cfg, auth, { onStatus: setStatus });

    // Render the sign-in button into the auth gate — the Fabric sign-in popup needs a user gesture.
    function showSignIn(onDone) {
      const gate = document.getElementById('authGate');
      gate.style.display = 'flex';
      gate.innerHTML = '<button id="signinBtn" style="padding:0.8rem 1.6rem;font-size:1rem;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer">Sign in with Fabric</button>';
      document.getElementById('signinBtn').onclick = async () => {
        try {
          document.getElementById('signinBtn').textContent = 'Signing in…';
          if (await auth.ensureSession(true)) { gate.style.display = 'none'; await onDone(); }
          else document.getElementById('signinBtn').textContent = 'Sign in with Fabric';
        } catch (e) { setStatus('Sign-in failed: ' + e.message, 'error'); console.error(e); }
      };
    }

    // Gate. No-auth mode: ensureSession() is always true -> straight in. Rayfin: the silent check
    // covers a stored session and the Fabric iframe handoff; a standalone tab with no session gets
    // the sign-in button.
    try {
      if (await auth.ensureSession(false)) {
        document.getElementById('authGate').style.display = 'none';
        await startDashboard();
      } else {
        showSignIn(startDashboard);
      }
    } catch (e) {
      document.getElementById('authGateMsg').textContent = 'Error: ' + e.message;
      setStatus("Error: " + e.message, "error");
      console.error(e);
    }
