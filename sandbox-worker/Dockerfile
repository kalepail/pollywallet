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

# Pre-fetch soroban-sdk crates to speed up the first compile.
# These versions MUST match CARGO_TOML_TEMPLATE in src/lib/policy-sandbox.ts.
# The dev-dependency previously pinned 22 while the template asked for 25.3, so the
# prefetched testutils crates never matched and every `cargo test` paid a cold
# download — exactly the cost the `depsFetched` cache in src/index.ts exists to avoid.
RUN mkdir -p /tmp/prefetch/src && \
    printf '[package]\nname = "prefetch"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nsoroban-sdk = "27.0.5"\n\n[dev-dependencies]\nsoroban-sdk = { version = "27.0.5", features = ["testutils"] }\n' > /tmp/prefetch/Cargo.toml && \
    printf '#![no_std]\nuse soroban_sdk::contract;\n#[contract]\npub struct PrefetchContract;\n' > /tmp/prefetch/src/lib.rs && \
    cd /tmp/prefetch && cargo fetch && \
    rm -rf /tmp/prefetch

# Create workspace directory for policy compilation
RUN mkdir -p /workspace/policy-contract/src

# Required for local development
EXPOSE 8080
