const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const si = require('systeminformation');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0a0d12',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('maximize', () => win.webContents.send('window-state', 'maximized'));
  win.on('unmaximize', () => win.webContents.send('window-state', 'normal'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- window controls ----
ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());

// ---- process control ----
ipcMain.handle('proc:kill', async (_evt, pid) => {
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        exec(`taskkill /PID ${pid} /F`, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Windows-only telemetry not exposed by systeminformation ----
// Battery charge/discharge wattage lives in the root\wmi BatteryStatus class.
// Integrated-GPU engine utilization lives in the "GPU Engine" perf counter set
// (what Task Manager's GPU tab reads), keyed by adapter LUID rather than name.
// Both are fetched in a single PowerShell process per tick to keep subprocess
// spawns cheap (spawning one per second was what pinned a CPU core earlier).
const WIN_TELEMETRY_SCRIPT = `
$battery = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object Voltage,ChargeRate,DischargeRate,RemainingCapacity,Charging,Discharging,PowerOnline
$gpu = @()
try {
  $samples = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples
  $rows = foreach ($s in $samples) {
    if ($s.Path -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)') {
      [PSCustomObject]@{ luid = $Matches[1]; path = $s.Path; val = $s.CookedValue }
    }
  }
  $groups = $rows | Group-Object luid
  foreach ($g in $groups) {
    $isIntel = [bool]($g.Group | Where-Object { $_.path -match 'engtype_gsc' })
    $threeD = $g.Group | Where-Object { $_.path -match 'engtype_3d' }
    $util = if ($threeD) { ($threeD | Measure-Object val -Maximum).Maximum } else { 0 }
    $gpu += [PSCustomObject]@{ luid = $g.Name; isIntel = $isIntel; util = [math]::Round($util, 1) }
  }
} catch {}
[PSCustomObject]@{ battery = $battery; gpu = $gpu } | ConvertTo-Json -Depth 5 -Compress
`.trim();

function getWindowsTelemetry() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ battery: null, gpuIntel: null });
    // execFile (not exec) so the multi-line script reaches powershell.exe as a
    // single argument, bypassing cmd.exe's shell parsing (which mangles newlines).
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WIN_TELEMETRY_SCRIPT],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
      if (err || !stdout) return resolve({ battery: null, gpuIntel: null });
      try {
        const data = JSON.parse(stdout);
        let batteryRow = data.battery;
        if (Array.isArray(batteryRow)) batteryRow = batteryRow[0];
        const battery = batteryRow
          ? {
              voltageV: batteryRow.Voltage ? batteryRow.Voltage / 1000 : null,
              chargeRateW: batteryRow.ChargeRate ? batteryRow.ChargeRate / 1000 : 0,
              dischargeRateW: batteryRow.DischargeRate ? batteryRow.DischargeRate / 1000 : 0,
              remainingCapacityWh: batteryRow.RemainingCapacity ? batteryRow.RemainingCapacity / 1000 : null,
              charging: !!batteryRow.Charging,
              discharging: !!batteryRow.Discharging,
              acOnline: !!batteryRow.PowerOnline,
            }
          : null;

        let gpuRows = data.gpu;
        if (!gpuRows) gpuRows = [];
        if (!Array.isArray(gpuRows)) gpuRows = [gpuRows];
        const intelRow = gpuRows.find((r) => r.isIntel);
        const gpuIntel = intelRow ? { utilization: intelRow.util } : null;

        resolve({ battery, gpuIntel });
      } catch {
        resolve({ battery: null, gpuIntel: null });
      }
      }
    );
  });
}

let wmiBattery = null;
let gpuIntelUsage = null;
async function pollWinTelemetry() {
  const t = await getWindowsTelemetry();
  wmiBattery = t.battery;
  gpuIntelUsage = t.gpuIntel;
}
pollWinTelemetry();
setInterval(pollWinTelemetry, 4000);

// ---- NVIDIA discrete GPU telemetry via nvidia-smi (fast native binary) ----
let nvidiaGpu = null;
function pollNvidia() {
  return new Promise((resolve) => {
    const fields = 'utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm';
    exec(`nvidia-smi --query-gpu=${fields} --format=csv,noheader,nounits`, { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) {
        nvidiaGpu = null;
        return resolve();
      }
      const parts = stdout.trim().split('\n')[0].split(',').map((s) => parseFloat(s.trim()));
      const [util, memUsed, memTotal, power, temp, clock] = parts;
      nvidiaGpu = {
        utilization: isNaN(util) ? null : util,
        memUsedMB: isNaN(memUsed) ? null : memUsed,
        memTotalMB: isNaN(memTotal) ? null : memTotal,
        powerDrawW: isNaN(power) ? null : power,
        tempC: isNaN(temp) ? null : temp,
        clockMHz: isNaN(clock) ? null : clock,
      };
      resolve();
    });
  });
}
pollNvidia();
setInterval(pollNvidia, 2000);

// ---- static info & full specs, fetched once ----
let staticInfo = null;
let specs = null;
let resolveSpecsReady;
// The renderer asks for specs as soon as it loads, which can race ahead of
// this gathering step (several si.* calls) finishing. Callers await this
// instead of reading `specs` directly so they never get a premature null.
const specsReady = new Promise((resolve) => { resolveSpecsReady = resolve; });
async function loadStaticInfo() {
  const [osInfo, cpuInfo, memLayout, diskLayout, systemInfo, bios, baseboard, graphics] = await Promise.all([
    si.osInfo(),
    si.cpu(),
    si.memLayout().catch(() => []),
    si.diskLayout().catch(() => []),
    si.system().catch(() => ({})),
    si.bios().catch(() => ({})),
    si.baseboard().catch(() => ({})),
    si.graphics().catch(() => ({ controllers: [], displays: [] })),
  ]);
  staticInfo = { osInfo, cpuInfo };
  specs = {
    os: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      release: osInfo.release,
      kernel: osInfo.kernel,
      arch: osInfo.arch,
      hostname: osInfo.hostname,
      build: osInfo.build,
    },
    cpu: {
      manufacturer: cpuInfo.manufacturer,
      brand: cpuInfo.brand,
      cores: cpuInfo.cores,
      physicalCores: cpuInfo.physicalCores,
      performanceCores: cpuInfo.performanceCores,
      efficiencyCores: cpuInfo.efficiencyCores,
      speed: cpuInfo.speed,
      speedMax: cpuInfo.speedMax,
      cache: cpuInfo.cache,
      socket: cpuInfo.socket,
    },
    memorySticks: memLayout.map((m) => ({
      bank: m.bank,
      size: m.size,
      type: m.type,
      clockSpeed: m.clockSpeed,
      manufacturer: m.manufacturer,
      partNum: m.partNum,
    })),
    disks: diskLayout.map((d) => ({
      device: d.device,
      type: d.type,
      name: d.name,
      vendor: d.vendor,
      size: d.size,
      interfaceType: d.interfaceType,
    })),
    graphics: graphics.controllers.map((c) => ({
      vendor: c.vendor,
      model: c.model,
      vram: c.vram,
      vramDynamic: c.vramDynamic,
      driverVersion: c.driverVersion,
      bus: c.bus,
    })),
    displays: (graphics.displays || []).map((d) => ({
      model: d.model,
      main: d.main,
      builtin: d.builtin,
      connection: d.connection,
      resolutionX: d.resolutionX,
      resolutionY: d.resolutionY,
      currentRefreshRate: d.currentRefreshRate,
    })),
    system: {
      manufacturer: systemInfo.manufacturer,
      model: systemInfo.model,
      version: systemInfo.version,
    },
    bios: {
      vendor: bios.vendor,
      version: bios.version,
      releaseDate: bios.releaseDate,
    },
    baseboard: {
      manufacturer: baseboard.manufacturer,
      model: baseboard.model,
    },
  };
  resolveSpecsReady();
}

// ---- cached slow-changing data, refreshed on a longer interval ----
// si.processes()/cpuTemperature()/fsSize()/battery() are relatively expensive
// on Windows (they shell out to WMI), so they're refreshed less often than
// the cheap, in-process metrics (load/mem/network) that drive the live charts.
let slow = { processes: { list: [], all: 0, threads: 0 }, cpuTemp: { main: null }, fsSize: [], battery: {} };
async function pollSlow() {
  try {
    const [cpuTemp, fsSize, battery, processes] = await Promise.all([
      si.cpuTemperature().catch(() => ({ main: null })),
      si.fsSize().catch(() => []),
      si.battery().catch(() => ({})),
      si.processes().catch(() => ({ list: [], all: 0, threads: 0 })),
    ]);
    slow = { cpuTemp, fsSize, battery, processes };
  } catch {
    /* keep previous slow snapshot on failure */
  }
}

// ---- main polling loop (cheap, in-process metrics only) ----
async function pollStats() {
  try {
    if (!staticInfo) await loadStaticInfo();
    const { osInfo, cpuInfo } = staticInfo;
    const { cpuTemp, fsSize, battery, processes } = slow;

    const [cpu, mem, currentLoad, netStats, diskIO] = await Promise.all([
      si.cpuCurrentSpeed(),
      si.mem(),
      si.currentLoad(),
      si.networkStats(),
      si.disksIO().catch(() => null),
    ]);

    const net = netStats.reduce(
      (acc, n) => {
        acc.rx += n.rx_sec || 0;
        acc.tx += n.tx_sec || 0;
        return acc;
      },
      { rx: 0, tx: 0 }
    );

    const topProcs = processes.list
      .filter((p) => p.pid > 0)
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 60)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        cpu: p.cpu,
        mem: p.memRss ? p.memRss / 1024 : p.pmem, // MB if available
        memPct: p.pmem,
        command: p.command,
      }));

    const payload = {
      time: Date.now(),
      cpu: {
        load: currentLoad.currentLoad,
        perCore: currentLoad.cpus.map((c) => c.load),
        speed: cpu.avg,
        speedMax: cpu.max,
        cores: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores,
        brand: `${cpuInfo.manufacturer} ${cpuInfo.brand}`,
        temp: cpuTemp.main,
      },
      mem: {
        total: mem.total,
        used: mem.active,
        free: mem.available,
        swapTotal: mem.swaptotal,
        swapUsed: mem.swapused,
        cached: mem.cached,
      },
      disk: {
        volumes: fsSize.map((f) => ({
          mount: f.mount,
          use: f.use,
          size: f.size,
          used: f.used,
        })),
        readSec: diskIO ? diskIO.rIO_sec || 0 : 0,
        writeSec: diskIO ? diskIO.wIO_sec || 0 : 0,
      },
      net: {
        rx: net.rx,
        tx: net.tx,
        interfaces: netStats.length,
      },
      battery: {
        hasBattery: battery.hasBattery,
        percent: battery.percent,
        isCharging: battery.isCharging,
        acConnected: battery.acConnected,
        cycleCount: battery.cycleCount,
        designedCapacity: battery.designedCapacity,
        maxCapacity: battery.maxCapacity,
        currentCapacity: battery.currentCapacity,
        capacityUnit: battery.capacityUnit,
        voltage: battery.voltage,
        timeRemaining: battery.timeRemaining,
        model: battery.model,
        manufacturer: battery.manufacturer,
        type: battery.type,
        wmi: wmiBattery,
      },
      system: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        arch: osInfo.arch,
        hostname: osInfo.hostname,
      },
      processes: topProcs,
      processCount: processes.all,
      threadCount: processes.threads !== undefined ? processes.threads : processes.threadsCount,
      gpu: {
        discrete: nvidiaGpu,
        integrated: gpuIntelUsage,
      },
    };

    if (win && !win.isDestroyed()) {
      win.webContents.send('stats-update', payload);
    }
  } catch (e) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('stats-error', e.message);
    }
  }
}

ipcMain.handle('specs:get', async () => {
  await specsReady;
  return specs;
});

app.whenReady().then(async () => {
  await loadStaticInfo();
  await pollSlow();
  pollStats();
  setInterval(pollStats, 1500);
  setInterval(pollSlow, 3000);
});
