# dsh-stm32

> Hand the whole **STM32F1 family** (F100/101/102/103/105/107) development chain to DSH: probe the toolchain → scaffold a project → edit the .ioc (clocks included) → generate code → build → debug → flash.

[中文](./README.md) · [Quick start](#quick-start-a-minimal-end-to-end-check-empty-directory-to-a-blinking-led) · [Features](#features) · [Tool reference](#tool-reference) · [Slash commands](#slash-commands) · [Design notes](#design-notes) · [Known limitations](#known-limitations) · [Troubleshooting](#troubleshooting) · [Specification](docs/dsh-stm32-plugin-规格.md)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-stm32?color=4a6cf7)](https://github.com/JingYu-er/dsh-stm32)
[![license](https://img.shields.io/github/license/JingYu-er/dsh-stm32)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4a6cf7)](#known-limitations)
[![MCU](https://img.shields.io/badge/MCU-STM32F1xx-4a6cf7)](#known-limitations)
[![version](https://img.shields.io/badge/version-0.1.3-orange)](https://github.com/JingYu-er/dsh-stm32/releases)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **plugin** (host-side, no UI): it registers 21 tools, 7 slash commands and 1 SKILL shipped with the plugin, so the model can probe the toolchain, scaffold a CubeMX CMake project, edit the `.ioc`, run CubeMX, build, flash and debug on its own, then read the state back out of the registers — hardware programming that actually stays inside DSH.

## Why you need it

Most "let the model write STM32 code" setups stop at the source file: you get a `main.c`, and whether it compiles, whether the LED actually blinks after flashing, is still your job — open CubeMX, switch to a terminal, press F5. **The model never sees the board, so it cannot be responsible for its own code.**

This plugin wires the hardware side into DSH as well: the `.ioc` can be read and edited (as a transaction, with rollback), code can only land inside `USER CODE` blocks, generation and builds return real error lines, flashing is an independent path that **never goes through a debugger**, and after flashing the model can read the state back out of the registers. Every step returns structured evidence — `planId`, `file:line:col`, `Verified OK`, bit13 of `GPIOC.ODR` (the report says `ODR13=1` when SVD data is installed) — so the next step is decided from evidence instead of guesswork.

That is what "hardware programming inside DSH" means here: **the model does not just write code — it puts that code on the board, then reads the board's state back out of the registers and reconciles it with what it expected.**

| Stage | Before (hand-written + CubeMX GUI) | Now (end-to-end in DSH) |
| --- | --- | --- |
| Create the project | Click through the clock tree, pins and project settings in the GUI, generate CMake, then hand-write `launch.json` | One sentence: `stm32_project_create` produces a templated project in 2 s (byte-identical to the GUI output), both `.vscode` debug configs already in place |
| Change the configuration | Edit in the GUI, regenerate, pray that USER CODE survives | `stm32_ioc_plan` shows the diff first (source untouched) → you approve → `stm32_ioc_apply` writes with SHA verification, backup and rollback on failure |
| Write code | Edit the whole file, accidentally touch a generated region, lose it on the next generate | `stm32_code_patch` writes only inside `USER CODE` blocks; everything outside stays byte-for-byte |
| Build | Build in Keil, or hand-write the CMake files for the VS Code extension | DSH builds automatically via `/stm32-build [dir] [--clean]` |
| Flash | Flash in Keil, or maintain a `tasks.json` that calls openocd | DSH flashes automatically via `/stm32-debug [dir]` |
| Verify | Set a breakpoint and read the register values yourself | After flashing, `stm32_regs_read` reads the state back: `GPIOC.ODR` twice to see the counter grow (with the SVD data it also prints `ODR5=1`), `AFIO.MAPR` to confirm the firmware did not disable SWD |
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

Paths are searched as MSYS2 (`C:/msys64/ucrt64/bin`, `C:/msys64/mingw64/bin`) → ST official packages, with CubeMX at `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` by default; installs elsewhere are found by auto-discovery, and environment variables override everything (see [Configuration](#configuration)).

### Install (recommended: one command)

```powershell
dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main
```

All `dsh plugin` does is run `pnpm add` inside the profile directory. On success it also appends `dsh-stm32` to that profile's `dsh.profile.bundles`, so a restart of dsh is all that is left (use `web` instead of `desktop` to target the web profile).

Verify with `dsh plugin --profile desktop why dsh-stm32` (should print `0.1.3`); after a restart `/stm32-doctor` should respond.

> **First run needs one online download of the asset pack**: the plugin embeds no chip table. Device facts (part → startup file / device define / Flash·RAM size) are installed on first use by `stm32_assets` (`profile: "core"`, 30 files ≈ 237 KiB: chip table + memory layout + `.ioc` templates + linker scripts). After that the whole chain works offline; it only goes online again when the version changes.


**Uninstall**: `dsh plugin --profile desktop remove dsh-stm32`, then restart dsh.

### Install from source (when you want to change code)

```powershell
git clone https://github.com/JingYu-er/dsh-stm32.git
cd dsh-stm32
npm install --no-audit --no-fund   # typescript only
npm run build                       # tsc -> lib/ (required before committing)
npm test                            # optional: 497 offline cases in 34 suites, no board needed
npm run test:pack                   # pack a tarball, unpack it, scaffold a real register project from it
npm run test:size                   # package guard: tarball <=1.2 MB, templates <=60 KB, no binaries/diagrams inside
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
| 3 | Headless CubeMX run driven by the `.ioc`, output placed under `Core/` | `stm32_generate` | 130–175 s the first time; later runs are **skipped outright** (<1 s) while the `.ioc` and outputs are unchanged |
| 4 | Build (first run configures with `cmake --preset`) | `stm32_build` | ~5 s configure + 3 s build |
| 5 | **Flash only**: program + verify + reset | `stm32_flash` | 2.1–2.6 s |
| 6 | Read `GPIOC.ODR` (or the address `0x4001100C`) back to confirm the state really toggles | `stm32_regs_read` | 0.4–1.3 s |

> Step 6 uses the symbol form (`GPIOC.ODR`), which needs the SVD tables from the asset pack's `full` profile: `stm32_assets action="refresh" profile="full"` (128 files, of which 1.71 MiB is SVD). A `core`-only install still works — write the address `0x4001100C` instead, and the report has neither register names nor bit-field decoding.

On the model side it is one sentence: "create a blinking-LED project for STM32F103C8T6 in `D:\work\blink`, build it and flash it". To drive it yourself:

```text
/stm32-doctor         # health check before you start
/stm32-env            # what each capability is missing (works even when incomplete)
/stm32-build          # build, print memory usage and errors
/stm32-flash          # flash only, no debug session
/stm32-debug          # flash + halt at main
/stm32-stop           # close the debug session, hand the probe back to VS Code
/stm32-setup          # health check + install plan (the word "install" in the command actually installs)
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
| Confirm a peripheral is really running after flashing | `stm32_regs_read` reads any peripheral register — by name `TIM2.CNT` / `USART1.SR` / `ADC1.DR` … or by physical address `0x40000024`; naming just the peripheral (`GPIOC`) dumps all 7 of its registers. `stm32_debug_eval` reads variables too | Address form verified on hardware (`0x4001100C` / `0x40010004`); symbol names and bit-field decoding verified against the real asset pack with a fake probe, **hardware re-test pending** (development notes §31.11) |
| Something is wrong and you need the live state | `stm32_debug_run` halts at `main` for one snapshot; use `stm32_debug_session` + `stm32_debug_eval` for continuous debugging | Verified (halts at `main () at main.c:67`) |

So the blinking LED is the acceptance sample, not the ceiling: **this covers the whole engineering chain, not one demo.** The real boundaries are the ones under [Known limitations](#known-limitations) — the STM32F1 family only (F100/101/102/103/105/107; the verified board is a C8T6), verified on Windows only, CMSIS-DAP by default, plus the manual HAL-source step above. Peripheral types themselves are not limited by the tools: whatever the `.ioc` can configure goes through the same generate → build → flash → read-back chain; it just has not been tested peripheral by peripheral yet, so run `stm32_doctor` before starting a real project.

## Features

| Capability | How it is provided |
| --- | --- |
| Environment health check | `stm32_env_probe` (read-only), `stm32_doctor` (toolchain + busy probes + ports + project warnings) |
| Pre-flight gate | Every tool that needs the toolchain runs `ensureToolchain` first: missing pieces are refused up front with what to install and what stops working; `envCheck: "block"` (default) / `"warn"` / `"off"` |
| Install the toolchain | `stm32_env_install`: plan first (what is downloaded, how large, which PATH entry changes), install only after you confirm — MSYS2 + 5 pacman packages + a **user-level** PATH entry, then it writes the config file itself |
| Choose the technical route | `stm32_route_plan`: for **this project's** requirements, lays out the HAL and register cost per peripheral (effort / readability / debugging), then says whether what is missing is installable-by-the-plugin or human-only (CubeMX is a GUI wizard needing an ST account; firmware packages are only maintained by the CubeMX package manager) |
| Chip facts (part → startup file / device define / sizes) | The plugin **ships no chip table**: part, startup file, device define and Flash/RAM come only from the local assets cache (`~/.dsh-stm32/assets/<version>/device/f1/chips.json`, root overridable with `DSH_STM32_ASSETS`), installed once on first use (`stm32_assets` with `action: "refresh"`) and offline afterwards. With no network and no cache, `stm32_project_create` / `stm32_doctor` say "run stm32_assets refresh, or check the network" instead of inventing a startup file from a built-in table |
| Project from scratch | `stm32_project_create`: `route: "hal"` uses the template snapshot + firmware Drivers (byte-identical to a CubeMX GUI project); `route: "register"` builds a register-level project with no CubeMX at all, pulling the CMSIS template into the cache on first use (every file is pinned by upstream sha256 and refused if it changed); `mcu` names the part (both routes accept it; the HAL route renders its startup file / device define / `<DeviceId>_FLASH.ld` from it); both routes also ship an `openocd.cfg` (CMSIS-DAP + `hla_swd` + 2 MHz) |
| Export a project | `stm32_project_export`: packs the sources into one zip (without `build/`, `.dsh-stm32/`, `node_modules/`, `.git/`), optionally including the `.elf`, plus a hand-off README |
| `.ioc` as a transaction | `stm32_ioc_inspect` (read-only parse) → `stm32_ioc_plan` (diff, no writes) → `stm32_ioc_apply` (SHA check + backup + rollback) |
| USER CODE only | `stm32_code_patch`: writes only between `/* USER CODE BEGIN X */` and `END X`; everything else untouched |
| Code generation | `stm32_generate`: headless CubeMX + ST project layout + USER CODE carried over by label |
| Build | `stm32_build`: build directory and `.elf` inferred, deduplicated errors, RAM/FLASH usage parsed after linking; ask for `artifacts: ["hex","bin"]` and the same toolchain's `arm-none-eabi-objcopy` produces them |
| Flash | `stm32_flash`: openocd `program verify reset exit`, probe released afterwards; checks that the `.ioc` has Serial Wire enabled; failures carry a structured `probeError` (`kind` / `cause` / `hint` / `evidence` / `retryable`, `kind` is one of 8) |
| Debug | `stm32_debug_run` / `stm32_debug_session` / `stm32_debug_eval` / `stm32_debug_stop` |
| Prove it is running | `stm32_regs_read`: reads any peripheral register back by address or symbol name (`GPIOC.ODR`), decoding bit fields when SVD data is installed (`→ ODR5=1`); halts, reads, then `resume` — no chip reset |
| Firmware logs (RTT) | `stm32_rtt`: a SEGGER-shaped control block in RAM, openocd `rtt setup/start/server start` turns channel 0 into a TCP stream, and a 13-byte frame header carries level and timestamp — no UART, no rewiring |
| Working discipline for the model | SKILL `stm32-workflow` shipped with the plugin (USER CODE only, never touch generated regions, flash and debug are separate, claims need register evidence) |

## Tool reference

### Environment and project

| Tool | What it does |
| --- | --- |
| `stm32_env_probe` | Detects gcc / gdb / openocd / cmake / ninja / CubeMX / JRE paths and versions; for anything missing it states the impact (cannot build / flash / debug / generate), the recommended install command (pacman / winget, paste-ready), a self-check command, plus `capabilities` (which of the four jobs work) and `recommendations` (install order and an offer to install for you). Read-only, repeatable |
| `stm32_env_install` | One-stop install when the toolchain is missing: `dryRun` (default) only returns a plan — size of the official MSYS2 installer, the five packages, the PATH entry it would add; only `dryRun: false` + `confirm: true` actually work (download → install MSYS2 → `pacman -S` → user-level PATH → self-check → write `~/.dsh-stm32/config.json`). With an existing msys64 it only adds the packages. No uninstall |
| `stm32_route_plan` | Settle the route before writing code: `requirement` is required (e.g. "a button drives the LED, UART prints its state once a second"), and it returns `verdict` (`register-ok` / `both-viable` / `hal-only` / `unclear`), per-peripheral `halEffort`/`regEffort` with `advice`, how the two routes differ, the next concrete step, and toolchain gaps tagged `installability` (`auto` = the plugin can install it / `manual` = human only) plus the full manual install guide. No generic comparison table — the verdict only holds for the requirement you gave |
| `stm32_doctor` | Answers three questions at once: is the toolchain complete, who holds the probe (`openocd.exe` / gdb processes / port 3333), can this project be flashed |
| `stm32_project_create` | Empty directory → full CMake project. `route: "hal"` (default) is the CubeMX route (including both "flash only" and "flash and debug" launch configs in `.vscode`); `route: "register"` builds a **no-CubeMX, no-HAL** register-level project (`mcu` picks the part, CMSIS headers and startup file come from the cache). Refuses a non-empty target unless `overwrite: true` |
| `stm32_assets` | Manages the **device-facts asset pack** (chip table / memory layout / .ioc templates / linker scripts / SVD — not the CMSIS download cache): `action: "refresh"` (default `profile: "core"`, 30 files ≈ 237 KiB; an already installed version is reused; `profile: "full"` is 128 files, adding the SVD tables) fetches `manifest.json` from GitHub → jsDelivr → gitcode and installs it file-by-file, every file pinned by sha256, into `~/.dsh-stm32/assets/<version>/`; `list` / `verify` / `prune` manage versions. **The plugin no longer embeds any chip table**, so device facts come only from here — the first use needs one online install, offline afterwards |
| `stm32_cache` | Inspect / verify / fetch / purge the download cache: `action: "list"` (default), `"verify"` (per-file check), `"fetch"` (pull the template for an `mcu`, reusing the cache without touching the network), `"purge"` (drop entries; clears everything without an `id`). The cache holds what the register route needs but the plugin does not ship — CMSIS device headers, startup file, core headers — downloaded once, reused forever |
| `stm32_project_export` | Hands the project to someone else as one zip: sources, CMake, `.vscode` and the `.ioc` by default, skipping `build/`, `.dsh-stm32/`, `node_modules/`, `.git/`; `includePrebuilt: true` also packs the `.elf`, `readme: false` skips the in-archive README, `outDir` moves the output (default `<name>-export.zip` next to the project) |
| `stm32_firmware_install` | One-stop firmware-package install: `dryRun` (default) returns only the plan — where it would land, which two source repos it would download, which checks must pass; `dryRun: false` + `confirm: true` actually downloads (HAL driver + CMSIS device support + core headers, ~2 MB total from GitHub), assembles an official-shaped `STM32Cube_FW_<family>_V<version>` package (writing `package.xml` itself) and runs five checks. Does nothing when the official package is already installed; installs into `<CubeMX root>/dsh-firmware` by default (not `Repository` — a self-made version there is silently ignored), and `stm32_generate` points CubeMX at it with `setCustomFWPath` |

### .ioc: read-only and transactions

| Tool | What it does |
| --- | --- |
| `stm32_ioc_inspect` | Parses MCU part, pins/signals/labels, peripherals and interrupts, clock tree, project settings; reports fatal risks such as "no Serial Wire means a generated `SWJ_DISABLE`" |
| `stm32_ioc_plan` | Step one of any `.ioc` change: computes a per-key diff plus the source SHA-256 and returns a `planId`, **without touching the source**. Supports setting/removing keys, adding GPIO from the chip pin table, one-shot Serial Wire repair, and retargeting clocks to the nearest reachable frequency (`clock: { targetHz }`, derived keys recomputed, per-peripheral frequencies reported) |
| `stm32_ioc_apply` | Requires a `planId`; re-checks the SHA before writing (refuses if the file changed meanwhile), backs up, replaces atomically, re-parses to validate, rolls back on failure. Supports `rollbackFrom` |

### Code and build

| Tool | What it does |
| --- | --- |
| `stm32_code_patch` | replace/append inside `USER CODE` blocks only; bytes outside (including CRLF) are preserved; backs up first, then writes a temp file and renames it. A wrong label lists every available label in the file |
| `stm32_generate` | Runs `java -jar STM32CubeMX.exe -q` headless, then places output under `Core/Src` and `Core/Inc`, carrying USER CODE from the old files by label. Background job by default. **When the `.ioc`, the CubeMX build and every output hash are unchanged it reuses the previous result** (`skipped: true`, ~1 s; pass `skipIfUnchanged: false` or delete `.dsh-stm32/generate-cache.json` to force a rerun). Projects that use no X-CUBE pack (`Mcu.ThirdPartyNb=0`) have `~/.stm32cubemx/thirdparties/pdsc` parked for the run and restored afterwards, saving ~25 s; pass `thirdpartyPacks: "keep"` to keep the index. **The need for the index is not guessed from keywords**: `Mcu.ThirdParty0=STMicroelectronics.X-CUBE-ALGOBUILD.1.4.0` in the `.ioc` is matched by name against a built-in pack catalog (67 packs, generated by `scripts/gen-xcube-catalog.mjs`), and a pack this machine lacks is reported in the notes up front |
| `stm32_build` | `cmake --build`, with the build directory inferred from `CMakePresets.json` and `build/*/CMakeCache.txt`; configures on first build; rejects the "CMakeCache directory mismatch but ninja exits 0" false success. With `artifacts: ["hex","bin"]` it converts the `.elf` afterwards via `arm-none-eabi-objcopy`; a failed conversion is only a note, not a build failure |

### Flash and debug

| Tool | What it does |
| --- | --- |
| `stm32_flash` | **Flash**: openocd `program verify reset exit`, no debug session, no halt at `main`. Reads the `.ioc` first and refuses when the debug port is disabled (see [Design notes](#design-notes)). Failures carry a structured `probeError`: `kind` (`no-probe` / `probe-busy` / `swd-locked` / `flash-protected` / `no-power` / `target-mismatch` / `timeout` / `unknown`, 8 in total), `cause` (one-line root cause), `hint` (an actionable next step, a dedicated one per kind), `evidence` (the raw log lines) and `retryable` (whether retrying after following the hint makes sense); on success the field is absent entirely. When no device is found the USB shape (no USB on this machine / probe unplugged / driver problem) is added to the notes |
| `stm32_debug_run` | Starts openocd + gdb, `break main` → `continue` → captures pc/sp/lr/bt/locals → `reset run` + `detach`; no Flash write, nothing left running. Hardware breakpoints / watchpoints above the chip limit (F1: 6 / 4) fail **before** openocd is started, so the probe is never touched |
| `stm32_debug_session` | Long-lived openocd session (`.elf` resolved automatically), closed after 90 s idle, hard limit 10 min |
| `stm32_debug_eval` | Runs gdb commands or reads expressions (e.g. `g_led_blink_count`) inside the session, then `resume` + `detach` immediately |
| `stm32_debug_stop` | Releases the probe immediately, idempotent |
| `stm32_regs_read` | Reads registers; each `addresses` entry accepts five forms: physical address `0x4001100C` / `4001100C`, symbol name `GPIOC.ODR` / `GPIOC->ODR`, or a bare peripheral `GPIOC` (dumps all its 7 registers in ascending offset, capped at 64). With the asset pack's `full` profile every sample carries the canonical name and the **set bit fields** (`GPIOC.ODR (0x4001100C) = 0x00000020  → ODR5=1`); an unknown peripheral lists the first 10 of the 53 available, an unknown register lists that peripheral's known registers; without SVD data plain addresses still read (just no names or bit fields) while a symbol name fails with a hint to run `stm32_assets refresh --profile full`. Finishes with `resume` instead of `reset run`, so a read does not wipe the firmware state; repeated reads reuse the resident openocd session (milliseconds, no extra process), and without a session one is started and kept for 90 s |
| `stm32_rtt` | **RTT logs** without a UART: `action: "start"` first reads three words with `mdw` to confirm a `SEGGER RTT` control block is really there (`addr` is the control block address, not a channel buffer), then issues `rtt setup/start/server start`; with no live session it starts one itself. `action: "dump"` reads for `seconds` (default 3 s) or up to `maxRecords` (default 200) and returns `records[{ t, level, text }]` — `level` is the **highest level kept** (1 error / 2 warn / 3 info / 4 debug, default 4 = everything), with `dropped` / `truncated` reported honestly. `action: "stop"` is idempotent (also run at turn end), `action: "status"` shows the port and uptime. The target must **actually be running** (`rtt start` reads live RAM). Failures carry `probeError`: an all-zero control block means the firmware never called `rtt_init()`, a magic mismatch means a wrong `addr`, a refused connection means the session died or port 9090 is taken |

### Adding RTT to the firmware (shortest example)

A register-level project (`route: "register"`) already ships `Core/Src/rtt.c` and `Core/Inc/rtt.h`, but **they are off by default**: with nobody referencing them, `--gc-sections` drops the code and the 3 KB ring buffers (the default firmware is 1576 B RAM / 1368 B FLASH and `nm` shows no `_SEGGER_RTT`). To turn logging on, add three lines inside a USER CODE block:

```c
/* USER CODE BEGIN 2 */          /* must come after clock init: timestamps use SystemCoreClock */
rtt_init();
rtt_printf(RTT_LEVEL_INFO, "boot: sysclk=%lu", (unsigned long)SystemCoreClock);
/* USER CODE END 2 */
```

(`rtt.h` already sits in `Core/Inc`; you may also add an explicit `#include "rtt.h"` to `USER CODE BEGIN Includes`.) After building, grab the control block address on the host:

```powershell
arm-none-eabi-nm build/Debug/<project>.elf | findstr _SEGGER_RTT
```

Then have the model run these three steps (three `stm32_rtt` tool calls, arguments named as in the tool schema):

```text
stm32_rtt action=start addr=0x20000DE0     # control block address from the nm line above
stm32_rtt action=dump seconds=3 level=3    # 3 s of info and above
stm32_rtt action=stop                      # releases the port; also runs at turn end
```

Enabling it moves RAM from 1576 B to 5232 B (three 1 KB rings plus the control block, about a quarter of the C8T6's 20 KB); FLASH grows with `rtt_printf` (mostly newlib's `vsnprintf` — use `rtt_write` for plain text to avoid it). HAL projects do not ship this source: follow `templates/scaffold/RTT.md`, copy `templates/register/Core/Src/rtt.c` to `App/rtt.c`, wire it into `cmake/user/CMakeLists.txt`, then add the same three lines to the USER CODE block. When a ring is full the **whole record is dropped** (never half of one) and `rtt_dropped_count()` reports the loss.

## Slash commands

Tools are for the model; when you want to act yourself, use a command — one command, one action, no model decision in between.

| Command | What it does | Touches the board |
| --- | --- | --- |
| `/stm32-doctor` | Health check: toolchain, busy debug processes, ports, `.elf`, `.ioc` warnings | No |
| `/stm32-setup` | Health check plus an install plan in one go; only actually installs when the command says so (e.g. `/stm32-setup install the missing ones`) | No |
| `/stm32-env` | Shows what each of the four capabilities (build / flash / debug / generate) is missing, what to install and how to self-check; a missing toolchain still renders the card | No |
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

## Chips, linker scripts and clocks

- **The part is a parameter, not a constant.** `stm32_project_create` / `stm32_generate` swap three things together from `mcu`: the startup file (`startup_stm32f103xe.s`), the device define (`STM32F103xE`) and the linker script (`STM32F103RCTx_FLASH.ld`). The HAL route goes through `src/engine/hal-chip.ts` (`resolveHalChip()` + `renderStartupAndDefine` / `renderLinkerScript` / `renderIoc`); the register route goes through `src/data/stm32f1.ts` (`resolveF1Chip()`, 14 density grades, every startup file pinned by upstream sha256). An unknown part returns a reason instead of inventing a startup file that does not exist upstream.
- **Linker scripts are named after the `DeviceId`: `<DeviceId>_FLASH.ld`.** C8T6 → `STM32F103C8Tx_FLASH.ld` (64 KiB Flash / 20 KiB RAM), RCT6 → `STM32F103RCTx_FLASH.ld` (256 / 48), F107VCT6 → `STM32F107VCTx_FLASH.ld` (256 / 64). The old `STM32F103XX_FLASH.ld` in the template survives only as a C8T6 compatibility copy; CMake's `-T` always points at the rendered one (`pointLinkerFlagAt()` rewrites the old name inside the toolchain file so you never end up with two `-T` flags and the wrong script).
- **Clocks: nearest, and say so when unreachable.** `stm32_ioc_plan`'s `clock: { targetHz }` (or `pllMul` to pin the multiplier, `pllSource` to pick HSE / HSI) enumerates every reachable PLL combination, takes the one with the smallest |SYSCLK − target| and states the gap: for 60 MHz the F1 PLL only multiplies integers and HSE 8 MHz cannot hit that step, so it picks 64 MHz and reports "unreachable, chose 64 MHz (+4 MHz)" (ties go to the higher step). The same plan **recomputes every derived key** (`SYSCLKFreq_VALUE`, `HCLKFre`, `PLLMUL`, APB1/APB2/ADC dividers) — changing only SYSCLK leaves CubeMX recomputing from stale values or ignoring them — and lists per-peripheral frequencies, UART baud error and a few alternatives. On an out-of-range request (SYSCLK > 72 MHz, APB1 > 36 MHz, ADC > 14 MHz, USB wanting 48 MHz outside PLLCLK/1.5) it **writes no key at all**.
- **Five consistency checks before flashing.** `stm32_doctor` cross-checks `.ioc` part ↔ startup file name ↔ device define in cmake ↔ `.ld` MEMORY sizes ↔ `.elf` Flash usage, and reports a blocker on any mismatch. The `.elf` figure sums `p_filesz` from the ELF program headers rather than using the file size — with `-g3` a 20 KiB firmware produces a 600 KB `.elf`, which would false-alarm "over Flash".
## Configuration

### User config file (`~/.dsh-stm32/config.json`)

The plugin remembers where the toolchain lives. `stm32_env_install` writes this file when it finishes, and every tool reads it — **no DSH restart, no environment variables**. Hand-writing it works too:

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

An empty `binDirs` is derived from `msys64` as `<msys64>/ucrt64/bin` — the shape the installer writes. A corrupt file (invalid JSON) never makes a tool fail; it is simply treated as "not configured".

**Precedence**: tool arguments (`binDirs` / `cubeMxRoots`) > environment variables > this config file > built-in defaults; auto-discovered installs are only appended when no argument was given.

### Settings panel (GUI)

The config file above can also be edited without a terminal: **Settings → STM32 toolchain** in DSH (a browser-side panel shipped with the plugin, same origin, no extra dependency). Three cards:

- **Where it is installed**: reads the current config; edit `msys64` / `cubeMxRoot` / extra `binDirs` and save — it writes the same file, and the next tool call picks it up without restarting DSH;
- **What is missing**: one probe run (it executes each tool's version command, installs nothing) showing the resolved path and version per tool, the `hint` for missing ones, plus four capability badges (build / flash / debug / generate);
- **Install the toolchain**: first a plan (steps, download size, how PATH and the config file would change), then **a second click to confirm** before anything is installed; progress and the log tail stream into the card. It drives the very same installer as `stm32_env_install`. When the toolchain is already complete, the plan is a single line — "toolchain complete, nothing to install" — instead of seven skipped steps.

The panel talks to six `/dsh-stm32/api/*` routes the plugin registers on the host (read config, save config, probe, install plan, install start, install state). The bundle is `lib/client.js`, source in `client/client.js`, copied verbatim by `npm run build` — hand-written plain JS requiring only `react`, no bundler and no runtime dependency. When the host has no `webServer` service (a pure CLI composition) this layer is skipped silently; tools and slash commands are unaffected.

### Download cache (register-route template)

What the register route needs — CMSIS device headers, the startup file, core headers — is **not vendored into the plugin** (covering any STM32 part would make the package unusable), so it is downloaded on first use into a searchable cache directory and reused from then on:

- Location: `DSH_STM32_CACHE` (supports `~`) > `%LOCALAPPDATA%\dsh-stm32\cache`;
- Index: `index.json` under the cache root records each entry's source URLs, byte counts and license (`THIRD_PARTY_NOTICES.md` is written alongside);
- Sources: tried in the order `fastly.jsdelivr` → `cdn.jsdelivr` → `raw.githubusercontent` → `ghproxy`; an HTTP error, HTML-looking body or an implausible byte count counts as a failed source;
- A partial download is deleted outright (a half cache is worse than none); missing or size-mismatched files trigger a re-download on the next run;
- Visible and removable: `stm32_cache` with `list` / `verify` / `fetch` / `purge`.

### Firmware packages (HAL route)

Having CubeMX installed does not mean the package for **this particular part** is there — it is not part of the installer and has to be added in the package manager. For the families the plugin can fetch, `stm32_firmware_install` assembles it from two GitHub source archives:

- What it downloads: `stm32f1xx-hal-driver` (HAL driver, BSD-3-Clause) + `cmsis-device-f1` (device headers and startup file, Apache-2.0) + five CMSIS core headers — about 2 MB, a few seconds;
- Why the `STM32CubeF1` source archive is not enough: its HAL and CMSIS device directories are **git submodules**, so the tarball ships them empty — unpacking it yields a package that cannot compile (no startup file, no HAL sources);
- Where it lands: `<CubeMX root>/dsh-firmware/<package>` by default (a plugin-owned folder next to `Repository`, official packages untouched); only if that root is not writable does it fall back to the user cache. **Do not drop self-made version names into `Repository`** — measured: CubeMX does not recognise that version, silently falls back to the package it knows, and reports a successful generation with stale HAL files;
- How generation picks it up: `stm32_generate` resolves the package named in the `.ioc` (`ProjectManager.FirmwarePackage`), looking in both `Repository` and `<CubeMX root>/dsh-firmware`, and passes `project setCustomFWPath <package dir>` to the CubeMX script — the only mechanism proven to work, and it leaves no absolute path in the `.ioc`;
- The assembled package matches the official layout: a six-line `package.xml` (version tags `FW.<family>.<x.y.z>`) and `THIRD_PARTY_NOTICES.md`, with **no manifest or hashes** — CubeMX does not verify provenance either (measured: generating with `setCustomFWPath` copies HAL sources byte-for-byte out of our directory);
- But "generation succeeded" proves nothing: with a non-existent package name in the `.ioc`, CubeMX prints no error, exits 0 and simply skips copying HAL. So five checks are mandatory (core headers / HAL Inc / HAL Src / device headers / `startup_*.s`), and the installer runs them right after assembling.

### Environment variables (optional)

| Variable | Purpose | Default |
| --- | --- | --- |
| `STM32_BIN_DIRS` | Toolchain directory candidates, `;`-separated; **replaces** the built-in list (auto-discovered dirs are still appended after it) | `C:/msys64/ucrt64/bin`, `C:/msys64/mingw64/bin` |
| `STM32_CUBEMX_ROOT` | STM32CubeMX installation root; **replaces** the built-in list | `C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX` |
| `STM32_NO_DISCOVER` | Set to `1` / `true` to turn auto-discovery off (CI, or when you only want the built-in list) | unset = on |
| `DSH_STM32_CONFIG` | Point the config file elsewhere (several toolchains / project isolation) | `%USERPROFILE%\.dsh-stm32\config.json` |
| `DSH_STM32_NO_CONFIG` | Set to `1` / `true` to ignore the config file entirely (environment variables only) | unset = read |
| `DSH_STM32_CACHE` | Download cache root (register-route template etc.), supports `~` | `%LOCALAPPDATA%\dsh-stm32\cache` |
| `DSH_STM32_E2E_PROJECT` | Project used by hardware e2e runs (with `openocd.cfg` and `build/Debug/*.elf`) | none |
| `DSH_STM32_E2E_ROOT` | Scratch directory for e2e copies | system temp |

Per-call arguments work too: flash/debug tools accept `binDirs`, `elfPath`, `buildDir`, `configFile`, `adapterSpeed`; generate/create accept `cubeMxRoots`, `firmwarePackage`.

**Auto-discovery (a different machine usually needs no variables at all).** When `binDirs` / `STM32_BIN_DIRS` is not given, the plugin scans common locations once and **appends** what it finds to the end of the candidate list:

- Toolchain: `ucrt64/bin`, `mingw64/bin`, `clang64/bin` under `<drive>/msys64`, `<drive>/msys2`, `<drive>/app/msys64`, `<drive>/tools/msys64`, `%LOCALAPPDATA%/Programs/msys64` (the directory must actually contain `arm-none-eabi-gcc.exe` / `openocd.exe` / `cmake.exe`).
- CubeMX: registry `HKLM|HKCU\SOFTWARE\STMicroelectronics\STM32CubeMX` → `InstallDir`, `...\Uninstall\STM32CubeMX` → `InstallLocation`, plus `STM32CubeMX` under `<drive>/`, `<drive>/app`, `<drive>/tools`, `Program Files\STMicroelectronics\STM32Cube`, `%LOCALAPPDATA%/Programs` (both `STM32CubeMX.exe` and `jre/bin/java.exe` must exist).

One scan takes about a second and is cached per process. **Explicit `binDirs` / `cubeMxRoots` arguments are used as-is, with nothing appended** — what you point at is what runs, so "I specified it" never turns out to be a lie. Paths from environment variables are normalized first (quotes stripped, backslashes to slashes, duplicate slashes collapsed), so a quoted `setx "D:\app\msys64\ucrt64\bin"` is fine. When a tool is missing, both the error message and `stm32_doctor`'s notes list every directory that was searched.

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
| **STM32F1 family** only | The part → startup file / device define / linker script maps exist for F1 only (`src/data/stm32f1.ts` + `src/engine/hal-chip.ts`, 14 density grades); the clock tree knows F1 only (HSE 8 MHz, PLL ×2..×16, SYSCLK ≤72 MHz) | Another family needs real repo names plus per-file measured sha256 (`src/data/cmsis-sources.ts`, `src/data/firmware-packages.ts`) and a clock-limit table; the pin table itself can be derived from the local CubeMX `db/mcu/*.xml` (`deriveChipPinTable`) |
| Default probe is **CMSIS-DAP** | Falls back to cmsis-dap without an `openocd.cfg` | Put `interface/stlink.cfg` into `openocd.cfg` (see above) |
| Adding a peripheral needs a **manual HAL source entry** | The plugin only relocates CubeMX's `Src/` and `Inc/` (→ `Core/Src`, `Core/Inc`); the `cmake/stm32cubemx/CMakeLists.txt` CubeMX emits is not applied. Enable a timer/UART/ADC and you must add the matching `stm32f1xx_hal_<peripheral>.c` yourself | Edit `STM32_Drivers_Src` in the project's `cmake/stm32cubemx/CMakeLists.txt`, or add a `target_sources` line in `cmake/user/CMakeLists.txt` |
| Generation/scaffolding needs **CubeMX + the F1 firmware package** | Package version defaults to `STM32Cube_FW_F1_V1.8.7` | Pass another version via `firmwarePackage` |
| Not yet verified on other machines | This machine: Windows 10 + MSYS2 UCRT64 + DAPLink + a Blue Pill; other combinations rely on your feedback | Open an issue with the full `stm32_doctor` output |
| **RTT channel 0 only**, and the frame format is ours | `stm32_rtt` parses channel 0 only, with a 13-byte header (4 B length + 1 B level + 8 B timestamp + UTF-8 text); it is neither defmt nor SEGGER raw bytes — a native client (RTT Viewer / J-Link RTT Client) reading channel 0 sees that header as payload. RTT also lives in target RAM: no `rtt_init()` means no control block, and a full ring drops records | Use `level` as a filter (`level: 3` keeps info and above), put JSON in `text` for structured output; change channel count and buffer size via `RTT_UP_CHANNELS` / `RTT_BUF_SIZE` in `rtt.h` (default 3 × 1 KB = 3 KB `.bss` on a 20 KB C8T6); defmt decoding or native RTT output would be a separate feature |
| Register **symbol names and bit-field decoding need the asset pack's `full` profile** | `GPIOC.ODR` / `GPIOC->ODR` and peripheral dumps (a bare `GPIOC`) are resolved from `device/f1/svd/<line>.json`, derived from ST's SVDs (ST EULA, 1.71 MiB), which `core` (30 files ≈ 237 KiB) does not contain; only lines 100/101/102/103/105/107 exist. Without SVD data plain addresses still read, just with no names or bit fields; a symbol name fails with an actionable hint | `stm32_assets action="refresh" profile="full"` (128 files); or just use `0x…` addresses |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERR_PNPM_GIT_UNKNOWN_ERROR … connect ETIMEDOUT …:443` while installing | The **package fetch hop** cannot reach GitHub (`dsh plugin add github:…` clones over git). It is unrelated to the pnpm 11 `allowBuilds` allow-list, package signatures, or a broken tarball — the same command works from another network. Three options, easiest first: (1) install the published package: `dsh plugin --profile desktop add dsh-stm32` (npm registry, no GitHub); (2) if you must install from GitHub, proxy **only that one command** with process-scoped `GIT_CONFIG_*` (your global git config stays untouched): `$env:GIT_CONFIG_COUNT="1"; $env:GIT_CONFIG_KEY_0="http.https://github.com.proxy"; $env:GIT_CONFIG_VALUE_0="http://127.0.0.1:7890"; dsh plugin --profile desktop add github:JingYu-er/dsh-stm32#main` (use your own port); (3) skip git entirely and take the HTTPS tarball: `dsh plugin --profile desktop add https://codeload.github.com/JingYu-er/dsh-stm32/tar.gz/refs/heads/main`. For the newest code use `github:JingYu-er/dsh-stm32#main`; for a published release use `dsh-stm32@latest` — same content, no GitHub dependency |
| SWD lost after flashing | The firmware generated `__HAL_AFIO_REMAP_SWJ_DISABLE()`. Hold BOOT0 while powering up to enter the system bootloader and reflash, then set SYS back to Serial Wire — `stm32_flash` now blocks this case first |
| `Error: No device found` / `transfer count mismatch` | Another process holds the probe. Run `/stm32-stop`, then use `stm32_doctor` to inspect openocd / gdb processes and port 3333. Reading registers while a debug session is open no longer hits this: `stm32_regs_read` reuses the session's openocd instead of starting a second one |
| Reading registers with a live session shows a `gdb-multiarch … target extended-remote 127.0.0.1:3333` `report.command` | That is the normal "reuse" shape: while `stm32_debug_session` is alive, `stm32_regs_read` borrows that session's openocd and the notes say "reusing the debug session (gdb port N, tcl port M), no extra openocd". Since B3 the default path is **direct Tcl RPC** (one TCP connection: halt → read pc → consecutive `mdw` → resume, milliseconds), so a `gdb-multiarch …` `report.command` only means the Tcl fast path failed and it fell back to the session's gdb — the reason is in the notes. Only without a session does it start its own openocd. Older builds failed here with `CMSIS-DAP transfer count mismatch: expected N, got M` |
| Build "succeeds" but the old firmware runs | The project was copied or renamed with `build/` included: the CMakeCache directory no longer matches, yet ninja still exits 0. `stm32_build` treats that as a failure; clean or delete `build/Debug` as prompted |
| A tool answers "missing arm-none-eabi-gcc …, X was not started" | That is the pre-flight gate (`envCheck` defaults to `block`) doing its job, not a bug: it is cheaper than discovering the problem halfway through. Answer "install", and the model runs `stm32_env_install` for a plan; after you confirm, the toolchain is installed and the config written — **the next call works without a restart**. Run `/stm32-env` for the whole picture, or pass `envCheck: "warn"` (continue with a warning) / `"off"` (skip the check) |
| The first project build answers "device facts are not ready … run stm32_assets refresh, or check the network" | The plugin ships no chip table: part → startup file / device define / Flash / RAM come only from the local assets cache (`~/.dsh-stm32/assets/<version>/`). Once online, run `stm32_assets` (`action: "refresh"`, default `profile: "core"`, 30 files ≈ 237 KiB); offline afterwards. `DSH_STM32_ASSETS` overrides the root |
| `stm32_doctor` cannot find gcc / openocd | First read the "searched ..." list and the auto-discovery line in the doctor notes / error; if it is installed elsewhere, set `STM32_BIN_DIRS` or pass `binDirs`. **If you do not know what to install, run `stm32_env_probe` first**: every missing component carries `impact` (what stops working), `install` (recommended way, easiest first) and `verify` (self-check after installing), while the top-level `recommendations` gives the install order and offers to install for you |
| `stm32_generate` feels stuck | The first run (cold start, no cache) legitimately takes 3.5–4 minutes; later runs are skipped (<1 s) while the `.ioc` and outputs are unchanged. It runs as a background job by default — watch it with `job_output`, or pass `foreground: true`. Check `skipped` in the result and the reason in the notes to see whether the cache hit |
| It regenerates for 3 minutes even though nothing changed | The cache key covers the CubeMX `size:mtime` and every output hash, so swapping CubeMX, editing generated files or changing the layout invalidates it. Read the reason in the notes, or delete `.dsh-stm32/generate-cache.json` |
| Generate got faster but the CubeMX GUI no longer lists expansion packs | With `thirdpartyPacks: "auto"` the `thirdparties/pdsc` directory is parked as `pdsc.dsh-parked` when no pack is needed and restored after the run. Pass `thirdpartyPacks: "keep"` while picking packs by hand in the CubeMX GUI |
| The notes say the local pack index has no such pack | An X-CUBE pack the project needs is not installed here (the decision matches `Mcu.ThirdParty<k>` in the `.ioc` against the built-in catalog by name). Install it in the CubeMX *Manage embedded software packages* dialog, then generate again. This note also shows up in **failed** generate reports (a timeout or a CubeMX error still carries the notes — read them before guessing). The catalog is a snapshot: after installing new packs, rerun `node scripts/gen-xcube-catalog.mjs` (an older catalog only fails to recognise new packs, it never wrongly decides the index is unnecessary) |
| `stm32_code_patch` says the block does not exist | `main.c` uses short labels (`PV` = private variables, `PFP` = prototypes, `2` = init before while, `3` = loop body); the error lists every available label — copy one from there |

## Development and testing

```powershell
npm run build            # tsc -> lib/ (lib/ is committed: rebuild before you commit)
npm test                 # 34 offline suites, 497 cases; no board, CubeMX, or toolchain needed
npm run test:pack        # pack a tarball, unpack it, scaffold a real register project from the unpacked lib
npm run test:size        # package guard: tarball <=1.2 MB, templates <=60 KB, no binaries/diagrams inside
```

CI (`.github/workflows/ci.yml`) runs `npm ci → build → check that the committed lib/ matches src/ → npm test → test:pack → test:size` on every push and PR (windows-latest).

A GitHub runner has neither msys64 nor CubeMX, so two scaffolding cases that need the real firmware package are skipped: CI reports **495 passed + 2 skipped**, while a developer machine runs all 497. The offline suites only read the bundled [`test/fixtures/`](test/fixtures/README.md); the session cases build a fake toolchain directory with `fakeBinDirs()` (empty placeholder files for openocd / gdb), so nothing depends on what is installed locally.

### What ships where (decide before you add a file)

| Where | What | Size |
| --- | --- | --- |
| npm tarball | `lib/**` (including `lib/client.js`), `client/client.js`, `templates/scaffold/**`, `cordis.patch.yml`, both READMEs, `LICENSE`, `docs/*.md` | 99 files / 525.7 KB packed, 1538.3 KB unpacked; `templates/**` alone is 38.5 KB |
| Git only, not packed | `src/**`, `test/**`, `scripts/**`, `docs/diagrams/**` (two interactive HTML pages) | diagrams are 2 MB raw / 891 KB gz; `files` in `package.json` narrows `docs` to `docs/*.md` |
| Downloaded on demand | CMSIS device headers / startup files / core headers (fetched into the cache on first use, pinned per file by sha256); HAL firmware packages; the **device-facts asset pack** (chips.json / memory.json / .ioc templates / .ld / SVD — 30 files ≈ 237 KiB for the core profile, 128 files for `full`, which is where the SVDs live — the plugin ships no chip table, the first run needs one online `stm32_assets refresh` and it is offline afterwards) | manage the caches with `stm32_cache list/verify/purge` and `stm32_assets list/verify/prune` |
| Rendered on the spot | `.ioc` content (`renderIoc`), `.ld` MEMORY (`renderLinkerScript`), the cmake source list | rendered per part, never stored as a template |

The guard is `scripts/pack-size.mjs` (`npm run test:size`): tarball ≤ 1.2 MB (1 200 000 B), `templates/**` ≤ 60 KB, no `.png/.jpg/.gif/.webp/.bmp/.pdf/.html/.zip/.7z/.exe/.dll` inside, and `README.md` / `README_EN.md` / `LICENSE` / `cordis.patch.yml` / `docs/reading-guide.md` all present.

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
  tools/                   the 21 tools, L3 (parameter schema + output contract + rendering)
  engine/                  pure logic and workflows (generate / build / flash / debug / ioc / scaffold …)
  commands/register.ts     the 7 slash commands
  skill/stm32-workflow.ts  the SKILL shipped with the plugin
  data/                    paths and chip data (paths are data, not logic)
templates/scaffold/        project template snapshot (CMake / .ld / .vscode / .ioc)
test/                      offline suites (36, registered in run-units) + fixtures + hardware e2e
scripts/                   guards and generators (pack-size / pack-smoke / gen-xcube-catalog / copy-client)
docs/                      specification + development notes + reading guide + diagrams/ (not packed)
```

## Documentation

- [Specification](docs/dsh-stm32-plugin-规格.md): tool contracts, state machine, acceptance criteria A1–A13
- [Development notes](docs/development-notes.md): milestones, host-contract pitfalls, implementation details and measured numbers
- [Source reading guide](docs/reading-guide.md): layered reading order, per-file responsibilities and exports, 14 flow diagrams, 23 invariants
- Visuals: [architecture](docs/diagrams/dsh-stm32-architecture.html) / [main journey](docs/diagrams/dsh-stm32-journey.html) — single-file HTML, opens offline, exports PNG/SVG

## License

[MIT](LICENSE)
