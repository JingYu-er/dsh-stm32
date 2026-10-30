cmake_minimum_required(VERSION 3.22)

# ======== 由 STM32CubeMX 生成的工程结构，但这份 CMakeLists 是手写的模板 ========
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Debug")
endif()

set(CMAKE_PROJECT_NAME __PROJECT_NAME__)
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

project(${CMAKE_PROJECT_NAME})
message("Build type: " ${CMAKE_BUILD_TYPE})

# ---------------- 链接脚本：按型号渲染的那一份 ----------------
# 工具链文件（cmake/gcc-arm-none-eabi.cmake）为了兼容 CubeMX 工程，默认已经塞了
#   -T "<源码目录>/STM32F103XX_FLASH.ld"
# 寄存器路线不用那份写死 C8T6（64K/20K）的脚本，而是用生成时按芯片 Flash/RAM 渲染的
# <DeviceId>_FLASH.ld。这里把链接参数里那条 -T 换掉：不换的话会出现两个 -T，
# 先命中的是那份 C8T6 脚本，尺寸不对的芯片（例如 F103ZE 512K）会被截断或越界。
set(DSH_LINKER_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/__LINKER_SCRIPT__")
if(NOT EXISTS "${DSH_LINKER_SCRIPT}")
    message(FATAL_ERROR "链接脚本不存在：${DSH_LINKER_SCRIPT}（stm32_project_create route=register 会按型号生成它）")
endif()
string(REGEX REPLACE "-T[ ]+(\"[^\"]*\"|[^ ]+)" "-T \"${DSH_LINKER_SCRIPT}\"" DSH_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS}")
set(CMAKE_EXE_LINKER_FLAGS "${DSH_EXE_LINKER_FLAGS}")
message("Linker script: " ${DSH_LINKER_SCRIPT})

enable_language(C ASM)

# ---------------- 可执行文件 ----------------
# 只编译三个源：用户 main.c、CMSIS 的 system_stm32f1xx.c、启动文件。
# 设备头与内核头通过下面两个 include 目录提供，全部来自下载缓存。
add_executable(${CMAKE_PROJECT_NAME}
    Core/Src/main.c
    Drivers/CMSIS/Device/ST/__FAMILY_DIR__/Source/Templates/system_stm32f1xx.c
    Drivers/CMSIS/Device/ST/__FAMILY_DIR__/Source/Templates/gcc/__STARTUP_FILE__
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Inc
    Drivers/CMSIS/Include
    Drivers/CMSIS/Device/ST/__FAMILY_DIR__/Include
)

# __DEVICE_DEFINE__ 由 stm32f1xx.h 用来选中具体型号头（stm32f103xb.h 之类）
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE __DEVICE_DEFINE__)

target_link_libraries(${CMAKE_PROJECT_NAME} ${TOOLCHAIN_LINK_LIBRARIES})
