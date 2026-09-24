.PHONY: help install dev-api dev-web e2e e2e-scaffold e2e-gate e2e-failure e2e-m3 e2e-m3-gate e2e-m35-gate check check-rust check-web

help:
	@echo 'make install    Install locked Rust and web dependencies'
	@echo 'make dev-api    Run the API on 127.0.0.1:8080'
	@echo 'make dev-web    Run the web app on 127.0.0.1:5173'
	@echo 'make e2e        Run the current M3 journey and retain evidence'
	@echo 'make e2e-scaffold  Run only the API/web shell scenarios'
	@echo 'make e2e-gate   Run the current M3 gate from a clean source tree'
	@echo 'make e2e-failure  Prove a corrupted oracle fails and retains evidence'
	@echo 'make e2e-m3     Run the full owned M3 journey with real VM/runtime prerequisites'
	@echo 'make e2e-m3-gate  Run the M3 journey and require a clean source tree'
	@echo 'make e2e-m35-gate  Verify the staged restricted preview using private E2E_ARGS'
	@echo 'make check      Format, lint, test and build the workspace'

install:
	cargo fetch --locked
	npm ci --prefix web

dev-api:
	cargo run --locked -p hostlet-control

dev-web:
	npm run dev --prefix web

e2e: e2e-m3

e2e-scaffold:
	node e2e/run.mjs $(E2E_ARGS)

e2e-gate: e2e-m3-gate

e2e-failure:
	node e2e/run.mjs --inject-failure $(E2E_ARGS)

e2e-m3:
	node e2e/run.mjs --milestone M3 --task HOST-233 --scenario-module e2e/scenarios/m3-journey.mjs --operation-timeout 3600000 --run-timeout 7200000 $(E2E_ARGS)

e2e-m3-gate:
	node e2e/run.mjs --require-clean --milestone M3 --task HOST-233 --scenario-module e2e/scenarios/m3-journey.mjs --operation-timeout 3600000 --run-timeout 7200000 $(E2E_ARGS)

e2e-m35-gate:
	node e2e/beta/run.mjs --require-clean $(E2E_ARGS)

check: check-rust check-web

check-rust:
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings
	cargo test --locked --workspace

check-web:
	npm run check --prefix web
	npm run build --prefix web
