# dsh-stm32

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#known-limitations)
[![MCU](https://img.shields.io/badge/MCU-STM32%20family-4a6cf7)](#known-limitations)
[![version](https://img.shields.io/badge/version-0.1.8-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

Full-chain STM32 tooling distributed as a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin: 25 tools, 7 slash commands and one bundled SKILL covering toolchain probing → project scaffolding → `.ioc` editing (including clocks) → code generation → build → flash → debug → register read-back, plus serial interaction (Windows P1) and an in-session debug console panel.

The family profile is derived from `Mcu.Family` in the `.ioc`: pin names, SWD signal names, EXTI NVIC vector grouping, the openocd target and the hardware breakpoint/watchpoint budget all follow the family and its core.

| Capability | Coverage |
| --- | --- |
| Family profile | 27 families: C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / MP1 / MP2 / N6 / U0 / U3 / U5 / WB / WB0 / WBA / WL / WL3 |
| HAL scaffolding | 21 single-core families: C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / U0 / U3 / U5 / WBA / WL |
| Register scaffolding | 21 families, all passing the create→build matrix |
| Clock planning | 18 families; PLL1 on H5 / U5 / WBA / L4+ |
| `.ioc` peripheral presets | Derived from the CubeMX db: USART / TIM PWM / ADC |
| SVD names and bitfields | F1 |

Uncovered capabilities are refused with an explicit reason; no silent fallback to F1 tables.

**中文:** [README.md](./README.md)

[Quick start](#quick-start-minimal-end-to-end-check) · [Tool reference](#tool-reference) · [Slash commands](#slash-commands) · [Debug console](#debug-console-panel) · [Configuration](#configuration) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting)

## Why it exists

Most "AI writes STM32 code" setups stop at the source level: a `main.c` is produced, and whether it compiles, flashes and blinks is still verified by hand across CubeMX, a terminal and a debugger. The model cannot see the board, so it cannot be accountable for the result.

This plugin attaches the hardware side to DSH: the `.ioc` is readable and writable (transaction with rollback), code lands inside `USER CODE` blocks, generation and builds return real error lines, flashing is an independent path that never opens a debug session, and register state is read back after flashing. Every step returns structured evidence (`planId`, `file:line:col`, `Verified OK`, `GPIOC.ODR` bit13, rendered as `ODR13=1` when an SVD is available), which the model uses to decide the next step instead of guessing.

| Step | Manual flow | This plugin |
| --- | --- | --- |
| Scaffold | Configure clocks, pins and project settings in the GUI, generate CMake, hand-write `launch.json` | `stm32_project_create` produces a template project in about 2 s, byte-identical to the GUI output, with both `.vscode` configs in place |
| Reconfigure | Edit in the GUI, regenerate, hope `USER CODE` survives | `stm32_ioc_plan` emits a diff without writing → confirm → `stm32_ioc_apply` with SHA check, backup and rollback |
| Write code | Whole-file edits that can land in generated regions and vanish on regeneration | `stm32_code_patch` writes only inside `USER CODE` blocks; bytes outside are preserved |
| Build | Keil, or hand-maintained CMake and VS Code tasks | `/stm32-build [dir] [--clean]` |
| Flash | Keil, or a hand-written `tasks.json` calling openocd | `/stm32-debug [dir]` |
| Verify | Breakpoints and manual register inspection | `stm32_regs_read` reads state back: two `GPIOC.ODR` samples confirm the counter advances, `AFIO.MAPR` confirms SWD was not disabled by firmware |
| Debug | F5, manual breakpoints, close the session afterwards | `stm32_debug_run` halts at `main`, captures one snapshot and releases; continuous debugging uses `stm32_debug_session`, which closes when idle |

## Install

### Prerequisites

| Dependency | Purpose | Impact when missing |
| --- | --- | --- |
| dsh (bundle layer loadable) | Host | Plugin is not loaded |
| Node ≥ 20 | Build and tests | `npm run build` fails |
| `arm-none-eabi-gcc`, `arm-none-eabi-gdb` (or `gdb-multiarch`) | Compile and debug | `stm32_doctor` reports each missing item and where to install it |
| `openocd` | Flash and debug | Flash and debug unavailable; read-only tools unaffected |
| `cmake` + `ninja` | Build | `stm32_build` fails |
| STM32CubeMX (with bundled JRE) | `stm32_generate`, `stm32_project_create` | Generation tools unavailable; others unaffected |
| STM32Cube firmware package F1 (installed with CubeMX) | Copying Drivers during scaffolding | Reports "firmware package not found" |

### Install (recommended)

```powershell
dsh plugin --profile desktop add dsh-stm32
```

`dsh plugin` runs `pnpm add` inside the profile directory and appends `dsh-stm32` to `dsh.profile.bundles`; restart dsh to load it. Replace `desktop` with `web` to install into the web profile.

Verify: `dsh plugin --profile desktop why dsh-stm32` should print `0.1.8`; after restart `/stm32-doctor` responds.

Uninstall: `dsh plugin --profile desktop remove dsh-stm32`, then restart dsh.

### Bundled assets

Chip facts ship with the plugin: the mapping from part number to startup file, device macro and Flash/RAM size comes from `assets/device/<family>/chips.json` (75 files in core, 105 in full: chip tables, memory layouts, `.ioc` templates, linker scripts, SVD). Installation is offline-capable and needs no resource download. `stm32_assets verify` checks integrity; missing files usually indicate an incomplete installation.

### Install from source

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # typescript only
npm run build                       # tsc -> lib/, required before committing
npm test                            # optional: offline cases, no board needed
npm run test:pack                   # pack, unpack and scaffold a register project with the unpacked build
npm run test:size                   # size guards: tarball ≤ 3.9 MB, runtime assets ≤ 40 KB
```

When mounting a working copy into a profile, use `link:` rather than `file:`:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# append "dsh-stm32" to dsh.profile.bundles in that directory's package.json
# restart dsh afterwards (bundle layers load at process start only)
```

Reason: under `nodeLinker: hoisted`, `file:` copies the package into a real directory, so a freshly built `lib/` is never read by the host, which shows up as "code changed, behaviour unchanged". `link:` reads `lib/` live, but dsh still has to restart to reload the plugin. `github:` and npm installs are copies and require rebuilding and reinstalling.

## Quick start: minimal end-to-end check

This chain was verified on real hardware (acceptance A1, 2026-10-22), driven entirely by tool calls. It is a minimal check: every step uses the same tools, and blinking an LED is simply the cheapest sample.

| Step | Action | Tool | Measured |
| --- | --- | --- | --- |
| 1 | Probe: toolchain, occupied probes, ports, `.elf`, `.ioc` warnings | `stm32_doctor` | ≈2 s |
| 2 | Scaffold a CMake project in an empty directory (14 template files, 629 firmware files, `.ioc` with SWD configured) | `stm32_project_create` | ≈2 s |
| 3 | Run CubeMX headless; output lands in `Core/` | `stm32_generate` | 130–175 s first run; skipped (< 1 s) when nothing changed |
| 4 | Build (first run configures with `cmake --preset`) | `stm32_build` | ≈5 s configure + 3 s compile |
| 5 | Flash only: program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | Read `GPIOC.ODR` (or address `0x4001100C`) and confirm the state toggles | `stm32_regs_read` | 0.4–1.3 s |

Step 6 uses symbolic names, which rely on the bundled SVD tables (`assets/device/f1/svd/`, full layer). With core only, or an incomplete installation, reads still work with the address `0x4001100C`, but the report carries no register names or bitfields.

On the model side a single sentence suffices: "Create an STM32F103C8T6 blink project in `D:\work\blink`, build it and flash it". Manual execution uses:

```text
/stm32-doctor         # pre-flight check
/stm32-env            # show what the four capabilities are missing (works even with gaps)
/stm32-build          # build, print memory usage and errors
/stm32-flash          # flash only, no debug session
/stm32-debug          # flash and halt at main
/stm32-stop           # close the debug session and return the probe to VS Code
/stm32-setup          # probe plus install plan (installs after confirmation)
```

The minimal check covers scaffold → generate → build → flash → read-back; no step is blink-specific. Real projects follow the same chain, differing only in the number of peripherals in the `.ioc`, the number of `USER CODE` blocks and the code size.

| Real-project task | Path | Verification status |
| --- | --- | --- |
| Peripheral setup: GPIO / timers / USART / I2C / SPI / ADC / DMA / interrupts | `stm32_ioc_plan` (GPIO checked against the pin table; peripherals write `Mcu.IP*` / `Periph.*`) → `stm32_ioc_apply` → `stm32_generate` | GPIO, clocks and SWD measured; other peripherals use the same mechanism, not measured individually |
| Add HAL sources for new peripherals | Add `stm32f1xx_hal_<peripheral>.c` to `STM32_Drivers_Src` in `cmake/stm32cubemx/CMakeLists.txt`, or to `cmake/user/CMakeLists.txt` | Manual step: the plugin only places `Src/` and `Inc/`, never CubeMX-generated `cmake/**` |
| Multiple sources and custom modules | Write into `cmake/user/CMakeLists.txt` (placeholder provided) | Placeholder in place; not measured separately |
| Application code | `stm32_code_patch` writes per block and carries blocks back on regeneration | Measured (append / replace; an unknown tag lists all available tags) |
| Tuning, clock changes | `.ioc` transaction: diff → SHA check → backup → rollback on failure | Measured |
| Confirm peripherals run | `stm32_regs_read` reads any peripheral register by symbol (`TIM2.CNT`, `USART1.SR`, `ADC1.DR`) or address (`0x40000024`); naming only `GPIOC` dumps all its registers | Address form measured on hardware; symbolic names and bitfields verified against the bundled SVD with a fake probe, real-hardware retest pending (development notes §31.11) |
| Inspect a failure | `stm32_debug_run` halts at `main` once; continuous work uses `stm32_debug_session` + `stm32_debug_eval` | Measured (halted at `main () at main.c:67`) |

Boundaries are listed under [Known limitations](#known-limitations): HAL scaffolding covers 21 single-core families, register scaffolding 21 (validation board is C8T6), the host is verified on Windows only, the default probe is CMSIS-DAP, and new peripherals require manual HAL sources. Peripheral variety is not a tool limitation: whatever the `.ioc` can express follows the same chain; peripherals other than the blink sample have not been measured individually on hardware, so running `stm32_doctor` before starting a project is recommended.

## Tool reference

### Environment and projects

| Tool | Purpose |
| --- | --- |
| `stm32_doctor` | Read-only health check: toolchain completeness, leftover openocd/gdb processes, gdb port usage, `.elf` and `.ioc` status; per-chip capabilities and known issues |
| `stm32_route_plan` | Estimates HAL versus register cost for a specific project and requirement; separates auto-installable gaps from manual ones |
| `stm32_env_install` | Installs MSYS2 and toolchain components (gcc / gdb / openocd / cmake / ninja); plan only by default, executes with `dryRun:false` + `confirm:true`; PATH writes are user-level |
| `stm32_download` | Download without installing: J-Link direct link with SHA256; CubeMX / CubeProgrammer open the official page or validate a local file |
| `stm32_firmware_install` | Downloads and assembles STM32Cube firmware packages, official zip first, GitHub assembly as fallback; plan only by default |
| `stm32_assets` | Lists, verifies and prunes bundled assets (device facts, `.ioc` templates, linker scripts, startup files, SVD) |
| `stm32_cache` | Lists, verifies, fetches and prunes the download cache (register-route CMSIS templates) |
| `stm32_project_create` | Scaffolds a project: `route:"hal"` from templates plus firmware package, `route:"register"` without CubeMX; both emit `openocd.cfg` |
| `stm32_project_export` | Packs a project as a zip, excluding `build/`, `.dsh-stm32/`, `node_modules/`, `.git/` by default, optionally with prebuilt artifacts |

### `.ioc`: inspection and transactions

| Tool | Purpose |
| --- | --- |
| `stm32_ioc_inspect` | Read-only parse: part number, pins, signals, enabled peripherals, interrupts, clock tree, project settings, risk notes |
| `stm32_ioc_plan` | Computes a per-key diff without writing: peripheral presets, pins, interrupts, debug port, clock planning, bulk entries |
| `stm32_ioc_apply` | Applies a plan: source SHA check → backup → atomic replace; rollback from backup |
| `stm32_ioc_verify` | Has CubeMX diagnose the `.ioc`: compares CubeMX's understanding with the plan, exposing silently dropped peripherals and missing init calls |

### Code and build

| Tool | Purpose |
| --- | --- |
| `stm32_code_patch` | Writes only inside `USER CODE BEGIN/END` blocks, preserving all other bytes; backs up first |
| `stm32_generate` | Runs CubeMX headless, places output per ST layout, carries `USER CODE` back by tag; skips when `.ioc` is unchanged |
| `stm32_build` | Builds: infers build directory and `.elf`, returns error lines, warning count, FLASH/RAM usage; optional hex/bin |

### Flash, debug and runtime

| Tool | Purpose |
| --- | --- |
| `stm32_flash` | Flash only: openocd `program verify reset exit`, then releases the probe; checks Serial Wire first; failures return structured `probeError` (`kind` / `cause` / `hint` / `evidence` / `retryable`) |
| `stm32_debug_run` | Flashes, halts at `main`, captures registers, stack and locals, then resets, runs and releases the probe |
| `stm32_debug_session` | Opens a long-lived debug session (idle and total limits) for repeated `stm32_debug_eval` calls |
| `stm32_debug_eval` | Executes gdb commands in the session: variables, registers, backtrace, memory |
| `stm32_debug_stop` | Closes the session and releases the probe |
| `stm32_regs_read` | Reads registers by address or symbol, resolving bitfields when an SVD is present; halts to read, then resumes without resetting |
| `stm32_watch` | Registers and samples expressions (with deltas); `kind=write/read/access` installs hardware watchpoints within the data-comparator budget |
| `stm32_rtt` | RTT channel: control block in RAM, openocd exposes channel 0 as a TCP stream, 13-byte header decoded into level and timestamp |
| `stm32_serial` | Serial interaction (Windows): `list` / `open` / `read` / `send` / `transact` / `status` / `close` |

### RTT on the firmware side (shortest example)

```c
/* USER CODE BEGIN 0 */
static char rtt_buf[3][1024];
static void rtt_init(void) {
  /* Control block follows the SEGGER convention in RAM: acId / acName / three rings, see rtt.h in templates/ */
}
/* USER CODE END 0 */
```

The full implementation ships in `templates/`; channel count and ring size are controlled by `RTT_UP_CHANNELS` / `RTT_BUF_SIZE` (default 3×1 KB = 3 KB `.bss`; C8T6 has 20 KB RAM).

## Slash commands

| Command | Description |
| --- | --- |
| `/stm32-doctor` | Health check: toolchain, leftover processes, ports, `.elf` and `.ioc` warnings |
| `/stm32-env` | Toolchain check: what build / flash / debug / generate are missing, where things install, how to install |
| `/stm32-setup` | Probe → install plan → install after confirmation → self-check |
| `/stm32-build [dir] [--clean]` | Build (CMake + Ninja, `build/Debug` by default); `--clean` wipes first |
| `/stm32-flash [dir]` | Flash only: program + verify + reset, then release the probe |
| `/stm32-debug [dir]` | Flash and enter debugging, halted at `main`; then use `stm32_debug_eval` |
| `/stm32-stop` | Close the debug session and release the probe for VS Code F5 |

## Debug console (panel)

The in-session debug console (`conversation.view`, id `stm32-debug`) shows one timeline for both sides: the start, success, failure and duration of `stm32_*` calls, plus serial, RTT, watch, pin, clock, interrupt and `.ioc` state.

| Tab | Content | Actions |
| --- | --- | --- |
| Overview | Project, part number, SYSCLK, capacity, debug session, toolchain, build and flash, evidence usage, alert summary | Jump to failed events or the live channel, export an operation log as Markdown |
| Events | Call start and end, duration, slow-call marker, argument summary | Failures only, filter by tool, sort by duration, bulk quoting, JSONL export, event deep links |
| Live channels | Serial / RTT / watch output | Pause, clear, keyword filter, RTT level filter, send a serial line, persistent capture, export |
| Pins | Grouped by peripheral, by port, or as a package outline | Filter, copy references, inspect `.ioc` keys, CSV export |
| Clocks | Tree and flow views, per-node frequency and divider | Over-limit markers and "change to ÷N" advice computed from the parent clock |
| Interrupts | NVIC enablement, preemption and sub-priority | Filter, sort, edit in place, bulk edit |
| Faults | Raw failure events, rule decoding, grouping by rule | Category filter, copy group hint, CSV export |
| Artifacts | elf / hex / bin, size, SHA-256, capacity, build-to-build comparison | Copy checksums |
| Changes | `.ioc` differences against a baseline | Record a baseline, restore one key, restore all |

Data plane: 46 `/dsh-stm32/api/*` routes; the event stream uses SSE (`/events?since=<seq>&session=<id>`), replaying the buffer first and then streaming. Ring buffer holds 5000 events, each payload truncated to 8 KB; unflushed events are written every 30 seconds to `~/.dsh-stm32/evidence/<date>/<session>/events-<hhmmss>.jsonl`. Retention is configurable (flush interval, retention days and sessions) with environment variables taking precedence over configuration. Event sources are limited to this plugin's `stm32_*` calls.

## Serial (Windows P1)

`stm32_serial` exposes seven actions: `list` / `open` / `read` / `send` / `transact` / `status` / `close`. The implementation is a zero-dependency PowerShell 5.1 bridge (`System.IO.Ports`) that holds the COM port: 115200 8N1 by default, no flow control, DTR/RTS not asserted, `persist=false`, single session.

- Platform: Windows only. Linux and macOS return `unsupported-platform`.
- Ports: `list` enumerates available ports; parameters are remembered per USB serial number, so a different COM number still reuses them.
- Read: `read` accepts a cursor and returns only newer lines; byte-level data goes to `rx.ndjson`.
- Write: `send` writes one line; `transact` writes and waits for a matching reply (regular expression).
- Lifetime: the port closes at the end of a turn unless `persist=true`.

The reference validation board uses a CH340 (`1A86:7523`, COM5, 115200). The DAPLink virtual serial port on the same board (`c251:f001`, COM4) does not carry application data.

## Design notes

- **Own files only**: the `.ioc` goes through a transaction (plan → verify → backup → replace); generated regions receive only `USER CODE` content; no other generated file is modified.
- **Flash and debug are separate**: `stm32_flash` never opens a debug session and releases the probe immediately; debugging opens `stm32_debug_session` on demand and closes it when idle, so VS Code is not locked out.
- **Conclusions carry evidence**: failures return structured fields (compiler `file:line:col`, probe error class, register values) rather than vague prose.
- **Refuse when uncovered**: family profiles, clock planning, SVD coverage and openocd targets refuse explicitly with a reason when unavailable.
- **No host takeover**: the panel displays state and performs explicit project actions; it does not edit code or run Git operations.

## Configuration

### Config file (`~/.dsh-stm32/config.json`)

Toolchain locations are maintained by the plugin: `stm32_env_install` writes this file and later tools read it, with no dsh restart and no environment variables required. Manual editing is supported:

```json
{
  "version": 1,
  "msys64": "E:/msys64",
  "binDirs": [],
  "packages": ["mingw-w64-ucrt-x86_64-arm-none-eabi-gcc", "mingw-w64-ucrt-x86_64-cmake"],
  "cubeMxRoot": "",
  "updatedAt": "2026-02-01T00:00:00.000Z"
}
```

An empty `binDirs` derives `<msys64>/ucrt64/bin` from `msys64`. A corrupt file (invalid JSON) is treated as absent and does not break other features.

Precedence: tool arguments (`binDirs` / `cubeMxRoots`) > environment variables > config file > built-in defaults. Auto-discovered candidates are appended only after the explicitly named ones.

Built-in defaults contain no machine-specific paths, only Windows defaults such as `C:/msys64/...` and `C:/Program Files/...`. Directories named in configuration but absent on the machine (for example a config copied from another machine) are reported by the gate and `stm32_doctor`; the plugin never rewrites configuration and the installer never uses such a path as its target.

### Settings panel

The "STM32 toolchain" page under DSH settings (bundled browser panel, same origin as the host, no extra dependencies) offers three cards:

- **Locations**: reads and saves `msys64` / `cubeMxRoot` / extra `binDirs`; the next tool call sees the change.
- **Missing pieces**: runs a probe (version commands only) and lists path, version and `hint` per item, plus badges for build / flash / debug / generate.
- **Install toolchain**: emits a plan first (steps, download size, PATH and config changes), executes after confirmation, and streams steps with a log tail using the same installer as `stm32_env_install`.

The panel artifact is `lib/client.js`; the source is `client/client.js`, copied by `npm run build`. When the host exposes no `webServer`, this layer is skipped and tools plus slash commands stay unaffected.

### Download cache and firmware packages

- Register-route CMSIS templates are downloaded on first use into the cache (default `%LOCALAPPDATA%\dsh-stm32\cache`) and reused afterwards; every file pins an upstream sha256 and mismatches are rejected. `stm32_cache` lists, verifies, fetches and prunes entries.
- The HAL route uses locally installed CubeMX firmware packages: F1 defaults to `STM32Cube_FW_F1_V1.8.7`, other families use the highest installed version; `firmwarePackage` overrides. When missing, install it through the CubeMX package manager or use `stm32_firmware_install`.
- `stm32_download` only downloads or verifies installers (default directory `%LOCALAPPDATA%\dsh-stm32\downloads`); it never executes them and never requests administrator rights.

### Environment variables (optional)

| Variable | Purpose | Default |
| --- | --- | --- |
| `STM32_BIN_DIRS` | Toolchain directory candidates, `;`-separated, replaces the built-in list entirely (auto-discovery still appends) | `C:/msys64/ucrt64/bin`, `C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | CubeMX root, replaces the built-in list | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | Set to `1` to disable auto-discovery (CI, built-in list only) | unset |
| `DSH_STM32_CONFIG` | Alternate config file path | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | Set to `1` to ignore the config file entirely | unset |
| `DSH_STM32_CACHE` | Download cache root, supports `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_DOWNLOADS` | Installer download directory, supports `~` | `%LOCALAPPDATA%\dsh-stm32\downloads` |
| `DSH_STM32_HOME` | Plugin data root (config, evidence, snapshots, memo) | `%USERPROFILE%\.dsh-stm32` |
| `DSH_STM32_ASSETS` | Asset directory override (development) | bundled `assets/` |
| `DSH_STM32_FACTS` | Device fact directory override (development) | bundled `assets/device` |
| `DSH_STM32_EVIDENCE` | Evidence directory override | `~/.dsh-stm32/evidence` |
| `DSH_STM32_EVIDENCE_FLUSH_SECONDS` | Flush interval (5–3600 s) | 30 |
| `DSH_STM32_EVIDENCE_KEEP_DAYS` | Evidence retention in days (0–365, 0 = keep) | 7 |
| `DSH_STM32_EVIDENCE_KEEP_SESSIONS` | Evidence retention in sessions (1–200) | 20 |
| `DSH_STM32_SNAPSHOTS` | `.ioc` baseline directory | `~/.dsh-stm32/ioc-snapshots` |
| `DSH_STM32_JLINK_URL` | J-Link installer URL override; requires `DSH_STM32_JLINK_SHA256` | SEGGER official link |
| `DSH_STM32_JLINK_SHA256` | Override hash | official hash |
| `DSH_STM32_SERIAL_BRIDGE` / `DSH_STM32_SERIAL_POWERSHELL` | Serial bridge script and PowerShell path overrides | bundled bridge / `powershell.exe` |
| `DSH_STM32_OFFLINE` | Set to `1` to forbid network downloads (cache only) | unset |
| `DSH_STM32_PYTHON` | Python interpreter for helper parsing | auto-detected |
| `MSYS2_INSTALLER_URL` / `MSYS2_INSTALLER_SHA256` | Installer URL and hash overrides; must be set together | official pinned release |
| `MSYS2_MIRROR` | Installer directory override; requires a hash | official release → TUNA → NJU → Aliyun |

Tool arguments mirror these variables: flash and debug tools accept `binDirs`, `elfPath`, `buildDir`, `configFile`, `adapterSpeed`; generation and scaffolding accept `cubeMxRoots`, `firmwarePackage`.

Auto-discovery (usually nothing to configure): when `binDirs` / `STM32_BIN_DIRS` are absent, the plugin scans common locations and appends results to the candidate list.

- Toolchains: `ucrt64/bin`, `mingw64/bin` and `clang64/bin` under `<drive>/msys64`, `<drive>/msys2`, `<drive>/app/msys64`, `<drive>/tools/msys64`, `%LOCALAPPDATA%/Programs/msys64` (the directory must contain `arm-none-eabi-gcc.exe`, `openocd.exe` or `cmake.exe`).
- CubeMX: the `STM32CubeMX_PATH` environment variable, uninstall key `DisplayIcon` / `UninstallString`, and `STM32CubeMX` under `<drive>/`, `<drive>/app`, `<drive>/tools`, `Program Files\STMicroelectronics\STM32Cube`, `%LOCALAPPDATA%/Programs` (requires both `STM32CubeMX.exe` and `jre/bin/java.exe`).

A scan takes about 1 s and is cached per process. Explicit `binDirs` / `cubeMxRoots` disable appending. Environment paths are normalised (quotes stripped, backslashes converted, duplicate slashes collapsed). When tools are missing, errors and `stm32_doctor` notes list the directories that were checked.

### openocd.cfg (project-level, takes precedence)

CMSIS-DAP (default):

```text
source [find interface/cmsis-dap.cfg]
source [find target/stm32f1x.cfg]
adapter speed 4000
```

ST-Link:

```text
source [find interface/stlink.cfg]
transport select hla_swd
source [find target/stm32f1x.cfg]
```

Without `openocd.cfg`, the target comes from `Mcu.Family` in the `.ioc` (F1 → `target/stm32f1x.cfg`, F4 → `target/stm32f4x.cfg`, G4 → `target/stm32g4x.cfg`; L4 and L4+ share `stm32l4x`). C0 / U0 have no official scripts in openocd 0.12; the plugin ships adapted versions and copies them into the project's `openocd/` directory during scaffolding. H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 have no scripts, so flashing is refused explicitly.

### Two hard requirements on the `.ioc`

1. **SYS debug port set to Serial Wire** (PA13 = `SYS_JTMS-SWDIO`, PA14 = `SYS_JTCK-SWCLK`); use `stm32_ioc_plan` with `serialWire: true` when missing.
2. **`ProjectManager.KeepUserCode=true`**; otherwise `USER CODE` content is lost on regeneration.

## Known limitations

| Limitation | Detail | Handling |
| --- | --- | --- |
| Verified on Windows only | `stm32_generate` depends on `<CubeMX>/STM32CubeMX.exe` and `jre/bin/java.exe` | None yet; flash, debug and register reads may work elsewhere with a complete openocd/gdb, unverified |
| C0 / U0 target scripts ship with the plugin | openocd 0.12 lacks `stm32c0x.cfg` / `stm32u0x.cfg`; adapted versions are bundled | Scripts load fully; no real-board flashing evidence |
| HAL scaffolding covers 21 single-core families | Dual-core WB, MP1 / MP2 / N6, WB0 / WL3 are out of scope | Uncovered families are refused explicitly; `stm32_assets verify` locates missing files |
| Depth is graded per family | 27 family profiles; HAL 21, register 21, clocks 18, SVD F1 only | Missing capability is refused with a reason |
| Probes selected from what USB reports | ST-Link → `stlink-dap.cfg`, DAPLink / CMSIS-DAP → `cmsis-dap.cfg`, J-Link → `jlink.cfg`; a project `openocd.cfg` wins | Write `openocd.cfg` to pin a choice |
| New peripherals need manual HAL sources | The plugin places only `Src/` and `Inc/`; CubeMX-generated `cmake/**` is not carried over | Edit `STM32_Drivers_Src` or write into `cmake/user/CMakeLists.txt` |
| Generation and scaffolding need CubeMX plus the family firmware package | F1 defaults to `STM32Cube_FW_F1_V1.8.7` | Pass `firmwarePackage`, or install the package first |
| RTT is channel 0 only with a custom frame | 13-byte header (4 B length, 1 B level, 8 B timestamp, UTF-8 text); neither defmt nor raw SEGGER bytes | Filter by `level`; put structured data in `text`; channels and ring size in `rtt.h` |
| Serial is Windows-only (P1) | PowerShell 5.1 + `System.IO.Ports` bridge; no streaming UI, no auto-reconnect, one port at a time | Use a system serial tool, or a later release |
| Register symbols and bitfields need the bundled SVD | Covers F1 lines 100 / 101 / 102 / 103 / 105 / 107 | Use `0x` addresses; check installation with `stm32_assets verify` |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Plugin not loaded | `dsh.profile.bundles` lacks `dsh-stm32`, or dsh was not restarted | Reinstall and restart; verify with `dsh plugin --profile desktop why dsh-stm32` |
| Code changes have no effect | Installed via `file:`, so the host reads a copy | Switch to `link:`, rebuild with `npm run build`, restart dsh |
| `stm32_doctor` reports a missing toolchain | Not installed, or path not discovered | `/stm32-setup` for an install plan, or set `binDirs` |
| Flash reports the probe is busy | Another debugger (VS Code, leftover openocd) holds the probe | `/stm32-stop`, close other debuggers, retry; `stm32_doctor` lists leftover processes |
| SWD is lost after flashing | `.ioc` did not enable Serial Wire | Add `serialWire: true` via `stm32_ioc_plan`, regenerate, flash again |
| Generated peripherals are silently dropped | `.ioc` keys inconsistent with peripheral derivation | Run `stm32_ioc_verify` for a CubeMX-side diagnosis |
| Panel is blank or stale | Server-side change without restart, or `lib` newer than the process | Fully exit dsh and start again; the status bar flags "new build available" |
| No serial data | Wrong port (for example the DAPLink virtual port) | Confirm with `stm32_serial list`; application serial usually lives on a CH340-class adapter |

## Development and testing

| Command | Purpose |
| --- | --- |
| `npm run build` | `tsc` into `lib/`, copying client and data assets |
| `node test/run-units.mjs` | Offline unit tests: 80 suites / 1088 cases, no board required |
| `node .dsh-stm32/acceptance.mjs` | Local acceptance script: panel API, event stream, evidence, artifacts, faults, interrupts, serial, probe |
| `npm run test:pack` | Pack, unpack and scaffold a register project with the unpacked build |
| `npm run test:size` | Package and asset guards |

Release shape: published content is limited to `files` in `package.json` (`lib`, `client`, `templates`, `assets`, `docs/reading-guide.md`, `cordis.patch.yml`, both READMEs, `LICENSE`). `docs/`, `test/` and `scripts/` stay out of the package; release text is not stored in the repository and is provided per release.

## Repository layout

```text
src/
  index.ts          plugin entry: tools, slash commands, panel API, SKILL
  tools/            registration and argument validation for 25 tools
  engine/           engines: project, .ioc, generation, build, flash, debug, events, panel API
  data/             device facts, CubeMX db, clocks, search roots, toolchain config
  commands/         7 slash commands
  skill/            bundled stm32-workflow SKILL
client/client.js    panel source (plain JS + react, no bundler)
lib/                tsc output and copied assets (published)
assets/             device facts, .ioc templates, linker scripts, startup files, SVD
templates/          scaffolding templates, register route, serial bridge, RTT
test/               80 offline suites and e2e scripts
scripts/            build, pack, size and smoke scripts
docs/               development notes, reading guide, spec, diagrams
```

## Documentation

- [Specification](docs/dsh-stm32-plugin-规格.md): tool contracts, state machine, acceptance criteria A1–A13
- [Development notes](docs/development-notes.md): milestones, host-contract issues, per-tool implementation details and measurements
- [Source reading guide](docs/reading-guide.md): layered reading order, per-file responsibilities and exports, diagrams and invariants
- Release notes: provided per release on the release page; history lives in git and the development notes
- Visuals: [architecture](docs/diagrams/dsh-stm32-architecture.html) / [main journey](docs/diagrams/dsh-stm32-journey.html) — single-file HTML, opens offline

## License

[MIT](LICENSE)
