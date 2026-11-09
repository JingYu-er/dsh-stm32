# STM32 内置资源（assets/）

这是 [`dsh-stm32`](../) 插件的**内置资源目录**，随 npm 包一起分发。2026-11 起它从独立仓库
`dsh-stm32-assets` 并入插件仓库：不再有第二个仓库，也不再需要联网 `refresh`，装好插件即离线可用。

运行时按 **flat 布局**读：`assets/manifest.json` 与 `device/`、`ioc/` 等同层。
`lib/engine/assets.js` 从包根解析 `assets/`；`DSH_STM32_ASSETS` 仍可指向外部目录（开发与测试用），
外部目录既可以也是 flat，也可以保留旧的 `<版本>/install.json` 多版本布局。

## 目录

| 路径 | 内容 | 数量 |
| --- | --- | --- |
| `device/<族>/chips.json` | 设备事实：CPN、启动文件、设备宏、Flash/RAM、引脚数等 | 21 族 |
| `device/f1/svd/<line>.json` | F1 六条产品线的外设 → 寄存器 → 位域 | 6 |
| `ioc/family/<FAM>.ioc` | 每族一份 CubeMX 认证过的最小工程模板 | 20 |
| `ioc/minimal/` | F1 每条产品线各容量档的最小 .ioc | 14 |
| `ld/f1/` | F1 每个容量档一份 `<DeviceId>_FLASH.ld` | 14 |
| `startup/f1/` | F1 gcc 启动文件（离线兜底） | 14 |
| `headers/f1/` | F1 CMSIS 设备头 + `stm32f1xx.h` + `system_stm32f1xx.h` | 16 |
| `templates/family/` | 生成 `ioc/family/` 的源模板（不在 manifest 里） | 21 |
| `manifest.json` | 资产清单 v2：版本、profiles、逐文件 sha256 | — |
| `VERSION` | 资产版本号 `YYYY.MM.DD-N` | — |

`manifest.json` 的 profile 是**逻辑分层**，不是安装开关（包内文件始终齐全）：

- **core = 建工程必需**（75 个文件）：`device/**`、`ioc/**`、`ld/**`。
- **full = core 再加**（105 个文件）：`startup/**`、`headers/**`。

SVD 只在 `full` 逻辑层里；寄存器符号名/位域解析需要它，纯地址读不需要。

## 生成物，不要手改

这些文件全部由 `scripts/assets/` 下的脚本生成。手改会在下一次 `--check` 时暴露为哈希不一致。

```bash
# 校验现有资产与 manifest 是否一致（不写盘）
node scripts/assets/build-assets.mjs --check

# 全量重建（需要本机 CubeMX db 与 STM32Cube 固件包）
node scripts/assets/build-assets.mjs

# 只重建指定族 / 指定 SVD
node scripts/assets/build-assets.mjs --families C0,F4
node scripts/assets/build-assets.mjs --svd path/to/STM32F103.svd --svd-dir path/to/svd-dir
```

常用参数：`--plugin <dir>`（插件根，默认自动推断）、`--cube-mx <dir>`、`--firmware <dir>`、
`--family-templates <dir>`、`--check`、`--help`。生成脚本：

- `build-assets.mjs`：总入口，写 `manifest.json` / `VERSION` 与 F1 资产；
- `family-assets.mjs`：从 CubeMX db 与固件包生成 `device/<族>/chips.json` 与 `ioc/family/<FAM>.ioc`；
- `svd-f1.mjs`：SVD XML → `device/f1/svd/<line>.json`。

数据来源与降级：芯片事实只从本机 CubeMX `db/mcu` 的 XML 与固件包算，**不手写事实表**；
缺 CubeMX / 固件包 / SVD 时宁可构建失败，也不产出半份资产。SVD 只保留编译后的寄存器与位域事实，
不复制 ST 的说明文字（原始 SVD 受 ST EULA 约束，不能随插件分发）。

## manifest.json（v2）

```jsonc
{
  "name": "dsh-stm32-assets",
  "version": "2026.11.04-2",          // = VERSION
  "schema": 2,
  "generatedBy": "scripts/assets/build-assets.mjs",
  "profiles": {
    "core": ["device/**", "ioc/**", "ld/**"],
    "full": ["device/**", "ioc/**", "ld/**", "startup/**", "headers/**"]
  },
  "files": [
    { "path": "device/f1/chips.json", "bytes": 0, "sha256": "…", "source": "…", "profile": "core" }
  ]
}
```

运行时用 `stm32_assets` 的 `list` / `verify` 查看与逐文件校验；`prune` 只清理
`DSH_STM32_ASSETS` 下遗留的历史版本目录，**不会删除包内资源**。

## 许可与来源

- 设备头、启动文件、链接脚本来自 STM32Cube 固件包（ST 许可，随插件作为工程模板的一部分使用）。
- `device/**/chips.json`、`ioc/**`、`ld/**`、`device/f1/svd/**` 是从 CubeMX db、固件包与 CMSIS-SVD
  推导出的**事实数据**，由本仓库脚本生成；生成脚本与产物一起入库，便于追溯。
- 架构图在插件 `docs/diagrams/`，不属于本目录。
