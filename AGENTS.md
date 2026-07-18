# AGENTS.md — erc-8004-contracts

## What this is
Solidity smart contracts implementing ERC-8004 — a learning vehicle and long-horizon R&D project exploring critical infrastructure for quantum digital twins in maritime nuclear power regulation. Not production-deployed; experimental/research status.

## Long-horizon purpose
ERC-8004 is the foundational layer for quantum-resistant identity and attestation in high-consequence regulated environments. The maritime nuclear power angle is the motivating use case; the standard itself is more general.

## Live state (2026-07-18)
- Active development on `main`
- Issues tab: recently enabled (2026-07-18) — Warder can now file issues
- No production deployment; Hardhat local testnet only

## Agent rules
- **Scope:** This is research/learning infrastructure. No production funds or live networks.
- **Issues:** Warder-filed issues should focus on contract correctness, test coverage, and spec compliance.
- **No deploying to mainnet** without explicit written authorization from Andrew.
- **Dependencies:** Keep Hardhat, OpenZeppelin, and ethers.js pinned; audit before upgrading.

## Key files
- `contracts/` — Solidity source
- `test/` — Hardhat test suite
- `scripts/` — deployment and utility scripts
- `hardhat.config.ts` — network and compiler config

## How to run
```bash
npm install
npx hardhat test
npx hardhat node      # local testnet
```
