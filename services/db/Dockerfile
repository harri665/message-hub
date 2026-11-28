# The stack's Postgres, with the pgvector extension for search by meaning (apps/hub/migrations/010_ai.sql).
# Built on the same postgres:17-alpine image as before, so the existing data directory (and its musl collation) is
# used as it is. Switching to the Debian-based pgvector image would change the collation under existing text indexes.
FROM postgres:17-alpine

ARG PGVECTOR_VERSION=0.8.7

# with_llvm=no: skip JIT bitcode, which would need the exact clang/llvm the image was built with.
# OPTFLAGS="": no -march=native, so the image runs on any x86-64 or arm64 host, not just the one that built it.
RUN apk add --no-cache --virtual .build-deps build-base git \
 && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" install \
 && rm -rf /tmp/pgvector \
 && apk del .build-deps
