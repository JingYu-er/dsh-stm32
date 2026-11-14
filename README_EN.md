# dsh-stm32

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#known-limitations)
[![MCU](https://img.shields.io/badge/MCU-STM32%20family-4a6cf7)](#known-limitations)
[![version](https://img.shields.io/badge/version-0.1.8-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

Full-chain STM32 tooling distributed as a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin: 39 tools, 7 slash commands and one bundled SKILL that hand the chain "probe toolchain → scaffold a project → edit `.ioc` (clocks included) → generate code → build → flash → debug → read registers back" to the model, plus serial interaction (Windows) and an in-session debug console panel.

Within the supported range the same tools behave the same way from F1 to H7; for an unsupported family or capability the call states what is missing instead of returning a guessed result.

| Capability | Coverage |
| --- | --- |
| Chip families | 27 families: C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / MP1 / MP2 / N6 / U0 / U3 / U5 / WB / WB0 / WBA / WL / WL3 |
| HAL scaffolding | 21 single-core families: C0 / F0 / F1 / F2 / F3 / F4 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L4+ / L5 / U0 / U3 / U5 / WBA / WL |
| Register scaffolding | 21 families, all passing the create→build matrix |
| Clock planning | 18 families; PLL1 on H5 / U5 / WBA / L4+ |
| `.ioc` peripheral presets | Derived from official CubeMX data: USART / TIM PWM / ADC |
| Register names and bitfields | F1 |

**中文:** [README.md](./README.md)

[Quick start](#quick-start-minimal-end-to-end-check) · [Tool reference](#tool-reference) · [Slash commands](#slash-commands) · [Debug console](#debug-console-panel) · [Configuration](#configuration) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting)

## What it does

Most "AI writes STM32 code" setups stop at the source level: a `main.c` is produced, and whether it compiles and blinks is still confirmed by hand across CubeMX, a terminal and a debugger. The model cannot see the board, so it cannot be accountable for the result.

This plugin puts the hardware side inside DSH: the `.ioc` is readable and writable (transaction with rollback), code goes only into `USER CODE` blocks, generation and builds return real error lines, flashing never holds the probe a debugger needs, and register state is read back after flashing. Every step returns something checkable (a plan id, `file:line:col`, `Verified OK`, bit13 of `GPIOC.ODR`, reported as `ODR13=1` when register tables are present), which the model uses to decide the next step.

| Step | Manual flow | This plugin |
| --- | --- | --- |
| Scaffold | Configure clocks, pins and project settings in the GUI, generate CMake, hand-write `launch.json` | `stm32_project_create` produces a template project in about 2 s, matching CubeMX GUI output, with both `.vscode` configs in place |
| Reconfigure | Edit in the GUI, regenerate, hope `USER CODE` survives | `stm32_ioc_plan` shows the diff without writing → confirm → `stm32_ioc_apply` with checks, backup and rollback |
| Write code | Whole-file edits that can land in generated regions and vanish on regeneration | `stm32_code_patch` writes only inside `USER CODE` blocks; bytes outside are preserved |
| Build | Keil, or hand-maintained CMake and VS Code tasks | `/stm32-build [dir] [--clean]` |
| Flash | Keil, or a hand-written `tasks.json` calling openocd | `/stm32-flash [dir]` |
| Verify | Breakpoints and manual register inspection | `stm32_regs_read` reads state back: two `GPIOC.ODR` samples confirm the counter advances, `AFIO.MAPR` confirms firmware did not disable SWD |
| Debug | F5, manual breakpoints, close the session afterwards | `stm32_debug_run` halts at `main`, captures one snapshot and releases the probe; continuous work uses `stm32_debug_session`, which closes when idle |

## Install

### Install the plugin

Only DSH itself is required at this point; the toolchain can be added later.

```powershell
dsh plugin --profile desktop add dsh-stm32
```

`dsh plugin` runs `pnpm add` inside the profile directory and appends `dsh-stm32` to that profile's `dsh.profile.bundles`. Exit DSH completely and start it again afterwards; bundle layers load at process start only.

- Verify: `dsh plugin --profile desktop why dsh-stm32` prints `0.1.8`
- Uninstall: `dsh plugin --profile desktop remove dsh-stm32`, then restart DSH
- Web profile: replace `desktop` with `web`

### Add the toolchain

With the plugin installed, parsing `.ioc` files, inspecting pins / clocks / interrupts and previewing plans all work already. Compilers and probe tools are needed only when building, flashing or debugging.

| Task | Requires | How to add |
| --- | --- | --- |
| Build | `arm-none-eabi-gcc`, `cmake`, `ninja` | `/stm32-setup` installs everything (MSYS2 plus toolchain, about 300 MB); a manual installation is discovered automatically |
| Flash, debug | `openocd`, `arm-none-eabi-gdb` (or `gdb-multiarch`), a CMSIS-DAP / ST-Link probe | Same command; probe drivers are supplied by the OS |
| Generate code, scaffold HAL projects | STM32CubeMX (with bundled JRE) and its firmware package | Install CubeMX from the ST website (ST account required); the plugin locates it automatically; install firmware packages in the CubeMX package manager |

When the missing piece is unclear, check the diagnosis first:

```text
/stm32-env      # what build / flash / debug / generate are missing, where things install, how to install
/stm32-setup    # plan first, install after confirmation, self-check when done
```

`/stm32-env` works with no toolchain at all: it only runs version queries and writes nothing.

### Pre-flight check

```text
/stm32-doctor
```

Read-only checks: toolchain completeness, leftover openocd / gdb processes holding the probe, gdb port usage, whether `.elf` and `.ioc` exist in the project, and whether the `.ioc` has a configuration that would lose SWD after flashing.

### Bundled assets

The mapping from part number to startup file, device macro and Flash / RAM size ships with the plugin, together with `.ioc` templates, linker scripts and register tables. Everything works offline after installation; no resource download is involved. `stm32_assets verify` checks integrity and points to a reinstall when files are missing.

### Install from source

Only for development or when the code itself must change. Build and test commands are listed under [Development and testing](#development-and-testing).

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # typescript only
npm run build                      # tsc -> lib/, required before committing
```

Mount a working copy with `link:`, not `file:`:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# append "dsh-stm32" to dsh.profile.bundles in that directory's package.json
# restart dsh afterwards (bundle layers load at process start only)
```

Reason: under `nodeLinker: hoisted`, `file:` copies the package into a real directory, so a freshly built `lib/` is never read by the host, which shows up as "code changed, behaviour unchanged". `link:` reads `lib/` from the working copy; DSH still has to restart to reload the plugin.

## Quick start: minimal end-to-end check

This chain was verified on real hardware, driven entirely by tool calls. Every step uses the same tools; blinking an LED is simply the cheapest sample.

| Step | Action | Tool | Measured |
| --- | --- | --- | --- |
| 1 | Probe: toolchain, occupied probes, ports, `.elf`, `.ioc` warnings | `stm32_doctor` | about 2 s |
| 2 | Scaffold a CMake project in an empty directory (`.ioc` with SWD configured) | `stm32_project_create` | about 2 s |
| 3 | Run CubeMX headless; output lands in `Core/` | `stm32_generate` | 130–175 s first run; skipped (< 1 s) when nothing changed |
| 4 | Build (first run configures with `cmake --preset`) | `stm32_build` | about 5 s configure + 3 s compile |
| 5 | Flash only: program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | Read `GPIOC.ODR` (or address `0x4001100C`) and confirm the state toggles | `stm32_regs_read` | 0.4–1.3 s |

Step 6 uses symbolic names, which rely on the bundled register tables. With an incomplete installation the address form `0x4001100C` still works, but the report carries no register names or bitfields.

On the model side a single sentence suffices: "Create an STM32F103C8T6 blink project in `D:\work\blink`, build it and flash it".

The minimal check covers scaffold → generate → build → flash → read-back; no step is blink-specific. Real projects follow the same chain, differing only in the number of peripherals in the `.ioc`, the number of `USER CODE` blocks and the code size.

| Real-project task | Path | Verification status |
| --- | --- | --- |
| Peripheral setup: GPIO / timers / USART / I2C / SPI / ADC / DMA / interrupts | `stm32_ioc_plan` (GPIO checked against the pin table) → `stm32_ioc_apply` → `stm32_generate` | GPIO, clocks and SWD measured on hardware; other peripherals use the same mechanism, not measured individually |
| Add HAL sources for new peripherals | Add `stm32f1xx_hal_<peripheral>.c` to `STM32_Drivers_Src` in `cmake/stm32cubemx/CMakeLists.txt`, or write into `cmake/user/CMakeLists.txt` | Manual step: the plugin places only `Src/` and `Inc/`, never CubeMX-generated `cmake/**` |
| Multiple sources and custom modules | Write into `cmake/user/CMakeLists.txt` (placeholder provided) | Placeholder in place; not measured separately |
| Application code | `stm32_code_patch` writes per block and carries blocks back on regeneration | Measured (append / replace; an unknown tag lists all available tags) |
| Tuning, clock changes | `.ioc` transaction: diff → checks → backup → rollback on failure | Measured |
| Confirm peripherals run | `stm32_regs_read` reads any peripheral register by symbol (`TIM2.CNT`, `USART1.SR`, `ADC1.DR`) or address (`0x40000024`); naming only `GPIOC` dumps all its registers | Address form measured on hardware; symbolic names and bitfields being retested |
| Inspect a failure | `stm32_debug_run` halts at `main` once; continuous work uses `stm32_debug_session` + `stm32_debug_eval` | Measured (halted at `main () at main.c:67`) |

Boundaries are listed under [Known limitations](#known-limitations): HAL scaffolding covers 21 single-core families, register scaffolding 21 (validation board is C8T6), the host is verified on Windows only, the default probe is CMSIS-DAP, and new peripherals need manual HAL sources. Peripheral variety is not a tool limitation: whatever the `.ioc` can express follows the same chain; peripherals other than the blink sample have not been measured individually on hardware, so running `/stm32-doctor` before starting a project is recommended.

## Tool reference

### Environment and projects

| Tool | Purpose |
| --- | --- |
| `stm32_doctor` | Read-only health check: toolchain completeness, leftover openocd / gdb processes, gdb port usage, `.elf` and `.ioc` status; per-chip capabilities and known issues |
| `stm32_route_plan` | Estimates HAL versus register cost for a specific project and requirement; separates auto-installable gaps from manual ones |
| `stm32_env_install` | Installs MSYS2 and toolchain components (gcc / gdb / openocd / cmake / ninja); plan only by default, executes with `dryRun:false` + `confirm:true`; writes user-level PATH only, no administrator rights |
| `stm32_download` | Download without installing: J-Link direct link with checksum; CubeMX / CubeProgrammer open the official page or validate a local file |
| `stm32_firmware_install` | Downloads and assembles STM32Cube firmware packages, official archive first, GitHub assembly as fallback; plan only by default |
| `stm32_assets` | Lists, verifies and prunes bundled assets (chip data, `.ioc` templates, linker scripts, startup files, register tables) |
| `stm32_cache` | Lists, verifies, fetches and prunes the download cache (register-route CMSIS templates) |
| `stm32_project_create` | Scaffolds a project: `route:"hal"` from templates plus firmware package, `route:"register"` without CubeMX; both emit `openocd.cfg` |
| `stm32_project_export` | Packs a project as a zip, excluding `build/`, `.dsh-stm32/`, `node_modules/`, `.git/` by default, optionally with prebuilt artifacts |

### `.ioc`: inspect and edit

| Tool | Purpose |
| --- | --- |
| `stm32_ioc_inspect` | Read-only parse: part number, pins, signals, enabled peripherals, interrupts, clock tree, project settings, risk notes |
| `stm32_ioc_plan` | Computes a per-key diff without writing: peripheral presets, pins, interrupts, debug port, clock planning, bulk entries |
| `stm32_ioc_apply` | Applies a plan: source checks → backup → atomic replace; rollback from backup |
| `stm32_ioc_verify` | Has CubeMX re-read the `.ioc` and points out silently dropped peripherals and missing init calls |

### Diagram rules

The diagram is a functional frame, not a per-component schematic:

- Groups: MCU, NFC antenna and tag, optical sensing, power, debug interface, keys; links inside a group are not drawn.
- Links only between groups; labels collapse to bus names such as I2C, SPI, UART, ADC, LED, PWM, SWD.
- Power nets (VCC, GND) are listed separately and never drawn; nets with too many endpoints are left out.
- Layout is generated by the plugin: MCU in the middle, modules around it, links leave the side facing the peer and stay straight when they can.

The same rules ship in the plugin skill text, so reading and drawing the diagram use one convention.

### Schematic (KiCad 10)

| Tool | Purpose |
| --- | --- |
| `stm32_sch_read` | Read a KiCad project: sheet tree, components, nets, power nets and a block diagram (which circuits connect, over which bus) |
| `stm32_sch_pins` | MCU pin matrix: net name, pin type, whether the pin is left open, plus reusable signal candidates from the CubeMX database |
| `stm32_sch_check` | Check the schematic itself and reconcile it with `.ioc` and `.kicad_pcb`: missing values, missing footprints, missing SWD / BOOT0 / power, split nets |
| `stm32_sch_to_ioc` | Turn pin connections into a `.ioc` draft: suggested signal, confidence and candidates per pin, input/output hints for plain GPIO nets, plus a software-emulation fallback with its cost when no hardware function fits; read-only, never writes `.ioc` |

Scope is KiCad 10 (`version 20260306`). Symbol libraries are embedded in the sheets, so KiCad does not need to be installed and `sym-lib-table` is not read; only sheets referenced from the root sheet are parsed, and `.history/` plus other historical versions are ignored. Reconciliation is based on connectivity: pads on one PCB net must belong to one schematic net, and name differences are reported as hints only. The tools are read-only: the schematic and the project configuration are never modified. A draft from `stm32_sch_to_ioc` only lands on disk through `stm32_ioc_plan`, and pins that match no library signal are listed for confirmation.

### Circuit design (tscircuit + KiCad)

Write circuits under `hardware/` with tscircuit, export a real KiCad project, then verify it with KiCad's own checkers. Checks follow JLCPCB's standard process: track width and clearance ≥ 0.2 mm, drill ≥ 0.3 mm, silkscreen text height ≥ 0.8 mm. The rules are written into the project's `.kicad_dru`, so the report answers "can this be fabbed in that tier", together with a prototype cost estimate.

| Tool | Purpose |
| --- | --- |
| `stm32_ecad_init` | Create `hardware/{circuit,kicad,libs,out}` with a minimal `package.json`; dependencies are installed there with `npm install` |
| `stm32_ecad_build` | Run `tsci build` with KiCad's bundled bun: `.circuit.tsx` → `circuit.json`, SVGs and `kicad/*.kicad_sch|.kicad_pcb`; with `footprint="kicad:…"` it also renames generated `tscircuit:` names back to the real library and copies the official footprints into `hardware/libs`; JLC footprints (`footprint="jlcpcb:C…"`) are vendored into the library per reference and recorded in `libs/sources.json` |
| `stm32_ecad_check` | Export the project libraries first, then run `kicad-cli sch erc` and `pcb drc`, collapsing violations into rule, severity and affected items; unnamed nets are reported too |
| `stm32_ecad_libs` | Extract embedded footprints and symbols into real libraries under `hardware/libs` and fill in `fp-lib-table` / `sym-lib-table` |
| `stm32_ecad_step` | Export STEP into `hardware/out`; resolves models through official 3D dir → `hardware/libs/3d` → cache and rewrites their paths; missing models are reported, not fatal |
| `stm32_ecad_export` | Export Gerbers, drill files, pick-and-place coordinates and STEP into `hardware/out` in one go |
| `stm32_ds_fetch` | Fetch non-STM32 datasheets into the local cache: by LCSC code, for every part used by the project, or from a manually imported PDF |
| `stm32_ds_list` | List the local datasheet cache: code, MPN, size, fetch time and source |
| `stm32_pdf_read` | Read a PDF: `info` for page count and text layer, `text` for page text (layout preserved), `figures` to list figures, `table` to cut parameter tables into rows and columns, `render` to rasterise a page or region into PNG for visual reading |
| `stm32_ecad_package` | Pack `hardware/` into a deliverable zip (skips `node_modules`, `dist`, `.history`) and read it back to self-check |

There is exactly one writer: `.kicad_sch` / `.kicad_pcb` are produced by tscircuit and only read by the plugin. tscircuit embeds symbols and footprints in the project under generated names such as `tscircuit`, so checks first export them into real libraries under `hardware/libs` and complete the library tables; otherwise the report is dominated by "library not in configuration" noise. Unnamed nets (`.R1 > .pin1 to .C1 > .pin1`) are listed separately with the `<net name="VDD" />` fix. Building requires KiCad 10 and its bundled `bun.exe`; the first `npm install` is about 730 MB and later builds usually take 15–40 seconds. Prefer KiCad's own libraries (`footprint="kicad:..."`) and fall back to JLCPCB part numbers only when needed.

### Code and build

| Tool | Purpose |
| --- | --- |
| `stm32_code_patch` | Writes only inside `USER CODE BEGIN/END` blocks, preserving all other bytes; backs up first |
| `stm32_generate` | Runs CubeMX headless, places output in `Core/`, carries `USER CODE` back by tag; skips when `.ioc` is unchanged |
| `stm32_build` | Builds: infers build directory and `.elf`, returns error lines, warning count, FLASH / RAM usage; optional hex / bin |

### Flash, debug and runtime

| Tool | Purpose |
| --- | --- |
| `stm32_flash` | Flash only: program + verify + reset, then releases the probe; checks Serial Wire first; failures return the probe error class and a suggested action |
| `stm32_debug_run` | Flashes, halts at `main`, captures registers, stack and locals, then resets, runs and releases the probe |
| `stm32_debug_session` | Opens a long-lived debug session (idle and total limits) for repeated `stm32_debug_eval` calls |
| `stm32_debug_eval` | Executes gdb commands in the session: variables, registers, backtrace, memory |
| `stm32_debug_stop` | Closes the session and releases the probe |
| `stm32_regs_read` | Reads registers by address or symbol, resolving bitfields when register tables are present; pauses briefly to read, then resumes without resetting |
| `stm32_watch` | Registers and samples expressions (with deltas); `kind=write/read/access` installs hardware watchpoints, limited by the chip's watchpoint count |
| `stm32_rtt` | RTT channel: firmware keeps the control block in RAM, the host reads it through openocd, output carries level and timestamp |
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

## PDF reading and the datasheet cache

`stm32_pdf_read` needs poppler (`pdftotext` / `pdfinfo` / `pdftoppm`):

```
pacman -S --needed mingw-w64-ucrt-x86_64-poppler
```

`stm32_doctor` reports the version. Modes: `info` (pages, paper, text layer), `text` (page text with layout preserved), `figures` (figure and table captions with page numbers), `table` (parameter tables cut into rows and columns) and `render` (page or region as PNG for visual reading, 300–400 dpi when you need to read numbers off a chart).

Charts are read as images: shape and order of magnitude (about ±0.5 of a minor tick), not exact values. For exact numbers use a table on the same page.

Non-STM32 parts are fetched once and cached:

- `stm32_ds_fetch code=C25137` fetches by LCSC code; `all=true` fetches every `jlcpcb:` part the project uses; `file=` imports a PDF by hand.
- Cache: `~/.dsh-stm32/datasheets/<code>/` (`meta.json` plus a PDF named after its content sha256); `DSH_STM32_DATASHEETS` relocates it. Cache hits make **no network calls**; failures are remembered for 24 hours and `refresh=true` retries.
- `stm32_ecad_build` fetches the datasheets the project uses after a successful build; the Circuit design tab shows `datasheets 2/3` in its header and the same logic behind its "fetch datasheets" button.
- `stm32_ds_list` shows what is cached and how much space it takes.
- Afterwards `stm32_pdf_read file=C25137` (or the MPN) reads the cached copy directly, so pinout, limits and timing come from the document.

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

The in-session debug console shows one timeline for both sides: the start, success, failure and duration of `stm32_*` calls, plus serial, RTT, watch, pin, clock, interrupt and `.ioc` state.

| Tab | Content | Actions |
| --- | --- | --- |
| Overview | Project, part number, SYSCLK, capacity, debug session, toolchain, build and flash, evidence usage, alert summary | Jump to failed events or the live channel, export an operation log as Markdown |
| Events | Call start and end, duration, slow-call marker, argument summary | Failures only, filter by tool, sort by duration, bulk quoting, JSONL export, event deep links |
| Live channels | Serial / RTT / watch output | Pause, clear, keyword filter, RTT level filter, send a serial line, persistent capture, export |
| Pins | Grouped by peripheral, by port, or drawn as the package (chip part number, package name, four sides of pin bars, pin-1 dot) | Filter, copy references, inspect `.ioc` keys, CSV export |
| Diagram | Hub-and-spoke flow diagram grouped by function (MCU in the centre, NFC antenna and tag, light sensing, power, debug port and keys around it); links leave any of the four sides and are labelled by bus and signal purpose, with check results | Read-only; parts are not boxes of their own; power nets are listed separately |
| Circuit design | tscircuit workspace state: initialisation, dependencies, entries, latest build, libraries, exported artifacts | trigger build, check, library export, STEP export, Gerber packaging and deliverable packaging from the tab; a build takes tens of seconds |
| Clocks | Tree and flow views, per-node frequency and divider | Over-limit markers and "change to ÷N" advice computed from the parent clock |
| Interrupts | NVIC enablement, preemption and sub-priority | Filter, sort, edit in place, bulk edit |
| Faults | Raw failure events, rule decoding, grouping by rule | Category filter, copy group hint, CSV export |
| Artifacts | elf / hex / bin, size, checksum, capacity, build-to-build comparison | Copy checksums |
| Changes | `.ioc` differences against a baseline | Record a baseline, restore one key, restore all |

Project directories are resolved by convention, and the locations can be set explicitly: firmware lives in `program/`, `firmware/`, `app/`, `user/`, or the project root; the KiCad project lives in `hardware/`, `kicad/`, `hw/`, or `pcb/` (otherwise `*.kicad_pro` is scanned two levels deep); configuration and baselines stay in `.dsh-stm32/` at the project root. Both locations can be written to `dsh-stm32.conf` (`firmware=` / `hardware=`), removing the need to rely on directory names.

Opening the panel first loads the most recent records for the session, then appends live. Events are written every 30 seconds to `~/.dsh-stm32/evidence/<date>/<session>/` for replay and export, retained for 7 days and the last 20 sessions by default, all configurable. The panel shows only this plugin's own tool calls. The panel shows only this session's project and debug session: in a session from another workspace, the panel stays empty instead of borrowing another session's project or debug output.

## Serial (Windows)

`stm32_serial` exposes seven actions: `list` / `open` / `read` / `send` / `transact` / `status` / `close`. Once opened, the port is held by the plugin, one port at a time; 115200 8N1 by default, no flow control, DTR / RTS not asserted, closed at the end of a turn.

- Platform: Windows only. Linux and macOS return `unsupported-platform`.
- Ports: `list` enumerates available ports; parameters are remembered per device, so a different COM number still reuses them.
- Read: `read` accepts a cursor and returns only newer lines.
- Write: `send` writes one line; `transact` writes and waits for a matching reply (regular expression).
- Retention: `persist=true` keeps the port open across turns.

The reference validation board uses a CH340 (`1A86:7523`, COM5, 115200). The DAPLink virtual serial port on the same board (`c251:f001`, COM4) does not carry application data.

## Design notes

- **Own files only**: the `.ioc` goes through a transaction (plan → checks → backup → replace); generated regions receive only `USER CODE` content; no other generated file is modified.
- **Flash and debug are separate**: `stm32_flash` never opens a debug session and releases the probe immediately; debugging opens `stm32_debug_session` on demand and closes it when idle, so VS Code is not locked out.
- **Conclusions carry evidence**: failures return compiler `file:line:col`, probe error class and register values rather than vague prose.
- **Say what is missing**: when a chip, a clock plan or a debug script is unsupported, the error names the missing piece instead of guessing or silently skipping.
- **No host takeover**: the panel displays state and performs explicit project actions; it does not edit code or run Git operations.

## Configuration

### Config file (`~/.dsh-stm32/config.json`)

Toolchain locations are maintained by the plugin: `stm32_env_install` writes this file and later tools read it, with no DSH restart and no environment variables required. Manual editing is supported:

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

Precedence: tool arguments (`binDirs` / `cubeMxRoots`) > environment variables > config file > built-in defaults. Built-in defaults contain only common Windows locations, never machine-specific paths.

### Settings panel

The "STM32 toolchain" page under DSH settings offers three cards:

- **Locations**: reads and saves `msys64` / `cubeMxRoot` / extra `binDirs`; the next tool call sees the change.
- **Missing pieces**: runs a probe (version queries only) and lists path, version and reason per item, plus badges for build / flash / debug / generate.
- **Install toolchain**: emits a plan first (steps, download size, PATH and config changes), executes after confirmation, and streams steps with a log tail.

### Download cache and firmware packages

- Register-route CMSIS templates are downloaded on first use into the cache (default `%LOCALAPPDATA%\dsh-stm32\cache`) and reused afterwards; files are verified and mismatches rejected. `stm32_cache` lists, verifies, fetches and prunes entries.
- The HAL route uses locally installed CubeMX firmware packages: F1 defaults to `STM32Cube_FW_F1_V1.8.7`, other families use the highest installed version; `firmwarePackage` overrides. When missing, install it through the CubeMX package manager or use `stm32_firmware_install`.
- `stm32_download` only downloads or verifies installers (default directory `%LOCALAPPDATA%\dsh-stm32\downloads`); it never executes them and never requests administrator rights.

### Environment variables (optional)

| Variable | Purpose | Default |
| --- | --- | --- |
| `STM32_BIN_DIRS` | Toolchain directory candidates, `;`-separated, replaces the built-in list entirely (auto-discovery still appends) | `C:/msys64/ucrt64/bin`, `C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | CubeMX root, replaces the built-in list | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | Set to `1` to disable auto-discovery (built-in list only) | unset |
| `DSH_STM32_CONFIG` | Alternate config file path | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | Set to `1` to ignore the config file entirely | unset |
| `DSH_STM32_CACHE` | Download cache root, supports `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_DOWNLOADS` | Installer download directory, supports `~` | `%LOCALAPPDATA%\dsh-stm32\downloads` |
| `DSH_STM32_HOME` | Plugin data root (config, evidence, snapshots, memo) | `%USERPROFILE%\.dsh-stm32` |
| `DSH_STM32_EVIDENCE` | Evidence directory | `~/.dsh-stm32/evidence` |
| `DSH_STM32_EVIDENCE_FLUSH_SECONDS` | Flush interval (5–3600 s) | 30 |
| `DSH_STM32_EVIDENCE_KEEP_DAYS` | Evidence retention in days (0–365, 0 = keep) | 7 |
| `DSH_STM32_EVIDENCE_KEEP_SESSIONS` | Evidence retention in sessions (1–200) | 20 |
| `DSH_STM32_SNAPSHOTS` | `.ioc` baseline directory | `~/.dsh-stm32/ioc-snapshots` |
| `DSH_STM32_OFFLINE` | Set to `1` to forbid network downloads (cache only) | unset |
| `MSYS2_MIRROR` | Installer mirror; must be set together with `MSYS2_INSTALLER_SHA256` | official → TUNA → NJU → Aliyun |
| `MSYS2_INSTALLER_URL` / `MSYS2_INSTALLER_SHA256` | Installer URL and checksum overrides; must be set together | official pinned release |
| `DSH_STM32_JLINK_URL` / `DSH_STM32_JLINK_SHA256` | J-Link direct link and checksum overrides; must be set together | SEGGER official |

Tool arguments mirror these variables: flash and debug tools accept `binDirs`, `elfPath`, `buildDir`, `configFile`, `adapterSpeed`; generation and scaffolding accept `cubeMxRoots`, `firmwarePackage`.

Toolchain locations usually need no configuration: when `binDirs` / `STM32_BIN_DIRS` are absent, the plugin searches common locations and appends candidates — `ucrt64/bin`, `mingw64/bin` and `clang64/bin` under `<drive>/msys64`, `<drive>/msys2`, `<drive>/app/msys64`, `<drive>/tools/msys64`, `%LOCALAPPDATA%/Programs/msys64`; and CubeMX under the `STM32CubeMX_PATH` environment variable, its uninstall registration, and `Program Files\STMicroelectronics\STM32Cube`. When nothing is found, errors and `stm32_doctor` list the directories that were checked.

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

Without `openocd.cfg`, the debug script follows the chip family in the `.ioc` (F1 → `stm32f1x`, F4 → `stm32f4x`, G4 → `stm32g4x`; L4 and L4+ share `stm32l4x`). C0 / U0 scripts ship with the plugin and are copied into the project's `openocd/` directory during scaffolding; H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 have no scripts and flashing is refused explicitly.

### Two hard requirements on the `.ioc`

1. **SYS debug port set to Serial Wire** (PA13 = `SYS_JTMS-SWDIO`, PA14 = `SYS_JTCK-SWCLK`); use `stm32_ioc_plan` with `serialWire: true` when missing.
2. **`ProjectManager.KeepUserCode=true`**; otherwise `USER CODE` content is lost on regeneration.

## Known limitations

| Limitation | Detail | Handling |
| --- | --- | --- |
| Verified on Windows only | Code generation depends on the Windows installation of CubeMX | No alternative yet; flash, debug and register reads may work elsewhere with a complete toolchain, unverified |
| Some chips have no official debug script | C0 / U0 use plugin-supplied scripts (not verified on hardware); H5 / N6 / U3 / WBA / WB0 / WL3 / MP2 have none | Flashing states this explicitly instead of failing silently |
| HAL scaffolding excludes dual-core and MPU families | Dual-core WB, MP1 / MP2 / N6, WB0 / WL3 are out of scope | Scaffolding reports the chip as unsupported |
| Depth is graded per family | HAL 21 families, register 21, clocks 18; register names and bitfields currently F1 only | The missing capability is named at call time |
| Probes selected from what USB reports | ST-Link, DAPLink / CMSIS-DAP and J-Link are distinguished automatically; a project `openocd.cfg` wins | Write `openocd.cfg` to pin a choice |
| New peripherals need manual HAL sources | The plugin places only `Src/` and `Inc/`; CubeMX-generated `cmake/**` is not carried over | Edit `STM32_Drivers_Src` or write into `cmake/user/CMakeLists.txt` |
| Generation and scaffolding need CubeMX plus the family firmware package | F1 defaults to `STM32Cube_FW_F1_V1.8.7` | Pass `firmwarePackage`, or install the package in CubeMX first |
| RTT is channel 0 only with a custom frame | 13-byte header (length, level, timestamp, UTF-8 text) | Filter by level; put structured data in the text; channels and ring size in `rtt.h` |
| Serial is Windows-only | No streaming UI, no auto-reconnect, one port at a time | Use a system serial tool, or a later release |
| Register names and bitfields need the bundled register tables | Covers F1 lines 100 / 101 / 102 / 103 / 105 / 107 | Use `0x` addresses; `stm32_assets verify` checks the installation |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Plugin not loaded | `dsh.profile.bundles` lacks `dsh-stm32`, or DSH was not restarted | Reinstall and restart; verify with `dsh plugin --profile desktop why dsh-stm32` |
| Code changes have no effect | Installed via `file:`, so the host reads a copy | Switch to `link:`, rebuild with `npm run build`, restart DSH |
| Missing toolchain reported | Not installed, or path not discovered | Run `/stm32-env` to see what is missing, then `/stm32-setup`; or set `binDirs` manually |
| Flash reports the probe is busy | Another debugger (VS Code, leftover openocd) holds the probe | `/stm32-stop`, close other debuggers, retry; `stm32_doctor` lists leftover processes |
| SWD is lost after flashing | `.ioc` did not enable Serial Wire | Add `serialWire: true` via `stm32_ioc_plan`, regenerate, flash again |
| Peripherals dropped after generation | `.ioc` keys inconsistent with peripheral derivation | Run `stm32_ioc_verify` for a CubeMX-side diagnosis |
| Panel is blank or stale | Server-side change without restart, or `lib` newer than the process | Fully exit DSH and start again; the status bar flags "new build available" |
| No serial data | Wrong port (for example the DAPLink virtual port) | Confirm with `stm32_serial list`; application serial usually lives on a CH340-class adapter |

## Development and testing

| Command | Purpose |
| --- | --- |
| `npm run build` | `tsc` into `lib/`, copying client and data assets |
| `node test/run-units.mjs` | Offline unit tests: 81 suites / 1101 cases, no board required |
| `node .dsh-stm32/acceptance.mjs` | Local acceptance script: panel API, event stream, evidence, artifacts, faults, interrupts, serial, probe |
| `npm run test:pack` | Pack, unpack and scaffold a register project with the unpacked build |
| `npm run test:size` | Package and asset guards |

Release shape: published content is limited to `files` in `package.json` (`lib`, `client`, `templates`, `assets`, `docs/reading-guide.md`, `cordis.patch.yml`, both READMEs, `LICENSE`). `docs/`, `test/` and `scripts/` stay out of the package.

Development-only environment variables (not needed in daily use): `DSH_STM32_ASSETS` and `DSH_STM32_FACTS` override asset directories, `DSH_STM32_SERIAL_BRIDGE` and `DSH_STM32_SERIAL_POWERSHELL` override the serial bridge path, `DSH_STM32_PYTHON` selects the Python interpreter used for parsing.

## Repository layout

```text
src/
  index.ts          plugin entry: tools, slash commands, panel API, SKILL
  tools/            registration and argument validation for 39 tools
  engine/           engines: project, .ioc, generation, build, flash, debug, events, panel API
  data/             chip data, CubeMX data, clocks, search roots, toolchain config
  commands/         7 slash commands
  skill/            bundled stm32-workflow SKILL
client/client.js    panel source (plain JS + react, no bundler)
lib/                tsc output and copied assets (published)
assets/             chip data, .ioc templates, linker scripts, startup files, register tables
templates/          scaffolding templates, register route, serial bridge, RTT
test/               80 offline suites and e2e scripts
scripts/            build, pack, size and smoke scripts
docs/               development notes, reading guide, spec, diagrams
```

## Documentation

- [Specification](docs/dsh-stm32-plugin-规格.md): tool contracts, state machine, acceptance criteria
- [Development notes](docs/development-notes.md): milestones, host-contract issues, per-tool implementation details and measurements
- [Source reading guide](docs/reading-guide.md): layered reading order, per-file responsibilities and exports, diagrams and invariants
- Release notes: provided per release on the release page; history lives in git and the development notes
- Visuals: [architecture](docs/diagrams/dsh-stm32-architecture.html) / [main journey](docs/diagrams/dsh-stm32-journey.html) — single-file HTML, opens offline

## License

[MIT](LICENSE)
