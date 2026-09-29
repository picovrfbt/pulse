# Pulse

A live system monitor for Windows, styled after [TMOG](https://tmog.org) — dark, graph-heavy, and built as a real Electron desktop app rather than a mockup.

## Features

- **Summary** — CPU, Memory, GPU (discrete + integrated), Disk, Network, Power Draw, Battery, and Thermal at a glance, each with a live sparkline
- **Performance** — TMOG-style metric list with a big detailed chart per metric, per-core CPU bars, and GPU memory/clock/temperature
- **Processes** — sortable, searchable process table with an "End task" action
- **Power & Battery** — live battery charge/discharge wattage (via the Windows battery WMI class), voltage, cycle count, and design-vs-full capacity health
- **About This PC** — full hardware specs: CPU, RAM, both GPUs, storage, displays, motherboard/BIOS, OS

## GPU monitoring

- Discrete NVIDIA GPU stats come from `nvidia-smi` (utilization, memory, power draw, temperature, clock).
- Integrated Intel GPU utilization comes from Windows' own "GPU Engine" performance counters — the same source Task Manager's GPU tab uses — identified by its Intel-only engine type.

## Running it

```bash
npm install
npm start
```

Windows only (battery wattage and GPU Engine counters are read via WMI/PowerShell). CPU/Memory/Disk/Network work cross-platform via [systeminformation](https://systeminformation.io/), but power/GPU telemetry currently assumes Windows.
