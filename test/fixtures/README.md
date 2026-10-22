# 测试夹具

离线单测（`node test\run-units.mjs`）只依赖这里，不依赖开发机上的真实工程，
所以任何人 `git clone` 下来都能跑：

| 文件 | 用途 |
| --- | --- |
| `project/demo.ioc` | 8 引脚 + RCC + SWD 的 STM32F103C8T6 配置，`ioc-units` / `ioc-plan-units` / `schema-guard` 用它 |
| `scratch.ioc` | 只有 Ports、`MainLocation=Src` 的另一种形状，验证解析器不靠特例 |
| `project/openocd.cfg` | `flash-units` 验证"优先用工程里的 cfg" |
| `project/CMakePresets.json` + `project/build/Debug/CMakeCache.txt` | `build-units` 验证按 preset 与 `build/*/` 两种方式找构建目录 |
| `project/build/Debug/demo.elf` | **占位文件**（4 KB 的 0），只为验证 `.elf` 的定位与大小判断，不可烧录 |
| `project/Core/Src/main.c`、`project/_scratch/Src/main.c` | `engine-units` 用真实 CubeMX 产物验证 USER CODE 合并（含标签缺失上报） |

需要真板子或真 CubeMX 的 e2e（`test/e2e-*.mjs`）不吃这套夹具，它们用环境变量指路：

- `DSH_STM32_E2E_PROJECT`：一个可编译、可烧录的 STM32 工程（默认 `fixtures/project`，但那个不能烧）；
- `DSH_STM32_E2E_ROOT`：放临时副本的目录（默认系统临时目录）。
