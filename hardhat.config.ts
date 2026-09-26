import "@nomicfoundation/hardhat-ethers";

import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY || "",
    }
  },
  chainDescriptors: {
    1: {
      name: "Ethereum Mainnet",
      blockExplorers: {
        etherscan: {
          url: "https://etherscan.io",
          apiUrl: "https://api.etherscan.io/v2/api",
        }
      }
    },
    11155111: {
      name: "Sepolia",
      blockExplorers: {
        etherscan: {
          url: "https://sepolia.etherscan.io",
          apiUrl: "https://api.etherscan.io/v2/api",
        }
      }
    },
    84532: {
      name: "Base Sepolia",
      blockExplorers: {
        etherscan: {
          url: "https://sepolia.basescan.org",
          apiUrl: "https://api.etherscan.io/v2/api",
        }
      }
    }
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          evmVersion: "shanghai",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,

        },
      },
      production: {
        version: "0.8.24",
        settings: {
          evmVersion: "shanghai",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Only register HTTP networks when a real RPC URL is set. Empty-string
    // fallbacks make Hardhat 3 reject the config (HHE15), which breaks the
    // README / AGENTS.md quickstart (`npm test` / `npx hardhat test`) with no .env.
    ...(process.env.SEPOLIA_RPC_URL
      ? {
          sepolia: {
            type: "http" as const,
            chainType: "l1" as const,
            url: process.env.SEPOLIA_RPC_URL,
            accounts: process.env.SEPOLIA_PRIVATE_KEY
              ? [process.env.SEPOLIA_PRIVATE_KEY]
              : [],
          },
        }
      : {}),
    ...(process.env.MAINNET_RPC_URL
      ? {
          mainnet: {
            type: "http" as const,
            chainType: "l1" as const,
            url: process.env.MAINNET_RPC_URL,
            accounts: process.env.MAINNET_PRIVATE_KEY
              ? [process.env.MAINNET_PRIVATE_KEY]
              : [],
          },
        }
      : {}),
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.BASE_SEPOLIA_PRIVATE_KEY
        ? [process.env.BASE_SEPOLIA_PRIVATE_KEY]
        : [],
    },
  },
};

export default config;
