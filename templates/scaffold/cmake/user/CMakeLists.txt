# 你自己的源文件写在这里（CubeMX 不生成这个文件的内容）。
# 例：
#   target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App/app.c)
#   target_include_directories(stm32cubemx INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/../../App)
#
# RTT（可选，步骤见工程根目录的 RTT.md）：把插件的 templates/register/Core/{Src/rtt.c,Inc/rtt.h}
# 拷到 App/，然后：
#   target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App/rtt.c)
#   target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../App)
# 再到 Core/Src/main.c 的 USER CODE BEGIN Includes 加 #include "rtt.h"、
# USER CODE BEGIN 2 加 rtt_init()。别把 rtt.c 放进 Core/Src：那是 CubeMX 生成区。
