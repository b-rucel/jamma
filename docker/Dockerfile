# jamma builder: pinned Emscripten + pinned MAME source.
# Bump both together; MAME's emscripten target tracks recent emsdk releases.
ARG EMSDK_VERSION=6.0.12
FROM emscripten/emsdk:${EMSDK_VERSION}

ARG MAME_TAG=mame0289

RUN apt-get update \
 && apt-get install -y --no-install-recommends git make python3 \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${MAME_TAG} https://github.com/mamedev/mame.git /mame

# Pre-build the SDL3 ports MAME links against so every core build reuses them.
RUN embuilder build sdl3 sdl3_ttf

WORKDIR /mame
