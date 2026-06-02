.PHONY: install build clean typecheck lint lint-fix format format-check test test-watch \
        test-integration audit check demo-server demo-client demo-channel-server demo-channel-client help

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install dependencies (class-XDR @stellar/stellar-sdk builds from its git branch)
	@tmp=$$(mktemp -d); git -C "$$tmp" init -q; \
	  GIT_DIR="$$tmp/.git" GIT_WORK_TREE="$$tmp" pnpm install; \
	  rc=$$?; rm -rf "$$tmp"; exit $$rc
	node scripts/patch-classxdr-esm.mjs

build: ## Compile TypeScript → dist/
	pnpm run build

clean: ## Remove dist/ and node_modules/
	rm -rf dist node_modules

typecheck: ## Type-check without emitting (tsc --noEmit)
	pnpm run check:types

lint: ## Run ESLint
	pnpm run lint

lint-fix: ## Run ESLint with auto-fix
	pnpm run lint:fix

format: ## Format code with Prettier
	pnpm run format

format-check: ## Check formatting (CI-friendly)
	pnpm run format:check

test: ## Run tests once (vitest --run)
	pnpm test --run

test-watch: ## Run tests in watch mode
	pnpm test

test-integration: ## Run integration tests against Stellar Testnet (network access required)
	pnpm run test:integration

audit: ## Run security audit (high+ severity)
	pnpm audit --audit-level high

check: install format-check lint typecheck test build audit ## Run full quality pipeline (mirrors CI)

demo-server: ## Run charge server example
	pnpm run demo:server

demo-client: ## Run charge client example
	pnpm run demo:client

demo-channel-server: ## Run channel server example
	pnpm run demo:channel-server

demo-channel-client: ## Run channel client example
	pnpm run demo:channel-client

.DEFAULT_GOAL := help
