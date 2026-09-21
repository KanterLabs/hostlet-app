.PHONY: help install dev-api dev-web check check-rust check-web

help:
	@echo 'make install    Install locked Rust and web dependencies'
	@echo 'make dev-api    Run the API on 127.0.0.1:8080'
	@echo 'make dev-web    Run the web app on 127.0.0.1:5173'
	@echo 'make check      Format, lint, test and build the workspace'

install:
	cargo fetch --locked
	npm ci --prefix web

dev-api:
	cargo run --locked -p hostlet-control

dev-web:
	npm run dev --prefix web

check: check-rust check-web

check-rust:
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings
	cargo test --locked --workspace

check-web:
	npm run check --prefix web
	npm run build --prefix web
