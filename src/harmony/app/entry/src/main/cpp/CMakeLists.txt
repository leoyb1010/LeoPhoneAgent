cmake_minimum_required(VERSION 3.16)
project(LeoLinux C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(ISH_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/generated/ish")
set(SQLITE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/generated/sqlite")
if(NOT EXISTS "${ISH_ROOT}/kernel/init.c")
  message(FATAL_ERROR "Run src/harmony/scripts/prepare_linux.py before building the HAP")
endif()
include("${CMAKE_CURRENT_SOURCE_DIR}/generated/sources.cmake")
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/cpu-offsets.h"
  COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/generate_offsets.py"
    "${CMAKE_C_COMPILER}" "${CMAKE_SYSROOT}" "${ISH_ROOT}" "${SQLITE_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}"
  DEPENDS "${ISH_ROOT}/asbestos/offsets.c" "${ISH_ROOT}/emu/arch/arm64/cpu.h" "${ISH_ROOT}/asbestos/frame.h")
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/libvdso.so.elf"
  COMMAND ${CMAKE_C_COMPILER} -target aarch64-linux-gnu -fuse-ld=lld -nostdlib -shared -fPIC -ffreestanding
    -Wl,--hash-style,sysv "-Wl,-T,${ISH_ROOT}/vdso/arm64/vdso.lds"
    "${ISH_ROOT}/vdso/arm64/vdso.S" "${ISH_ROOT}/vdso/arm64/vdso.c" -o "${CMAKE_CURRENT_BINARY_DIR}/libvdso.so.elf"
  DEPENDS "${ISH_ROOT}/vdso/arm64/vdso.S" "${ISH_ROOT}/vdso/arm64/vdso.c")
add_library(leolinux SHARED ${ISH_SOURCES} "${SQLITE_ROOT}/sqlite3.c" linux_core.c linux_io.c linux_platform.c linux_napi.cpp
  "${CMAKE_CURRENT_BINARY_DIR}/cpu-offsets.h" "${CMAKE_CURRENT_BINARY_DIR}/libvdso.so.elf")
set_source_files_properties("${ISH_ROOT}/kernel/vdso.c" PROPERTIES OBJECT_DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/libvdso.so.elf")
target_include_directories(leolinux PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" "${ISH_ROOT}" "${ISH_ROOT}/vdso/arm64" "${SQLITE_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_definitions(leolinux PRIVATE _GNU_SOURCE GUEST_ARM64=1 ENGINE_ASBESTOS=1 LOG_HANDLER_DPRINTF=1 SQLITE_THREADSAFE=1)
target_compile_options(leolinux PRIVATE -Wno-format -Wno-switch -Wno-unused-value)
target_link_options(leolinux PRIVATE -Wl,--no-undefined -Wl,-Bsymbolic)
target_link_libraries(leolinux PUBLIC ace_napi.z pthread m dl)

option(LEO_LINUX_DEVICE_PROBE "Build an on-device iSH core integration harness" OFF)
if(LEO_LINUX_DEVICE_PROBE)
  add_executable(leo_linux_probe ${ISH_SOURCES} "${SQLITE_ROOT}/sqlite3.c" linux_core.c linux_io.c linux_platform.c linux_probe_main.c linux_lifecycle_probe.c
    "${CMAKE_CURRENT_BINARY_DIR}/cpu-offsets.h" "${CMAKE_CURRENT_BINARY_DIR}/libvdso.so.elf")
  target_include_directories(leo_linux_probe PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" "${ISH_ROOT}" "${ISH_ROOT}/vdso/arm64" "${SQLITE_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}")
  target_compile_definitions(leo_linux_probe PRIVATE LEO_LINUX_DEVICE_PROBE=1 _GNU_SOURCE GUEST_ARM64=1 ENGINE_ASBESTOS=1 LOG_HANDLER_DPRINTF=1 SQLITE_THREADSAFE=1)
  target_compile_options(leo_linux_probe PRIVATE -Wno-format -Wno-switch -Wno-unused-value)
  target_link_libraries(leo_linux_probe PUBLIC pthread m dl)
endif()

option(LEO_LINUX_PROBE_STRACE "Trace controlled guest fixtures in the device-only harness" OFF)
if(LEO_LINUX_DEVICE_PROBE AND LEO_LINUX_PROBE_STRACE)
  target_compile_definitions(leo_linux_probe PRIVATE DEBUG_strace=1)
endif()

add_subdirectory(ssh)

add_subdirectory(backup)
