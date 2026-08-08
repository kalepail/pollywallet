FROM docker.io/cloudflare/sandbox:0.12.4

# Install build tools and runtime deps for stellar-cli and Rust compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Add wasm targets for Soroban contracts
RUN rustup target add wasm32-unknown-unknown && rustup target add wasm32v1-none || true

# Install stellar-cli via prebuilt binary
RUN curl -fsSL https://github.com/stellar/stellar-cli/raw/main/install.sh | sh || true
RUN stellar --version

# Warm the build cache at IMAGE BUILD time, not at request time.
#
# This block used to run only `cargo fetch`, which downloads crate SOURCES and produces no
# compiled artifacts — so the first real request still paid the full rustc cost for ~180
# crates. Measured locally: a cold `stellar contract build` is ~15s and a cold `cargo test`
# ~20s AFTER sources are present; on a genuinely cold container the download alone is the
# 60-120s the old comment describes. Compiling the dependency graph into the shared
# CARGO_TARGET_DIR here moves all of that into the image.
#
# Two graphs are needed and they share NOTHING:
#   * `cargo test` builds the HOST target, `test` profile, with the `testutils` feature.
#   * `stellar contract build` builds `wasm32v1-none`, release profile.
# Cargo keys artifacts by (package, features, profile, target, rustc), so warming one does
# not warm the other. Dependency artifacts ARE reused across projects regardless of the
# consuming crate's path, which is why per-request UUID project dirs still hit this cache.
#
# The versions and profile below MUST match CARGO_TOML_TEMPLATE in src/lib/policy-sandbox.ts.
# A mismatch silently invalidates every artifact here and returns you to cold builds.
ENV CARGO_TARGET_DIR=/workspace/cargo-target
RUN mkdir -p /opt/policy-prebuild/src && \
    printf '[package]\nname = "policy-contract"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nsoroban-sdk = "27.0.5"\n\n[dev-dependencies]\nsoroban-sdk = { version = "27.0.5", features = ["testutils"] }\n\n[profile.release]\nopt-level = "z"\noverflow-checks = true\ndebug = 0\nstrip = "symbols"\ndebug-assertions = false\npanic = "abort"\ncodegen-units = 1\nlto = true\n' > /opt/policy-prebuild/Cargo.toml && \
    printf '#![no_std]\nuse soroban_sdk::contract;\n#[contract]\npub struct PrefetchContract;\n' > /opt/policy-prebuild/src/lib.rs && \
    cd /opt/policy-prebuild && \
    cargo fetch && \
    cargo test --no-run --locked && \
    stellar contract build --out-dir /tmp/prebuild-out && \
    rm -rf /tmp/prebuild-out && \
    # Keep Cargo.lock so requests can build --locked --offline against the exact versions
    # these artifacts were compiled from; drop only this dummy crate's own outputs.
    rm -rf /workspace/cargo-target/debug/deps/policy_contract* \
           /workspace/cargo-target/debug/.fingerprint/policy-contract-* \
           /workspace/cargo-target/wasm32v1-none/release/deps/policy_contract* \
           /workspace/cargo-target/wasm32v1-none/release/.fingerprint/policy-contract-* \
           /opt/policy-prebuild/src

# Create workspace directory for policy compilation
RUN mkdir -p /workspace/policy-contract/src

# Required for local development
EXPOSE 8080
