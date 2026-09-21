.PHONY: help install dev-api dev-web e2e e2e-scaffold e2e-gate e2e-failure check check-rust check-web

help:
	@echo 'make install    Install locked Rust and web dependencies'
	@echo 'make dev-api    Run the API on 127.0.0.1:8080'
	@echo 'make dev-web    Run the web app on 127.0.0.1:5173'
	@echo 'make e2e        Run real-process foundation E2E and retain evidence'
	@echo 'make e2e-scaffold  Run only the API/web shell scenarios'
	@echo 'make e2e-gate   Run E2E and require a clean source tree'
	@echo 'make e2e-failure  Prove a corrupted oracle fails and retains evidence'
	@echo 'make check      Format, lint, test and build the workspace'

install:
	cargo fetch --locked
	npm ci --prefix web

dev-api:
	cargo run --locked -p hostlet-control

dev-web:
	npm run dev --prefix web

e2e:
	node e2e/run.mjs --scenario-module e2e/scenarios/foundation.mjs --run-timeout 900000 $(E2E_ARGS)

e2e-scaffold:
	node e2e/run.mjs $(E2E_ARGS)

e2e-gate:
	node e2e/run.mjs --require-clean --scenario-module e2e/scenarios/foundation.mjs --run-timeout 900000 $(E2E_ARGS)

e2e-failure:
	node e2e/run.mjs --inject-failure $(E2E_ARGS)

check: check-rust check-web

check-rust:
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings
	cargo test --locked --workspace

check-web:
	npm run check --prefix web
	npm run build --prefix web
