cmake_minimum_required(VERSION 3.16)
project(unicorn_java C)

find_package(JNI REQUIRED)

add_library(unicorn_java SHARED
    "${UNICORN_SOURCE_DIR}/bindings/java/unicorn_Unicorn.c"
)
target_include_directories(unicorn_java PRIVATE
    "${UNICORN_SOURCE_DIR}/include"
    ${JNI_INCLUDE_DIRS}
)
set_target_properties(unicorn_java PROPERTIES C_STANDARD 99)
target_compile_options(unicorn_java PRIVATE -O3 -DNDEBUG)

# ARM archives refer back to QEMU helpers in libunicorn.a. A single left-to-right
# scan (the upstream JNI build) drops those objects and leaves 27 unresolved
# symbols in the Linux .so. Rescan the complete archive group and reject any
# unresolved reference at link time.
target_link_options(unicorn_java PRIVATE -Wl,--no-undefined)
target_link_libraries(unicorn_java PRIVATE
    -Wl,--start-group
    "${UNICORN_BUILD_DIR}/libunicorn.a"
    "${UNICORN_BUILD_DIR}/libarm-softmmu.a"
    "${UNICORN_BUILD_DIR}/libarmeb-softmmu.a"
    "${UNICORN_BUILD_DIR}/libaarch64-softmmu.a"
    "${UNICORN_BUILD_DIR}/libaarch64eb-softmmu.a"
    -Wl,--end-group
    m pthread rt
)
