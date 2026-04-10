FROM docker.io/cloudflare/sandbox:0.8.7

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

# Pre-fetch soroban-sdk crate to speed up first compile
RUN mkdir -p /tmp/prefetch/src && \
    printf '[package]\nname = "prefetch"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nsoroban-sdk = "25"\n\n[dev-dependencies]\nsoroban-sdk = { version = "22", features = ["testutils"] }\n' > /tmp/prefetch/Cargo.toml && \
    printf '#![no_std]\nuse soroban_sdk::contract;\n#[contract]\npub struct PrefetchContract;\n' > /tmp/prefetch/src/lib.rs && \
    cd /tmp/prefetch && cargo fetch && \
    rm -rf /tmp/prefetch

# Create workspace directory for policy compilation
RUN mkdir -p /workspace/policy-contract/src

# Required for local development
EXPOSE 8080
