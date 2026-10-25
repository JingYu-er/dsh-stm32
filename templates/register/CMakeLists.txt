cmake_minimum_required(VERSION 3.22)

# 寄存器版工程（无 CubeMX、无 HAL）。
# 这个文件由 dsh-stm32 生成，模板来源 templates/register/CMakeLists.txt。
# 与 HAL 工程共用同一个工具链文件与链接脚本，差别只在源文件与头文件搜索路径：
# 不需要 Core/Inc/main.h 里的 MX_* 声明，也不需要 stm32cubemx 这个 INTERFACE 库。

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

enable_language(C ASM)

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

# 设备宏（例如 STM32F103xB）：设备头靠它选中具体型号的寄存器定义。
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE __DEVICE_DEFINE__)

target_link_libraries(${CMAKE_PROJECT_NAME} ${TOOLCHAIN_LINK_LIBRARIES})
