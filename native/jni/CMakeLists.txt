# libhonkcard.so for the Android app: quickjs-ng, the card sandbox and its
# JNI (android/app's externalNativeBuild points here).
cmake_minimum_required(VERSION 3.22.1)
project(honkcard C)

set(NATIVE ${CMAKE_CURRENT_SOURCE_DIR}/..)
add_library(honkcard SHARED
    ${NATIVE}/quickjs/quickjs.c
    ${NATIVE}/quickjs/libregexp.c
    ${NATIVE}/quickjs/libunicode.c
    ${NATIVE}/quickjs/dtoa.c
    ${NATIVE}/card/honk_card.c
    ${NATIVE}/jni/honk_card_jni.c)
target_include_directories(honkcard PRIVATE ${NATIVE}/quickjs ${NATIVE}/card ${NATIVE}/card/include)
target_compile_definitions(honkcard PRIVATE NDEBUG _GNU_SOURCE)
set_source_files_properties(
    ${NATIVE}/quickjs/quickjs.c ${NATIVE}/quickjs/libregexp.c ${NATIVE}/quickjs/libunicode.c ${NATIVE}/quickjs/dtoa.c
    PROPERTIES COMPILE_OPTIONS "-w")
target_compile_options(honkcard PRIVATE -O2 -fvisibility=hidden)
# Android 15 devices may use 16 KB pages.
target_link_options(honkcard PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(honkcard m)
