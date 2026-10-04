#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v emcc >/dev/null; then
    echo 'Activate Emscripten 3.1.74 with emsdk_env.sh first.' >&2
    exit 1
fi
if [[ "$(emcc -dumpversion)" != '3.1.74' ]]; then
    echo 'This proof was reviewed with Emscripten 3.1.74.' >&2
    exit 1
fi
toolchain="$(em-config EMSCRIPTEN_ROOT)/cmake/Modules/Platform/Emscripten.cmake"
git submodule update --init --depth 1
emmake make -f makefile.zlib CC=emcc AR=emar RANLIB=emranlib FPIC_FLAG= CFLAGS_EXTRA=-flto
make static CC=emcc AR=emar FPIC_FLAG= WERROR=-Wall CFLAGS_EXTRA=-flto \
    MULTITHREAD="-j${REBIT_BUILD_JOBS:-4}" CMAKEFLAGS_EXTRA="-DCMAKE_TOOLCHAIN_FILE=$toolchain"
cp build/hatarib.a build/hatarib_libretro_emscripten.a
emcc -O3 -flto rebit/wasm/proof.c build/hatarib.a --no-entry -o build/hatarib-proof.mjs \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHatariB -sENVIRONMENT=web,worker,node \
    -sSTACK_SIZE=4194304 -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=1 \
    -sASSERTIONS=1 -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_FUNCTIONS='["_malloc","_free"]' -sEXPORTED_RUNTIME_METHODS='["FS","ccall","cwrap"]'
