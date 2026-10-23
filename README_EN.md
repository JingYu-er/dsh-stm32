# dsh-stm32

> Hand the whole STM32F103C8T6 development chain to DSH: probe the toolchain → scaffold a project → edit the .ioc → generate code → build → debug → flash.

[中文](./README.md) · [Quick start](#quick-start-a-minimal-end-to-end-check-empty-directory-to-a-blinking-led) · [Features](#features) · [Tool reference](#tool-reference) · [Slash commands](#slash-commands) · [Design notes](#design-notes) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Specification](docs/dsh-stm32-plugin-规格.md)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#known-limitations)
[![MCU](https://img.shields.io/badge/MCU-STM32F103C8T6-4a6cf7)](#known-limitations)
[![version](https://img.shields.io/badge/version-0.1.0-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **plugin** (host-side, no UI): it registers 15 tools, 5 slash commands and 1 SKILL shipped with the plugin, so the model can probe the toolchain, scaffold a CubeMX CMake project, edit the `.ioc`, run CubeMX, build, flash and debug on its own, then read the state back out of the registers — hardware programming that actually stays inside DSH.

## Why you need it

Most "let the model write STM32 code" setups stop at the source file: you get a `main.c`, and whether it compiles, whether the LED actually blinks after flashing, is still your job — open CubeMX, switch to a terminal, press F5. **The model never sees the board, so it cannot be responsible for its own code.**

This plugin wires the hardware side into DSH as well: the `.ioc` can be read and edited (as a transaction, with rollback), code can only land inside `USER CODE` blocks, generation and builds return real error lines, flashing is an independent path that **never goes through a debugger**, and after flashing the model can read the state back out of the registers. Every step returns structured evidence — `planId`, `file:line:col`, `Verified OK`, bit13 of `GPIOC_ODR` — so the next step is decided from evidence instead of guesswork.

That is what "hardware programming inside DSH" means here: **the model does not just write code — it puts that code on the board, then reads the board's state back out of the registers and reconciles it with what it expected.**

| Stage | Before (hand-written + CubeMX GUI) | Now (end-to-end in DSH) |
| --- | --- | --- |
| Create the project | Click through the clock tree, pins and project settings in the GUI, generate CMake, then hand-write `launch.json` | One sentence: `stm32_project_create` produces a templated project in 2 s (byte-identical to the GUI output), both `.vscode` debug configs already in place |
| Change the configuration | Edit in the GUI, regenerate, pray that USER CODE survives | `stm32_ioc_plan` shows the diff first (source untouched) → you approve → `stm32_ioc_apply` writes with SHA verification, backup and rollback on failure |
| Write code | Edit the whole file, accidentally touch a generated region, lose it on the next generate | `stm32_code_patch` writes only inside `USER CODE` blocks; everything outside stays byte-for-byte |
| Build | Build in Keil, or hand-write the CMake files for the VS Code extension | DSH builds automatically via `/stm32-build [dir] [--clean]` |
| Flash | Flash in Keil, or maintain a `tasks.json` that calls openocd | DSH flashes automatically via `/stm32-debug [dir]` |
| Verify | Set a breakpoint and read the register values yourself | After flashing, `stm32_regs_read` reads the state back: `GPIOC_ODR` twice to see the counter grow, `AFIO_MAPR` to confirm the firmware did not disable SWD |
| Debug | `F5`, set breakpoints by hand, remember to close the session | `stm32_debug_run` halts at `main`, captures one snapshot and releases the probe; use `stm32_debug_session` only for continuous debugging, it closes itself when idle |


## Install

### Prerequisites

| Dependency | Purpose | If missing |
| --- | --- | --- |
| dsh (able to load bundle layers) | Host | The plugin is never loaded |
| Node ≥ 20 | Build / test | `npm run build` fails |
| `arm-none-eabi-gcc`, `arm-none-eabi-gdb` (or `gdb-multiarch`) | Build / debug | `stm32_doctor` tells you which one is missing and where to get it |
| `openocd` | Flash / debug | Flashing and debugging unavailable; read-only tools still work |
| `cmake` + `ninja` | Build | `stm32_build` fails |
| STM32CubeMX (with its bundled JRE) | `stm32_generate`, `stm32_project_create` | Generation tools unavailable, everything else still works |
| STM32Cube firmware package F1 (installed with CubeMX) | Drivers copied when scaffolding | "Firmware package not found" |

Paths are searched as MSYS2 (`D:/app/msys64/ucrt64/bin`, `C:/msys64/ucrt64/bin`) → ST official packages, with CubeMX at `D:/app/STM32CubeMX` by default; override with environment variables if yours live elsewhere (see [Configuration](#configuration)).

### Install (recommended: one command)

```powershell
dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main
```

All `dsh plugin` does is run `pnpm add` inside the profile directory. On success it also appends `dsh-stm32` to that profile's `dsh.profile.bundles`, so a restart of dsh is all that is left (use `web` instead of `desktop` to target the web profile).

Verify with `dsh plugin --profile desktop why dsh-stm32` (should print `0.1.0`); after a restart `/stm32-doctor` should respond.

> Not published on npm yet. Once it is, `dsh plugin --profile desktop add dsh-stm32` is equivalent, and gives you semantic versions to roll back to.

**Uninstall**: `dsh plugin --profile desktop remove dsh-stm32`, then restart dsh.

### Install from source (when you want to change code)

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # typescript only
npm run build                       # tsc -> lib/ (required before committing)
npm test                            # optional: 80 offline cases, no board needed
```

Link it into your dsh profile — **while editing code use `link:`, never `file:`**:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:D:\path\to\dsh-stm32"

# then append "dsh-stm32" to dsh.profile.bundles in that directory's package.json
# finally restart dsh (bundle layers only load at process start)
```

> **Why `link:` while editing**: with `nodeLinker: hoisted`, pnpm copies a `file:` dependency into a real directory, so the `lib/` you rebuild with `tsc` is never read by the host — the symptom is "I fixed it, restarted, still the old behaviour". With `link:` the host reads `lib/` live, but you **still have to restart dsh** to reload the plugin. A `github:` or npm install is a copy, so re-build and reinstall after changing code.

## Quick start: a minimal end-to-end check (empty directory to a blinking LED)

This chain ran on a real board (acceptance A1, 2026-10-22), driven entirely by tool calls from the model. Note that it is a **minimal check** — every step uses the same tools a real project uses, and the blinking LED is simply the cheapest sample:

| Step | What happens | Tool | Measured |
| --- | --- | --- | --- |
| 1 | Health check: toolchain, busy probes, ports, `.elf`, `.ioc` warnings | `stm32_doctor` | ~2 s |
| 2 | Empty directory → CMake project skeleton (14 template files + 629 firmware files + an `.ioc` with SWD configured) | `stm32_project_create` | ~2 s |
| 3 | Headless CubeMX run driven by the `.ioc`, output placed under `Core/` | `stm32_generate` | 61–77 s |
| 4 | Build (first run configures with `cmake --preset`) | `stm32_build` | ~5 s configure + 3 s build |
| 5 | **Flash only**: program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | Read `GPIOC_ODR` back to confirm the state really toggles | `stm32_regs_read` | 0.4–1.3 s |

On the model side it is one sentence: "create a blinking-LED project for STM32F103C8T6 in `D:\work\blink`, build it and flash it". To drive it yourself:

```text
/stm32-doctor         # health check before you start
/stm32-build          # build, print memory usage and errors
/stm32-flash          # flash only, no debug session
/stm32-debug          # flash + halt at main
/stm32-stop           # close the debug session, hand the probe back to VS Code
```

### This is a minimal check, not the ceiling

The blinking LED is the **smallest smoke test** for this chain: it walks create → generate → build → flash → read the state back once, and every step uses a general-purpose tool — nothing in it is LED-specific. A real project follows the same chain; what changes is that the `.ioc` enables more peripherals, there are more `USER CODE` blocks, and the code is longer:

| What a real project needs | Which path it takes | Verified on hardware |
| --- | --- | --- |
| Peripheral setup: GPIO / timers / USART / I2C / SPI / ADC / DMA / interrupts | `stm32_ioc_plan` edits the `.ioc` (GPIO validated against the chip pin table, peripherals written as `Mcu.IP*` / `Periph.*` keys) → `stm32_ioc_apply` → `stm32_generate` | GPIO, clocks and SWD verified; other peripherals use the same mechanism but were not tested one by one |
| HAL sources for a newly enabled peripheral | Add `stm32f1xx_hal_<peripheral>.c` to `STM32_Drivers_Src` in `cmake/stm32cubemx/CMakeLists.txt`, or add it in `cmake/user/CMakeLists.txt` | **Manual step**: the plugin only relocates `Src/` and `Inc/`; the `cmake/**` files CubeMX emits are not applied |
| Several source files, your own modules | Put them in `cmake/user/CMakeLists.txt` (the template leaves that spot ready) | Spot is in place; not tested separately |
| Business logic | `stm32_code_patch` writes block by block, carried back by label on the next generate | Verified (append / replace / a wrong label lists every available label) |
| Tuning parameters, changing clocks | `.ioc` transactions: diff first → SHA check → backup → rollback on failure | Verified |
| Confirm a peripheral is really running after flashing | `stm32_regs_read` reads any peripheral register (`TIM2_CNT`, `USART1_SR`, `ADC1_DR` …), or `stm32_debug_eval` reads a variable | Reading registers by physical address verified (`GPIOC_ODR` / `AFIO_MAPR`) |
| Something is wrong and you need the live state | `stm32_debug_run` halts at `main` for one snapshot; use `stm32_debug_session` + `stm32_debug_eval` for continuous debugging | Verified (halts at `main () at main.c:67`) |

So the blinking LED is the acceptance sample, not the ceiling: **this covers the whole engineering chain, not one demo.** The real boundaries are the ones under [Known limitations](#known-limitations) — F103C8T6 only, verified on Windows only, CMSIS-DAP by default, plus the manual HAL-source step above. Peripheral types themselves are not limited by the tools: whatever the `.ioc` can configure goes through the same generate → build → flash → read-back chain; it just has not been tested peripheral by peripheral yet, so run `stm32_doctor` before starting a real project.

## Features

| Capability | How it is provided |
| --- | --- |
| Environment health check | `stm32_env_probe` (read-only), `stm32_doctor` (toolchain + busy probes + ports + project warnings) |
| Project from scratch | `stm32_project_create`: template snapshot + firmware Drivers, byte-identical to a project created in the CubeMX GUI |
| `.ioc` as a transaction | `stm32_ioc_inspect` (read-only parse) → `stm32_ioc_plan` (diff, no writes) → `stm32_ioc_apply` (SHA check + backup + rollback) |
| USER CODE only | `stm32_code_patch`: writes only between `/* USER CODE BEGIN X */` and `END X`; everything else untouched |
| Code generation | `stm32_generate`: headless CubeMX + ST project layout + USER CODE carried over by label |
| Build | `stm32_build`: build directory and `.elf` inferred, deduplicated errors, RAM/FLASH usage parsed after linking |
| Flash | `stm32_flash`: openocd `program verify reset exit`, probe released afterwards; checks that the `.ioc` has Serial Wire enabled |
| Debug | `stm32_debug_run` / `stm32_debug_session` / `stm32_debug_eval` / `stm32_debug_stop` |
| Prove it is running | `stm32_regs_read`: reads any peripheral register back by physical address, halts, reads, then `resume` — no chip reset |
| Working discipline for the model | SKILL `stm32-workflow` shipped with the plugin (USER CODE only, never touch generated regions, flash and debug are separate, claims need register evidence) |

## Tool reference

### Environment and project

| Tool | What it does |
| --- | --- |
| `stm32_env_probe` | Detects gcc / gdb / openocd / cmake / ninja / CubeMX / JRE paths and versions, with install hints for what is missing. Read-only, repeatable |
| `stm32_doctor` | Answers three questions at once: is the toolchain complete, who holds the probe (`openocd.exe` / gdb processes / port 3333), can this project be flashed |
| `stm32_project_create` | Empty directory → full CMake project (including both "flash only" and "flash and debug" launch configs in `.vscode`). Refuses a non-empty target unless `overwrite: true` |

### .ioc: read-only and transactions

| Tool | What it does |
| --- | --- |
| `stm32_ioc_inspect` | Parses MCU part, pins/signals/labels, peripherals and interrupts, clock tree, project settings; reports fatal risks such as "no Serial Wire means a generated `SWJ_DISABLE`" |
| `stm32_ioc_plan` | Step one of any `.ioc` change: computes a per-key diff plus the source SHA-256 and returns a `planId`, **without touching the source**. Supports setting/removing keys, adding GPIO from the chip pin table, and one-shot Serial Wire repair |
| `stm32_ioc_apply` | Requires a `planId`; re-checks the SHA before writing (refuses if the file changed meanwhile), backs up, replaces atomically, re-parses to validate, rolls back on failure. Supports `rollbackFrom` |

### Code and build

| Tool | What it does |
| --- | --- |
| `stm32_code_patch` | replace/append inside `USER CODE` blocks only; bytes outside (including CRLF) are preserved; backs up first, then writes a temp file and renames it. A wrong label lists every available label in the file |
| `stm32_generate` | Runs `java -jar STM32CubeMX.exe -q` headless, then places output under `Core/Src` and `Core/Inc`, carrying USER CODE from the old files by label. Background job by default |
| `stm32_build` | `cmake --build`, with the build directory inferred from `CMakePresets.json` and `build/*/CMakeCache.txt`; configures on first build; rejects the "CMakeCache directory mismatch but ninja exits 0" false success |

### Flash and debug

| Tool | What it does |
| --- | --- |
| `stm32_flash` | **Flash**: openocd `program verify reset exit`, no debug session, no halt at `main`. Reads the `.ioc` first and refuses when the debug port is disabled (see [Design notes](#design-notes)) |
| `stm32_debug_run` | Starts openocd + gdb, `break main` → `continue` → captures pc/sp/lr/bt/locals → `reset run` + `detach`; no Flash write, nothing left running |
| `stm32_debug_session` | Long-lived openocd session (`.elf` resolved automatically), closed after 90 s idle, hard limit 10 min |
| `stm32_debug_eval` | Runs gdb commands or reads expressions (e.g. `g_led_blink_count`) inside the session, then `resume` + `detach` immediately |
| `stm32_debug_stop` | Releases the probe immediately, idempotent |
| `stm32_regs_read` | Reads physical addresses such as `GPIOC_ODR` and `AFIO_MAPR`; finishes with `resume` instead of `reset run`, so a read does not wipe the firmware state |

## Slash commands

Tools are for the model; when you want to act yourself, use a command — one command, one action, no model decision in between.

| Command | What it does | Touches the board |
| --- | --- | --- |
| `/stm32-doctor` | Health check: toolchain, busy debug processes, ports, `.elf`, `.ioc` warnings | No |
| `/stm32-build [dir] [--clean]` | Build, printing memory usage / `.elf` / errors | No |
| `/stm32-flash [dir]` | **Flash**: program + verify + reset, no debug session, no breakpoints | Yes |
| `/stm32-debug [dir]` | **Flash + debug**: halt at `main` after flashing, session kept (3 min idle / 10 min limit, also closed when the turn ends) | Yes |
| `/stm32-stop` | Closes the session opened by `/stm32-debug` and hands the probe back to VS Code | No |

`[dir]` defaults to the current session's working directory.

## Design notes

- **Flashing and debugging are two separate paths.** `stm32_flash` only uses openocd's `program/verify/reset/exit`; success is proven by `** Programming Finished **` and `** Verified OK **` appearing in the log, not by "no errors".
- **USER CODE only.** Change logic with `stm32_code_patch`; `stm32_generate` carries old content back by label, so edits to generated regions (or whole-file rewrites) are lost on the next generate.
- **`.ioc` is a transaction.** `plan` only computes the diff and a `planId`; `apply` writes, verifying the SHA before and re-parsing after, with rollback on failure.
- **Flash guard.** If SYS is not Serial Wire (PA13/PA14 missing or set to `No_Debug`), CubeMX generates `__HAL_AFIO_REMAP_SWJ_DISABLE()` — flash that and SWD is gone, recoverable only via BOOT0. `stm32_flash` refuses such projects; pass `allowNoDebug: true` if you really mean it.
- **One probe at a time.** Flashing, debugging and a background session cannot coexist; `build` / `flash` / `debug_run` / `generate` release any session holding the probe before they start.

## Configuration

### Environment variables (optional)

| Variable | Purpose | Default |
| --- | --- | --- |
| `STM32_BIN_DIRS` | Toolchain directory candidates, `;`-separated, takes precedence over the built-in list | `D:/app/msys64/ucrt64/bin`, `C:/msys64/ucrt64/bin`, `C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | STM32CubeMX installation root | `D:/app/STM32CubeMX`, `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `DSH_STM32_E2E_PROJECT` | Project used by hardware e2e runs (with `openocd.cfg` and `build/Debug/*.elf`) | none |
| `DSH_STM32_E2E_ROOT` | Scratch directory for e2e copies | system temp |

Per-call arguments work too: flash/debug tools accept `binDirs`, `elfPath`, `buildDir`, `configFile`, `adapterSpeed`; generate/create accept `cubeMxRoots`, `firmwarePackage`.

### openocd.cfg (in the project, takes precedence over built-in fallbacks)

CMSIS-DAP (default):

```text
source [find interface/cmsis-dap.cfg]
source [find target/stm32f1x.cfg]
adapter speed 4000
```

ST-Link (swap in your probe):

```text
source [find interface/stlink.cfg]
transport select hla_swd
source [find target/stm32f1x.cfg]
```

Without an `openocd.cfg` the plugin falls back to `interface/cmsis-dap.cfg` + `target/stm32f1x.cfg`. ST-Link users should put the second block into the project root as `openocd.cfg`.

### Two hard requirements on the .ioc

1. **SYS must be Serial Wire** (PA13 = `SYS_JTMS-SWDIO`, PA14 = `SYS_JTCK-SWCLK`); if not, add it with `serialWire: true` in `stm32_ioc_plan`.
2. **`ProjectManager.KeepUserCode=true`**; otherwise USER CODE is not preserved when regenerating.

## Known limitations

| Limitation | Detail | Workaround |
| --- | --- | --- |
| Only verified on **Windows** | `stm32_generate` depends on `<CubeMX>/STM32CubeMX.exe` + `jre/bin/java.exe`; CubeMX on Linux/macOS is not shaped like that | None yet; flash/debug/register reads may work on Linux with openocd and gdb present, but are untested |
| **STM32F103C8T6** only | The pin table, `.ioc` pin validation and linker-script template assume a C8T6 with 64 KiB Flash / 20 KiB RAM | Porting means editing `src/data/chips.ts` and `templates/` |
| Default probe is **CMSIS-DAP** | Falls back to cmsis-dap without an `openocd.cfg` | Put `interface/stlink.cfg` into `openocd.cfg` (see above) |
| Adding a peripheral needs a **manual HAL source entry** | The plugin only relocates CubeMX's `Src/` and `Inc/` (→ `Core/Src`, `Core/Inc`); the `cmake/stm32cubemx/CMakeLists.txt` CubeMX emits is not applied. Enable a timer/UART/ADC and you must add the matching `stm32f1xx_hal_<peripheral>.c` yourself | Edit `STM32_Drivers_Src` in the project's `cmake/stm32cubemx/CMakeLists.txt`, or add a `target_sources` line in `cmake/user/CMakeLists.txt` |
| Generation/scaffolding needs **CubeMX + the F1 firmware package** | Package version defaults to `STM32Cube_FW_F1_V1.8.7` | Pass another version via `firmwarePackage` |
| Not yet verified on other machines | This machine: Windows 10 + MSYS2 UCRT64 + DAPLink + a Blue Pill; other combinations rely on your feedback | Open an issue with the full `stm32_doctor` output |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| SWD lost after flashing | The firmware generated `__HAL_AFIO_REMAP_SWJ_DISABLE()`. Hold BOOT0 while powering up to enter the system bootloader and reflash, then set SYS back to Serial Wire — `stm32_flash` now blocks this case first |
| `Error: No device found` / `transfer count mismatch` | Another process holds the probe. Run `/stm32-stop`, then use `stm32_doctor` to inspect openocd / gdb processes and port 3333 |
| Build "succeeds" but the old firmware runs | The project was copied or renamed with `build/` included: the CMakeCache directory no longer matches, yet ninja still exits 0. `stm32_build` treats that as a failure; clean or delete `build/Debug` as prompted |
| `stm32_doctor` cannot find gcc / openocd | Install it and set `STM32_BIN_DIRS`, or pass `binDirs`; `stm32_env_probe` reports exactly what each component is missing |
| `stm32_generate` feels stuck | A cold CubeMX start takes 60–150 s; it runs as a background job by default — watch it with `job_output`, or pass `foreground: true` |
| `stm32_code_patch` says the block does not exist | `main.c` uses short labels (`PV` = private variables, `PFP` = prototypes, `2` = init before while, `3` = loop body); the error lists every available label — copy one from there |

## Development and testing

```powershell
npm run build            # tsc -> lib/ (lib/ is committed: rebuild before you commit)
npm test                 # 10 offline suites, 80 cases; no board, CubeMX, or toolchain needed
```

CI (`.github/workflows/ci.yml`) runs `npm ci → build → check that the committed lib/ matches src/ → npm test` on every push and PR (windows-latest).

A GitHub runner has neither msys64 nor CubeMX, so two scaffolding cases that need the real firmware package are skipped: CI reports **78 passed + 2 skipped**, while a developer machine runs all 80. The offline suites only read the bundled [`test/fixtures/`](test/fixtures/README.md); the session cases build a fake toolchain directory with `fakeBinDirs()` (empty placeholder files for openocd / gdb), so nothing depends on what is installed locally.

Hardware e2e writes to the board and needs a project you point it at:

```powershell
$env:DSH_STM32_E2E_PROJECT = 'D:\work\my-stm32'
node test\e2e-flash.mjs
```

See the [development notes](docs/development-notes.md) for the suite breakdown and what each script covers.

## Repository layout

```text
src/
  index.ts                 plugin entry (name / inject / apply)
  tools/                   the 15 tools, L3 (parameter schema + output contract + rendering)
  engine/                  pure logic and workflows (generate / build / flash / debug / ioc / scaffold …)
  commands/register.ts     the 5 slash commands
  skill/stm32-workflow.ts  the SKILL shipped with the plugin
  data/                    paths and chip data (paths are data, not logic)
templates/scaffold/        project template snapshot (CMake / .ld / .vscode / .ioc)
test/                      offline suites + fixtures + hardware e2e
docs/                      specification + development notes
```

## Documentation

- [Specification](docs/dsh-stm32-plugin-规格.md): tool contracts, state machine, acceptance criteria A1–A13
- [Development notes](docs/development-notes.md): milestones, host-contract pitfalls, implementation details and measured numbers

## License

[MIT](LICENSE)
