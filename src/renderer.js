(() => {
  'use strict';

  const HISTORY_LEN = 120;

  const colors = {
    cpu: '#4ade80',
    mem: '#c084fc',
    disk: '#38bdf8',
    netDown: '#60a5fa',
    netUp: '#fb923c',
    power: '#fbbf24',
    thermal: '#f97373',
    gpuD: '#34d399',
    gpuI: '#38bdf8',
  };

  const hist = {
    cpu: [], mem: [], disk: [], netDown: [], netUp: [], power: [], thermal: [], battery: [], gpuD: [], gpuI: [],
  };
  function push(key, val) {
    const arr = hist[key];
    arr.push(val);
    if (arr.length > HISTORY_LEN) arr.shift();
  }

  // ---------------- formatting helpers ----------------
  const fmtPct = (v) => (v == null || isNaN(v) ? '--' : `${v.toFixed(1)}%`);
  const fmtGB = (bytes) => (bytes == null ? '--' : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
  function fmtRate(bytesPerSec) {
    if (bytesPerSec == null || isNaN(bytesPerSec)) return '--';
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  }
  function fmtW(w) {
    if (w == null || isNaN(w)) return '--';
    return `${w.toFixed(1)} W`;
  }
  function fmtTemp(c) {
    if (c == null || isNaN(c) || c < 0) return '--';
    return `${c.toFixed(0)}°C`;
  }
  function fmtTime(mins) {
    if (mins == null || mins < 0 || isNaN(mins)) return '--';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function fmtMB(mb) {
    if (mb == null || isNaN(mb)) return '--';
    if (mb < 1024) return `${mb.toFixed(0)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  // ---------------- canvas chart ----------------
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return null;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawChart(canvas, values, color, opts = {}) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;

    const detailed = !!opts.detailed;
    const fixedMax = opts.max;
    const padTop = detailed ? 10 : 3;
    const padBottom = detailed ? 4 : 3;
    const plotH = h - padTop - padBottom;

    let max = fixedMax != null ? fixedMax : Math.max(...values, 1);
    let min = opts.min != null ? opts.min : 0;
    if (max === min) max = min + 1;

    if (detailed) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = padTop + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    const n = values.length;
    const stepX = n > 1 ? w / (HISTORY_LEN - 1) : w;
    const offsetX = w - (n - 1) * stepX;

    const pts = values.map((v, i) => {
      const x = offsetX + i * stepX;
      const norm = Math.min(1, Math.max(0, (v - min) / (max - min)));
      const y = padTop + plotH * (1 - norm);
      return [x, y];
    });

    // fill
    const grad = ctx.createLinearGradient(0, padTop, 0, h);
    grad.addColorStop(0, color + (detailed ? '55' : '3a'));
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(pts[pts.length - 1][0], h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = detailed ? 2 : 1.4;
    if (detailed) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---------------- GPU helpers ----------------
  function gpuDiscrete() { return latest?.gpu?.discrete || null; }
  function gpuIntegrated() { return latest?.gpu?.integrated || null; }
  function gpuDiscreteName() {
    const spec = specs?.graphics?.find((g) => g.vendor && g.vendor.toUpperCase().includes('NVIDIA') || (g.vendor && g.vendor.toUpperCase().includes('AMD')));
    return spec?.model || 'Discrete GPU';
  }
  function gpuIntegratedName() {
    const spec = specs?.graphics?.find((g) => g.vendor && g.vendor.toUpperCase().includes('INTEL'));
    return spec?.model || 'Integrated GPU';
  }

  // ---------------- summary cards ----------------
  const summaryDefs = [
    { id: 'cpu', label: 'CPU', color: colors.cpu, value: () => fmtPct(latest?.cpu.load), sub: () => latest ? `${latest.cpu.speed.toFixed(2)} GHz · ${latest.cpu.cores} threads` : '--' },
    { id: 'mem', label: 'Memory', color: colors.mem, value: () => latest ? fmtPct((latest.mem.used / latest.mem.total) * 100) : '--', sub: () => latest ? `${fmtGB(latest.mem.used)} / ${fmtGB(latest.mem.total)}` : '--' },
    { id: 'gpuD', label: 'GPU (Discrete)', color: colors.gpuD, value: () => gpuDiscrete() ? fmtPct(gpuDiscrete().utilization) : 'N/A', sub: () => gpuDiscrete() ? `${gpuDiscreteName()} · ${fmtTemp(gpuDiscrete().tempC)}` : 'No discrete GPU detected' },
    { id: 'gpuI', label: 'GPU (Integrated)', color: colors.gpuI, value: () => gpuIntegrated() ? fmtPct(gpuIntegrated().utilization) : 'N/A', sub: () => gpuIntegrated() ? gpuIntegratedName() : 'Unavailable on this system' },
    { id: 'disk', label: 'Disk', color: colors.disk, value: () => latest ? fmtRate(latest.disk.readSec + latest.disk.writeSec) : '--', sub: () => latest ? `R ${fmtRate(latest.disk.readSec)} · W ${fmtRate(latest.disk.writeSec)}` : '--' },
    { id: 'net', label: 'Network', color: colors.netDown, value: () => latest ? fmtRate(latest.net.rx) : '--', sub: () => latest ? `↓ ${fmtRate(latest.net.rx)} · ↑ ${fmtRate(latest.net.tx)}` : '--' },
    { id: 'power', label: 'Power Draw', color: colors.power, value: () => fmtW(currentPowerDraw()), sub: () => powerSubtext() },
    { id: 'battery', label: 'Battery', color: colors.cpu, value: () => latest?.battery.hasBattery ? fmtPct(latest.battery.percent) : 'No battery', sub: () => batterySubtext() },
    { id: 'thermal', label: 'Thermal', color: colors.thermal, value: () => fmtTemp(latest?.cpu.temp), sub: () => 'CPU package temperature' },
  ];

  function currentPowerDraw() {
    if (!latest) return null;
    const w = latest.battery.wmi;
    if (!w) return null;
    if (w.discharging) return w.dischargeRateW;
    if (w.charging) return w.chargeRateW;
    return 0;
  }
  function powerSubtext() {
    if (!latest) return '--';
    const w = latest.battery.wmi;
    if (!w) return latest.battery.hasBattery ? 'Rate unavailable' : 'No battery detected';
    if (w.discharging) return 'Discharging (on battery)';
    if (w.charging) return 'Charging via AC';
    return w.acOnline ? 'Idle on AC power' : 'Idle';
  }
  function batterySubtext() {
    if (!latest || !latest.battery.hasBattery) return 'Desktop / no battery';
    const b = latest.battery;
    if (b.isCharging) return `Charging · ${fmtTime(b.timeRemaining)} to full`;
    return `${fmtTime(b.timeRemaining)} remaining`;
  }

  let summaryCardsBuilt = false;
  function buildSummaryCards() {
    const grid = document.getElementById('summary-cards');
    grid.innerHTML = summaryDefs.map((d) => `
      <div class="stat-card" data-id="${d.id}">
        <div class="stat-card-top">
          <div class="stat-card-label"><span class="stat-card-dot" style="color:${d.color}"></span>${d.label}</div>
        </div>
        <div class="stat-card-value" id="sc-val-${d.id}">--</div>
        <div class="stat-card-sub" id="sc-sub-${d.id}">--</div>
        <canvas id="sc-chart-${d.id}"></canvas>
      </div>
    `).join('');
    summaryCardsBuilt = true;
  }

  function updateSummaryCards() {
    if (!summaryCardsBuilt) buildSummaryCards();
    summaryDefs.forEach((d) => {
      document.getElementById(`sc-val-${d.id}`).textContent = d.value();
      document.getElementById(`sc-sub-${d.id}`).textContent = d.sub();
    });
    drawChart(document.getElementById('sc-chart-cpu'), hist.cpu, colors.cpu, { max: 100 });
    drawChart(document.getElementById('sc-chart-mem'), hist.mem, colors.mem, { max: 100 });
    drawChart(document.getElementById('sc-chart-gpuD'), hist.gpuD, colors.gpuD, { max: 100 });
    drawChart(document.getElementById('sc-chart-gpuI'), hist.gpuI, colors.gpuI, { max: 100 });
    drawChart(document.getElementById('sc-chart-disk'), hist.disk, colors.disk);
    drawChart(document.getElementById('sc-chart-net'), hist.netDown, colors.netDown);
    drawChart(document.getElementById('sc-chart-power'), hist.power, colors.power);
    drawChart(document.getElementById('sc-chart-battery'), hist.battery, colors.cpu, { max: 100 });
    drawChart(document.getElementById('sc-chart-thermal'), hist.thermal, colors.thermal, { max: 100 });
  }

  // ---------------- performance view ----------------
  const perfMetrics = [
    { id: 'cpu', label: 'CPU', color: colors.cpu, key: 'cpu' },
    { id: 'mem', label: 'Memory', color: colors.mem, key: 'mem' },
    { id: 'gpuD', label: 'GPU (Discrete)', color: colors.gpuD, key: 'gpuD' },
    { id: 'gpuI', label: 'GPU (Integrated)', color: colors.gpuI, key: 'gpuI' },
    { id: 'disk', label: 'Disk', color: colors.disk, key: 'disk' },
    { id: 'net', label: 'Network', color: colors.netDown, key: 'netDown' },
    { id: 'power', label: 'Energy', color: colors.power, key: 'power' },
    { id: 'thermal', label: 'Thermals', color: colors.thermal, key: 'thermal' },
  ];
  let activeMetric = 'cpu';
  let perfListBuilt = false;

  function buildPerfList() {
    const list = document.getElementById('perf-list');
    list.innerHTML = perfMetrics.map((m) => `
      <div class="perf-row" data-metric="${m.id}" style="--row-color:${m.color}">
        <div class="perf-row-top">
          <span class="perf-row-name">${m.label}</span>
          <span class="perf-row-val" id="pl-val-${m.id}">--</span>
        </div>
        <canvas id="pl-chart-${m.id}"></canvas>
      </div>
    `).join('');
    list.querySelectorAll('.perf-row').forEach((row) => {
      row.addEventListener('click', () => {
        activeMetric = row.dataset.metric;
        list.querySelectorAll('.perf-row').forEach((r) => r.classList.toggle('active', r === row));
        renderPerfDetail();
      });
    });
    list.querySelector(`[data-metric="${activeMetric}"]`).classList.add('active');
    perfListBuilt = true;
  }

  const PCT_METRICS = new Set(['cpu', 'mem', 'thermal', 'gpuD', 'gpuI']);

  function perfRowValue(m) {
    if (!latest) return '--';
    switch (m.id) {
      case 'cpu': return fmtPct(latest.cpu.load);
      case 'mem': return fmtPct((latest.mem.used / latest.mem.total) * 100);
      case 'gpuD': return gpuDiscrete() ? fmtPct(gpuDiscrete().utilization) : 'N/A';
      case 'gpuI': return gpuIntegrated() ? fmtPct(gpuIntegrated().utilization) : 'N/A';
      case 'disk': return fmtRate(latest.disk.readSec + latest.disk.writeSec);
      case 'net': return fmtRate(latest.net.rx + latest.net.tx);
      case 'power': return fmtW(currentPowerDraw());
      case 'thermal': return fmtTemp(latest.cpu.temp);
    }
  }

  function updatePerfList() {
    if (!perfListBuilt) buildPerfList();
    perfMetrics.forEach((m) => {
      document.getElementById(`pl-val-${m.id}`).textContent = perfRowValue(m);
      const max = PCT_METRICS.has(m.id) ? 100 : undefined;
      drawChart(document.getElementById(`pl-chart-${m.id}`), hist[m.key], m.color, { max });
    });
  }

  function renderPerfDetail() {
    if (!latest) return;
    const m = perfMetrics.find((x) => x.id === activeMetric);
    document.getElementById('perf-title').textContent = m.label;
    document.getElementById('perf-headline').textContent = perfRowValue(m);
    const max = PCT_METRICS.has(m.id) ? 100 : undefined;
    drawChart(document.getElementById('perf-chart'), hist[m.key], m.color, { detailed: true, max });

    const statsEl = document.getElementById('perf-stats');
    if (m.id === 'cpu') {
      statsEl.innerHTML = `
        ${tile('Processor', latest.cpu.brand)}
        ${tile('Cores', `${latest.cpu.physicalCores} physical / ${latest.cpu.cores} logical`)}
        ${tile('Speed', `${latest.cpu.speed.toFixed(2)} GHz`)}
        ${tile('Processes', latest.processCount ?? '--')}
        ${tile('Threads', latest.threadCount ?? '--')}
      ` + `<div class="perf-stat-full" style="grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill,minmax(50px,1fr));gap:6px;margin-top:6px;">${
        latest.cpu.perCore.map((v, i) => `
          <div style="text-align:center;">
            <div style="height:34px;background:#141a23;border-radius:4px;position:relative;overflow:hidden;display:flex;align-items:flex-end;">
              <div style="width:100%;background:${colors.cpu};opacity:0.75;height:${Math.max(2, v)}%"></div>
            </div>
            <div style="font-size:9.5px;color:var(--text-dimmer);margin-top:3px;font-family:var(--font-mono)">C${i}</div>
          </div>`).join('')
      }</div>`;
    } else if (m.id === 'mem') {
      statsEl.innerHTML = `
        ${tile('Used', fmtGB(latest.mem.used))}
        ${tile('Available', fmtGB(latest.mem.free))}
        ${tile('Cached', fmtGB(latest.mem.cached))}
        ${tile('Total', fmtGB(latest.mem.total))}
        ${tile('Swap Used', fmtGB(latest.mem.swapUsed))}
      `;
    } else if (m.id === 'gpuD') {
      const g = gpuDiscrete();
      statsEl.innerHTML = g ? `
        ${tile('Model', gpuDiscreteName())}
        ${tile('Memory Used', `${fmtMB(g.memUsedMB)} / ${fmtMB(g.memTotalMB)}`)}
        ${tile('Power Draw', fmtW(g.powerDrawW))}
        ${tile('Temperature', fmtTemp(g.tempC))}
        ${tile('Core Clock', g.clockMHz ? `${g.clockMHz} MHz` : '--')}
      ` : `${tile('Status', 'No discrete GPU detected (nvidia-smi unavailable)')}`;
    } else if (m.id === 'gpuI') {
      const g = gpuIntegrated();
      statsEl.innerHTML = `
        ${tile('Model', gpuIntegratedName())}
        ${tile('Status', g ? 'Live via GPU Engine counters' : 'Utilization unavailable on this system')}
      `;
    } else if (m.id === 'disk') {
      statsEl.innerHTML = `
        ${tile('Read', fmtRate(latest.disk.readSec))}
        ${tile('Write', fmtRate(latest.disk.writeSec))}
        ${latest.disk.volumes.slice(0, 3).map((v) => tile(v.mount, `${v.use?.toFixed(0) ?? '--'}% used`)).join('')}
      `;
    } else if (m.id === 'net') {
      statsEl.innerHTML = `
        ${tile('Download', fmtRate(latest.net.rx))}
        ${tile('Upload', fmtRate(latest.net.tx))}
        ${tile('Interfaces', latest.net.interfaces)}
      `;
    } else if (m.id === 'power') {
      statsEl.innerHTML = `
        ${tile('Status', powerSubtext())}
        ${tile('Battery', latest.battery.hasBattery ? fmtPct(latest.battery.percent) : 'N/A')}
        ${tile('AC Power', latest.battery.acConnected ? 'Connected' : 'Not connected')}
      `;
    } else if (m.id === 'thermal') {
      statsEl.innerHTML = `
        ${tile('CPU Package', fmtTemp(latest.cpu.temp))}
      `;
    }
  }
  function tile(label, val) {
    return `<div><div class="perf-stat-label">${label}</div><div class="perf-stat-val">${val}</div></div>`;
  }

  // ---------------- processes view ----------------
  let sortField = 'cpu';
  let sortDir = -1;
  let searchTerm = '';

  document.getElementById('proc-search').addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    renderProcesses();
  });
  document.querySelectorAll('.proc-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      if (sortField === f) sortDir *= -1;
      else { sortField = f; sortDir = -1; }
      document.querySelectorAll('.proc-table th').forEach((h) => h.classList.remove('sort-active'));
      th.classList.add('sort-active');
      renderProcesses();
    });
  });

  function renderProcesses() {
    if (!latest) return;
    let list = latest.processes.filter((p) => !searchTerm || p.name.toLowerCase().includes(searchTerm));
    list = list.slice().sort((a, b) => {
      const av = a[sortField], bv = b[sortField];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * ((bv ?? 0) - (av ?? 0));
    });
    document.getElementById('proc-summary').textContent = `${latest.processCount} processes · ${latest.threadCount} threads`;
    const body = document.getElementById('proc-body');
    body.innerHTML = list.map((p) => `
      <tr data-pid="${p.pid}">
        <td class="proc-name" title="${p.command || p.name}">${escapeHtml(p.name)}</td>
        <td>${p.pid}</td>
        <td class="proc-bar-cell">${fmtPct(p.cpu)}<div class="proc-bar-bg"><div class="proc-bar-fill" style="width:${Math.min(100, p.cpu)}%;background:${colors.cpu}"></div></div></td>
        <td>${fmtMB(p.mem)}</td>
        <td><button class="kill-btn" data-pid="${p.pid}">End task</button></td>
      </tr>
    `).join('');
    body.querySelectorAll('.kill-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pid = btn.dataset.pid;
        const row = btn.closest('tr');
        const name = row.querySelector('.proc-name').textContent;
        if (!confirm(`End process "${name}" (PID ${pid})? Unsaved work may be lost.`)) return;
        btn.disabled = true;
        btn.textContent = '...';
        const res = await window.pulse.killProcess(Number(pid));
        if (!res.ok) {
          alert(`Could not end process: ${res.error}`);
          btn.disabled = false;
          btn.textContent = 'End task';
        }
      });
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- power view ----------------
  function updatePowerView() {
    if (!latest) return;
    const b = latest.battery;
    const fill = document.getElementById('battery-fill');
    const pctEl = document.getElementById('battery-pct');
    const statusEl = document.getElementById('battery-status');

    if (b.hasBattery) {
      const pct = b.percent ?? 0;
      fill.style.height = `${pct}%`;
      const color = pct > 40 ? 'var(--battery-ok)' : pct > 15 ? 'var(--battery-mid)' : 'var(--battery-low)';
      fill.style.background = `linear-gradient(180deg, ${color}, ${color})`;
      fill.style.boxShadow = `0 0 20px -2px ${color} inset`;
      pctEl.textContent = `${pct.toFixed(0)}%`;
      statusEl.textContent = batterySubtext();
    } else {
      fill.style.height = '0%';
      pctEl.textContent = '--';
      statusEl.textContent = 'No battery detected';
    }

    const draw = currentPowerDraw();
    document.getElementById('power-headline').textContent = draw != null ? `${draw >= 0 ? '' : '-'}${fmtW(Math.abs(draw))}` : '--';
    drawChart(document.getElementById('power-chart'), hist.power, colors.power, { detailed: true });

    const statsEl = document.getElementById('power-stats');
    const w = b.wmi;
    statsEl.innerHTML = `
      ${statTile('Status', powerSubtext())}
      ${statTile('Voltage', w?.voltageV ? `${w.voltageV.toFixed(2)} V` : (b.voltage ? `${b.voltage.toFixed(2)} V` : '--'))}
      ${statTile('AC Power', b.acConnected ? 'Connected' : 'On battery')}
      ${statTile('Cycle Count', b.cycleCount || '--')}
      ${statTile('Time Remaining', b.hasBattery ? fmtTime(b.timeRemaining) : '--')}
      ${statTile('Manufacturer', b.manufacturer || '--')}
    `;

    const design = b.designedCapacity;
    const full = b.maxCapacity;
    const healthPct = design && full ? Math.min(100, (full / design) * 100) : null;
    document.getElementById('health-pct').textContent = healthPct != null ? `${healthPct.toFixed(0)}%` : 'N/A';
    document.getElementById('health-bar-fill').style.width = healthPct != null ? `${healthPct}%` : '0%';
    document.getElementById('health-caps').textContent = design && full
      ? `Design capacity ${design.toLocaleString()} ${b.capacityUnit || 'mWh'} · Full-charge capacity ${full.toLocaleString()} ${b.capacityUnit || 'mWh'} · Current ${b.currentCapacity?.toLocaleString() ?? '--'} ${b.capacityUnit || 'mWh'}`
      : 'Capacity data unavailable on this system';
  }
  function statTile(label, val) {
    return `<div class="stat-tile"><div class="stat-tile-label">${label}</div><div class="stat-tile-val">${val}</div></div>`;
  }

  // ---------------- about this pc view ----------------
  let specs = null;
  let aboutBuilt = false;

  function specGroup(title, color, rows) {
    const rowsHtml = rows
      .filter((r) => r[1] != null && r[1] !== '' && r[1] !== 'undefined undefined')
      .map(([label, val]) => `<div class="spec-row"><span class="spec-row-label">${label}</span><span class="spec-row-val">${val}</span></div>`)
      .join('');
    return `<div class="spec-group">
      <div class="spec-group-title"><span class="dot" style="color:${color}"></span>${title}</div>
      ${rowsHtml || '<div class="spec-row"><span class="spec-row-label">No data available</span></div>'}
    </div>`;
  }

  function buildAbout() {
    if (!specs) return;
    document.getElementById('about-title').textContent =
      [specs.system.manufacturer, specs.system.version || specs.system.model].filter(Boolean).join(' ') || specs.os.hostname || 'This PC';
    document.getElementById('about-subtitle').textContent =
      `${specs.os.distro || specs.os.platform} · ${specs.os.arch} · ${specs.os.hostname}`;

    const groups = [];

    groups.push(specGroup('Processor', colors.cpu, [
      ['Model', `${specs.cpu.manufacturer} ${specs.cpu.brand}`],
      ['Cores', `${specs.cpu.physicalCores} physical / ${specs.cpu.cores} logical`],
      ['Base Speed', specs.cpu.speed ? `${specs.cpu.speed} GHz` : null],
      ['Max Speed', specs.cpu.speedMax ? `${specs.cpu.speedMax} GHz` : null],
      ['Socket', specs.cpu.socket],
      ['L3 Cache', specs.cpu.cache && specs.cpu.cache.l3 ? `${(specs.cpu.cache.l3 / 1024 / 1024).toFixed(1)} MB` : null],
    ]));

    const memTotal = latest ? fmtGB(latest.mem.total) : null;
    const memRows = [['Total Installed', memTotal]];
    (specs.memorySticks || []).forEach((m, i) => {
      if (!m.size) return;
      memRows.push([`Slot ${m.bank || i + 1}`, `${(m.size / 1024 ** 3).toFixed(0)} GB · ${m.type || ''} ${m.clockSpeed ? m.clockSpeed + ' MHz' : ''}`.trim()]);
    });
    groups.push(specGroup('Memory', colors.mem, memRows));

    (specs.graphics || []).forEach((g) => {
      const isNvOrAmd = g.vendor && /nvidia|amd/i.test(g.vendor);
      groups.push(specGroup(isNvOrAmd ? 'Graphics (Discrete)' : 'Graphics (Integrated)', isNvOrAmd ? colors.gpuD : colors.gpuI, [
        ['Model', g.model],
        ['Vendor', g.vendor],
        ['VRAM', g.vram ? `${(g.vram / 1024).toFixed(1)} GB${g.vramDynamic ? ' (shared)' : ''}` : null],
        ['Driver', g.driverVersion],
        ['Bus', g.bus],
      ]));
    });

    (specs.disks || []).forEach((d, i) => {
      groups.push(specGroup(`Storage ${i + 1}`, colors.disk, [
        ['Device', d.name || d.device],
        ['Type', d.type],
        ['Vendor', d.vendor],
        ['Interface', d.interfaceType],
        ['Size', d.size ? fmtGB(d.size) : null],
      ]));
    });

    (specs.displays || []).forEach((d, i) => {
      groups.push(specGroup(`Display ${i + 1}${d.builtin ? ' (Built-in)' : ''}`, colors.gpuI, [
        ['Model', d.model],
        ['Resolution', d.resolutionX ? `${d.resolutionX} × ${d.resolutionY}` : null],
        ['Refresh Rate', d.currentRefreshRate ? `${d.currentRefreshRate} Hz` : null],
        ['Connection', d.connection],
      ]));
    });

    groups.push(specGroup('System', colors.power, [
      ['Manufacturer', specs.system.manufacturer],
      ['Model', specs.system.version || specs.system.model],
      ['BIOS Vendor', specs.bios.vendor],
      ['BIOS Version', specs.bios.version],
      ['Motherboard', [specs.baseboard.manufacturer, specs.baseboard.model].filter(Boolean).join(' ')],
    ]));

    groups.push(specGroup('Operating System', colors.thermal, [
      ['OS', specs.os.distro],
      ['Version', specs.os.release],
      ['Build', specs.os.build],
      ['Kernel', specs.os.kernel],
      ['Architecture', specs.os.arch],
      ['Hostname', specs.os.hostname],
    ]));

    document.getElementById('spec-groups').innerHTML = groups.join('');
    aboutBuilt = true;
  }

  window.pulse.getSpecs().then((s) => {
    specs = s;
    buildAbout();
  });

  // ---------------- navigation ----------------
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
      renderActiveView();
    });
  });

  function renderActiveView() {
    const activeView = document.querySelector('.view.active').id;
    if (activeView === 'view-summary') updateSummaryCards();
    else if (activeView === 'view-performance') { updatePerfList(); renderPerfDetail(); }
    else if (activeView === 'view-processes') renderProcesses();
    else if (activeView === 'view-power') updatePowerView();
    else if (activeView === 'view-about' && !aboutBuilt) buildAbout();
  }

  window.addEventListener('resize', () => renderActiveView());

  // ---------------- titlebar controls ----------------
  document.getElementById('btn-min').addEventListener('click', () => window.pulse.minimize());
  document.getElementById('btn-max').addEventListener('click', () => window.pulse.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.pulse.close());

  // ---------------- data feed ----------------
  let latest = null;
  window.pulse.onStats((data) => {
    latest = data;
    push('cpu', data.cpu.load);
    push('mem', (data.mem.used / data.mem.total) * 100);
    push('disk', data.disk.readSec + data.disk.writeSec);
    push('netDown', data.net.rx);
    push('netUp', data.net.tx);
    push('power', currentPowerDraw() ?? 0);
    push('thermal', data.cpu.temp && data.cpu.temp > 0 ? data.cpu.temp : (hist.thermal.at(-1) ?? 0));
    push('battery', data.battery.percent ?? 0);
    push('gpuD', data.gpu?.discrete?.utilization ?? 0);
    push('gpuI', data.gpu?.integrated?.utilization ?? 0);

    document.getElementById('sys-hostname').textContent = data.system.hostname || '--';
    document.getElementById('sys-os').textContent = data.system.distro || data.system.platform;

    renderActiveView();
  });

  window.pulse.onStatsError((msg) => console.error('stats error:', msg));
})();
