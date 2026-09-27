import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, zeroAddress } from "viem";

/**
 * Residual Hardhat unit tests for contract behaviors not covered by
 * test/core.ts + test/upgradeable.ts (operator auth, unsetAgentWallet,
 * isAuthorizedOrOwner, reputation decimals/bounds, validation getSummary
 * string-tag filtering, and additional UUPS security paths).
 */
describe("ERC8004 Residual Coverage", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  async function getAgentIdFromRegistration(txHash: `0x${string}`) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const registeredLog = receipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    if (!registeredLog || !registeredLog.topics[1]) {
      throw new Error("Registered event not found");
    }
    return BigInt(registeredLog.topics[1]);
  }

  async function deployProxy(implementationAddress: `0x${string}`, initCalldata: `0x${string}`) {
    return await viem.deployContract("ERC1967Proxy", [implementationAddress, initCalldata]);
  }

  function encodeInitialize(): `0x${string}` {
    return "0x8129fc1c";
  }

  function encodeInitializeWithAddress(identityRegistry: `0x${string}`): `0x${string}` {
    const params = encodeAbiParameters([{ type: "address" }], [identityRegistry]);
    return ("0xc4d66de8" + params.slice(2)) as `0x${string}`;
  }

  async function deployIdentityRegistryProxy() {
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeInitializeWithAddress(zeroAddress);
    const proxy = await deployProxy(minimalImpl.address, minimalInitCalldata);

    const realImpl = await viem.deployContract("IdentityRegistryUpgradeable");
    const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    await minimalProxy.write.upgradeToAndCall([realImpl.address, encodeInitialize()]);

    return await viem.getContractAt("IdentityRegistryUpgradeable", proxy.address);
  }

  async function deployReputationRegistryProxy(identityRegistryAddress: `0x${string}`) {
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeInitializeWithAddress(identityRegistryAddress);
    const proxy = await deployProxy(minimalImpl.address, minimalInitCalldata);

    const realImpl = await viem.deployContract("ReputationRegistryUpgradeable");
    const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    await minimalProxy.write.upgradeToAndCall([
      realImpl.address,
      encodeInitializeWithAddress(identityRegistryAddress),
    ]);

    return await viem.getContractAt("ReputationRegistryUpgradeable", proxy.address);
  }

  async function deployValidationRegistryProxy(identityRegistryAddress: `0x${string}`) {
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeInitializeWithAddress(identityRegistryAddress);
    const proxy = await deployProxy(minimalImpl.address, minimalInitCalldata);

    const realImpl = await viem.deployContract("ValidationRegistryUpgradeable");
    const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    await minimalProxy.write.upgradeToAndCall([
      realImpl.address,
      encodeInitializeWithAddress(identityRegistryAddress),
    ]);

    return await viem.getContractAt("ValidationRegistryUpgradeable", proxy.address);
  }

  async function signAgentWallet(args: {
    identityRegistryAddress: `0x${string}`;
    agentId: bigint;
    newWallet: `0x${string}`;
    owner: `0x${string}`;
    deadline: bigint;
    signer: Awaited<ReturnType<typeof viem.getWalletClients>>[number];
  }) {
    const chainId = await publicClient.getChainId();
    return await args.signer.signTypedData({
      account: args.signer.account,
      domain: {
        name: "ERC8004IdentityRegistry",
        version: "1",
        chainId,
        verifyingContract: args.identityRegistryAddress,
      },
      types: {
        AgentWalletSet: [
          { name: "agentId", type: "uint256" },
          { name: "newWallet", type: "address" },
          { name: "owner", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "AgentWalletSet",
      message: {
        agentId: args.agentId,
        newWallet: args.newWallet,
        owner: args.owner,
        deadline: args.deadline,
      },
    });
  }

  describe("IdentityRegistry residual", async function () {
    it("Should expose isAuthorizedOrOwner for owner, approved, and operator", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner, approved, operator, stranger] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://auth-check"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      assert.equal(await identityRegistry.read.isAuthorizedOrOwner([owner.account.address, agentId]), true);
      assert.equal(await identityRegistry.read.isAuthorizedOrOwner([stranger.account.address, agentId]), false);

      await identityRegistry.write.approve([approved.account.address, agentId]);
      assert.equal(await identityRegistry.read.isAuthorizedOrOwner([approved.account.address, agentId]), true);

      await identityRegistry.write.setApprovalForAll([operator.account.address, true]);
      assert.equal(await identityRegistry.read.isAuthorizedOrOwner([operator.account.address, agentId]), true);
    });

    it("Should revert isAuthorizedOrOwner for non-existent agent", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner] = await viem.getWalletClients();

      await assert.rejects(
        identityRegistry.read.isAuthorizedOrOwner([owner.account.address, 999n]),
        /ERC721NonexistentToken|revert/
      );
    });

    it("Should unset agentWallet and reject unauthorized unset", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner, walletSigner, attacker] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 240n;
      const signature = await signAgentWallet({
        identityRegistryAddress: identityRegistry.address,
        agentId,
        newWallet: walletSigner.account.address,
        owner: owner.account.address,
        deadline,
        signer: walletSigner,
      });

      await identityRegistry.write.setAgentWallet(
        [agentId, walletSigner.account.address, deadline, signature],
        { account: owner.account }
      );
      assert.equal(
        (await identityRegistry.read.getAgentWallet([agentId])).toLowerCase(),
        walletSigner.account.address.toLowerCase()
      );

      await assert.rejects(
        identityRegistry.write.unsetAgentWallet([agentId], { account: attacker.account }),
        /Not authorized/i
      );

      await identityRegistry.write.unsetAgentWallet([agentId], { account: owner.account });
      assert.equal(await identityRegistry.read.getAgentWallet([agentId]), zeroAddress);
      assert.equal(await identityRegistry.read.getMetadata([agentId, "agentWallet"]), "0x");
    });

    it("Should allow approved operator to setAgentURI and setMetadata", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner, operator] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://initial"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      await identityRegistry.write.setApprovalForAll([operator.account.address, true], {
        account: owner.account,
      });

      await identityRegistry.write.setAgentURI([agentId, "ipfs://operator-updated"], {
        account: operator.account,
      });
      assert.equal(await identityRegistry.read.tokenURI([agentId]), "ipfs://operator-updated");

      const metaValue = toHex("operator-set");
      await identityRegistry.write.setMetadata([agentId, "opsKey", metaValue], {
        account: operator.account,
      });
      assert.equal(await identityRegistry.read.getMetadata([agentId, "opsKey"]), metaValue);
    });

    it("Should allow token-approved address to setAgentWallet", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner, approved, walletSigner] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      await identityRegistry.write.approve([approved.account.address, agentId], {
        account: owner.account,
      });

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 240n;
      const signature = await signAgentWallet({
        identityRegistryAddress: identityRegistry.address,
        agentId,
        newWallet: walletSigner.account.address,
        owner: owner.account.address,
        deadline,
        signer: walletSigner,
      });

      await identityRegistry.write.setAgentWallet(
        [agentId, walletSigner.account.address, deadline, signature],
        { account: approved.account }
      );

      assert.equal(
        (await identityRegistry.read.getAgentWallet([agentId])).toLowerCase(),
        walletSigner.account.address.toLowerCase()
      );
    });

    it("Should reject setAgentWallet with zero address", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 240n;

      await assert.rejects(
        identityRegistry.write.setAgentWallet([agentId, zeroAddress, deadline, "0x"], {
          account: owner.account,
        }),
        /bad wallet/i
      );
    });

    it("Should reject setAgentURI from unauthorized caller", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [, attacker] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      await assert.rejects(
        identityRegistry.write.setAgentURI([agentId, "ipfs://hijack"], { account: attacker.account }),
        /Not authorized/i
      );
    });

    it("Should emit URIUpdated when setAgentURI succeeds", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const [owner] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      await viem.assertions.emitWithArgs(
        identityRegistry.write.setAgentURI([agentId, "https://example.com/agent.json"]),
        identityRegistry,
        "URIUpdated",
        [agentId, "https://example.com/agent.json", getAddress(owner.account.address)]
      );
    });
  });

  describe("ReputationRegistry residual", async function () {
    it("Should reject valueDecimals > 18", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await assert.rejects(
        reputationRegistry.write.giveFeedback(
          [agentId, 100, 19, "", "", "", "", keccak256(toHex("x"))],
          { account: client.account }
        ),
        /too many decimals/i
      );
    });

    it("Should reject value outside abs bound", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      // MAX_ABS_VALUE = 1e38
      const tooLarge = 10n ** 38n + 1n;
      await assert.rejects(
        reputationRegistry.write.giveFeedback(
          [agentId, tooLarge, 0, "", "", "", "", keccak256(toHex("x"))],
          { account: client.account }
        ),
        /value too large/i
      );
    });

    it("Should accept negative feedback values and average them", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, -50, 0, "risk", "", "", "", keccak256(toHex("n1"))],
        { account: client.account }
      );
      await reputationRegistry.write.giveFeedback(
        [agentId, 50, 0, "risk", "", "", "", keccak256(toHex("n2"))],
        { account: client.account }
      );

      const feedback = await reputationRegistry.read.readFeedback([
        agentId,
        client.account.address,
        1n,
      ]);
      assert.equal(feedback[0], -50n);

      const summary = await reputationRegistry.read.getSummary([
        agentId,
        [client.account.address],
        "risk",
        "",
      ]);
      assert.equal(summary[0], 2n);
      assert.equal(summary[1], 0n); // (-50 + 50) / 2
    });

    it("Should average across mixed valueDecimals using mode precision", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      // Two entries at 2 decimals (mode=2), one at 1 decimal:
      // values: 1.00, 2.00, 3.0 → avg WAD 2.0 → 200 at 2 decimals
      await reputationRegistry.write.giveFeedback(
        [agentId, 100, 2, "dec", "", "", "", keccak256(toHex("d1"))],
        { account: client.account }
      );
      await reputationRegistry.write.giveFeedback(
        [agentId, 200, 2, "dec", "", "", "", keccak256(toHex("d2"))],
        { account: client.account }
      );
      await reputationRegistry.write.giveFeedback(
        [agentId, 30, 1, "dec", "", "", "", keccak256(toHex("d3"))],
        { account: client.account }
      );

      const summary = await reputationRegistry.read.getSummary([
        agentId,
        [client.account.address],
        "dec",
        "",
      ]);
      assert.equal(summary[0], 3n);
      assert.equal(summary[2], 2); // mode decimals (2 appears twice)
      assert.equal(summary[1], 200n); // 2.00 at mode precision
    });

    it("Should exclude revoked feedback from getSummary", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, 80, 0, "svc", "", "", "", keccak256(toHex("a"))],
        { account: client.account }
      );
      await reputationRegistry.write.giveFeedback(
        [agentId, 100, 0, "svc", "", "", "", keccak256(toHex("b"))],
        { account: client.account }
      );
      await reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client.account });

      const summary = await reputationRegistry.read.getSummary([
        agentId,
        [client.account.address],
        "svc",
        "",
      ]);
      assert.equal(summary[0], 1n);
      assert.equal(summary[1], 100n);
    });

    it("Should reject double revoke and index 0 revoke", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, 70, 0, "", "", "", "", keccak256(toHex("c"))],
        { account: client.account }
      );

      await assert.rejects(
        reputationRegistry.write.revokeFeedback([agentId, 0n], { account: client.account }),
        /index must be > 0/i
      );

      await reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client.account });
      await assert.rejects(
        reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client.account }),
        /Already revoked/i
      );
    });

    it("Should reject appendResponse with empty URI or index 0", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client, responder] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, 70, 0, "", "", "", "", keccak256(toHex("c"))],
        { account: client.account }
      );

      await assert.rejects(
        reputationRegistry.write.appendResponse(
          [agentId, client.account.address, 0n, "ipfs://r", keccak256(toHex("r"))],
          { account: responder.account }
        ),
        /index must be > 0/i
      );

      await assert.rejects(
        reputationRegistry.write.appendResponse(
          [agentId, client.account.address, 1n, "", keccak256(toHex("r"))],
          { account: responder.account }
        ),
        /Empty URI/i
      );
    });

    it("Should reject getSummary without clientAddresses", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await assert.rejects(
        reputationRegistry.read.getSummary([agentId, [], "", ""]),
        /clientAddresses required/i
      );
    });

    it("Should include revoked feedback when includeRevoked is true", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, 80, 0, "t", "", "", "", keccak256(toHex("a"))],
        { account: client.account }
      );
      await reputationRegistry.write.revokeFeedback([agentId, 1n], { account: client.account });

      const withoutRevoked = await reputationRegistry.read.readAllFeedback([
        agentId,
        [client.account.address],
        "",
        "",
        false,
      ]);
      assert.equal(withoutRevoked[2].length, 0);

      const withRevoked = await reputationRegistry.read.readAllFeedback([
        agentId,
        [client.account.address],
        "",
        "",
        true,
      ]);
      assert.equal(withRevoked[2].length, 1);
      assert.equal(withRevoked[6][0], true);
    });

    it("Should default readAllFeedback clients to getClients when empty", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, client1, client2] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await reputationRegistry.write.giveFeedback(
        [agentId, 80, 0, "", "", "", "", keccak256(toHex("a"))],
        { account: client1.account }
      );
      await reputationRegistry.write.giveFeedback(
        [agentId, 90, 0, "", "", "", "", keccak256(toHex("b"))],
        { account: client2.account }
      );

      const result = await reputationRegistry.read.readAllFeedback([agentId, [], "", "", false]);
      assert.equal(result[2].length, 2);
      assert.equal(result[2][0], 80n);
      assert.equal(result[2][1], 90n);
    });

    it("Should reject self-feedback from approved operator", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const [agentOwner, operator] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: agentOwner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await identityRegistry.write.setApprovalForAll([operator.account.address, true], {
        account: agentOwner.account,
      });

      await assert.rejects(
        reputationRegistry.write.giveFeedback(
          [agentId, 99, 0, "", "", "", "", keccak256(toHex("self"))],
          { account: operator.account }
        ),
        /Self-feedback not allowed/i
      );
    });
  });

  describe("ValidationRegistry residual", async function () {
    it("Should reject zero validator address", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      await assert.rejects(
        validationRegistry.write.validationRequest([
          zeroAddress,
          agentId,
          "ipfs://req",
          keccak256(toHex("bad-validator")),
        ]),
        /bad validator/i
      );
    });

    it("Should reject unknown requestHash for response and status", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);
      const [, validator] = await viem.getWalletClients();

      const unknown = keccak256(toHex("never-requested"));

      await assert.rejects(
        validationRegistry.write.validationResponse(
          [unknown, 50, "ipfs://r", keccak256(toHex("r")), "tag"],
          { account: validator.account }
        ),
        /unknown/i
      );

      await assert.rejects(validationRegistry.read.getValidationStatus([unknown]), /unknown/i);
    });

    it("Should allow approved operator to create validation request", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);
      const [owner, operator, validator] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"], {
        account: owner.account,
      });
      const agentId = await getAgentIdFromRegistration(txHash);

      await identityRegistry.write.setApprovalForAll([operator.account.address, true], {
        account: owner.account,
      });

      const requestHash = keccak256(toHex("operator-req"));
      await validationRegistry.write.validationRequest(
        [validator.account.address, agentId, "ipfs://req", requestHash],
        { account: operator.account }
      );

      const status = await validationRegistry.read.getValidationStatus([requestHash]);
      assert.equal(status[0].toLowerCase(), validator.account.address.toLowerCase());
      assert.equal(status[1], agentId);
    });

    it("Should compute getSummary with empty-tag wildcard and tag/validator filters", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);
      const [owner, validator1, validator2] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);

      const req1 = keccak256(toHex("summary-1"));
      const req2 = keccak256(toHex("summary-2"));
      const req3 = keccak256(toHex("summary-3-pending"));

      await validationRegistry.write.validationRequest([
        validator1.account.address,
        agentId,
        "ipfs://1",
        req1,
      ]);
      await validationRegistry.write.validationRequest([
        validator2.account.address,
        agentId,
        "ipfs://2",
        req2,
      ]);
      await validationRegistry.write.validationRequest([
        validator1.account.address,
        agentId,
        "ipfs://3",
        req3,
      ]);

      await validationRegistry.write.validationResponse(
        [req1, 80, "ipfs://r1", keccak256(toHex("r1")), "quality"],
        { account: validator1.account }
      );
      await validationRegistry.write.validationResponse(
        [req2, 100, "ipfs://r2", keccak256(toHex("r2")), "quality"],
        { account: validator2.account }
      );
      // req3 left without response — must be excluded

      const all = await validationRegistry.read.getSummary([agentId, [], ""]);
      assert.equal(all[0], 2n);
      assert.equal(all[1], 90); // (80 + 100) / 2

      const byTag = await validationRegistry.read.getSummary([agentId, [], "quality"]);
      assert.equal(byTag[0], 2n);
      assert.equal(byTag[1], 90);

      const byOtherTag = await validationRegistry.read.getSummary([agentId, [], "other"]);
      assert.equal(byOtherTag[0], 0n);
      assert.equal(byOtherTag[1], 0);

      const byValidator = await validationRegistry.read.getSummary([
        agentId,
        [validator1.account.address],
        "",
      ]);
      assert.equal(byValidator[0], 1n);
      assert.equal(byValidator[1], 80);
    });

    it("Should return lastUpdate from getValidationStatus", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);
      const [, validator] = await viem.getWalletClients();

      const txHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(txHash);
      const requestHash = keccak256(toHex("last-update"));

      await validationRegistry.write.validationRequest([
        validator.account.address,
        agentId,
        "ipfs://req",
        requestHash,
      ]);

      const before = await validationRegistry.read.getValidationStatus([requestHash]);
      assert.ok(before[5] > 0n);

      await validationRegistry.write.validationResponse(
        [requestHash, 42, "ipfs://resp", keccak256(toHex("resp")), "ok"],
        { account: validator.account }
      );

      const after = await validationRegistry.read.getValidationStatus([requestHash]);
      assert.ok(after[5] >= before[5]);
      assert.equal(after[2], 42);
      assert.equal(after[4], "ok");
    });
  });

  describe("UUPS residual", async function () {
    it("Should prevent double initialize on Reputation and Validation proxies", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);

      await assert.rejects(
        reputationRegistry.write.initialize([identityRegistry.address]),
        /InvalidInitialization|revert/
      );
      await assert.rejects(
        validationRegistry.write.initialize([identityRegistry.address]),
        /InvalidInitialization|revert/
      );
    });

    it("Should prevent direct initialization of Reputation and Validation implementations", async function () {
      const [owner] = await viem.getWalletClients();
      const identityRegistry = await deployIdentityRegistryProxy();

      const reputationImpl = await viem.deployContract("ReputationRegistryUpgradeable");
      const validationImpl = await viem.deployContract("ValidationRegistryUpgradeable");

      // Implementations are Ownable with unset owner after _disableInitializers;
      // initialize is onlyOwner + reinitializer(2), so direct init must fail.
      await assert.rejects(
        reputationImpl.write.initialize([identityRegistry.address], { account: owner.account }),
        /InvalidInitialization|OwnableUnauthorizedAccount|revert/
      );
      await assert.rejects(
        validationImpl.write.initialize([identityRegistry.address], { account: owner.account }),
        /InvalidInitialization|OwnableUnauthorizedAccount|revert/
      );
    });

    it("Should reject Validation initialize with zero identityRegistry", async function () {
      const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
      const proxy = await deployProxy(
        minimalImpl.address,
        encodeInitializeWithAddress(zeroAddress)
      );
      const validationImpl = await viem.deployContract("ValidationRegistryUpgradeable");
      const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);

      await assert.rejects(
        minimalProxy.write.upgradeToAndCall([
          validationImpl.address,
          encodeInitializeWithAddress(zeroAddress),
        ]),
        /bad identity/i
      );
    });

    it("Should only allow owner to upgrade Reputation and Validation", async function () {
      const [, attacker] = await viem.getWalletClients();
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);

      const reputationImplV2 = await viem.deployContract("ReputationRegistryUpgradeable");
      const validationImplV2 = await viem.deployContract("ValidationRegistryUpgradeable");

      await assert.rejects(
        reputationRegistry.write.upgradeToAndCall([reputationImplV2.address, "0x"], {
          account: attacker.account,
        }),
        /OwnableUnauthorizedAccount|revert/
      );
      await assert.rejects(
        validationRegistry.write.upgradeToAndCall([validationImplV2.address, "0x"], {
          account: attacker.account,
        }),
        /OwnableUnauthorizedAccount|revert/
      );
    });

    it("Should emit Upgraded for Reputation and Validation upgrades", async function () {
      const identityRegistry = await deployIdentityRegistryProxy();
      const reputationRegistry = await deployReputationRegistryProxy(identityRegistry.address);
      const validationRegistry = await deployValidationRegistryProxy(identityRegistry.address);

      const reputationImplV2 = await viem.deployContract("ReputationRegistryUpgradeable");
      const validationImplV2 = await viem.deployContract("ValidationRegistryUpgradeable");

      const upgradedEventSig = keccak256(toHex("Upgraded(address)"));

      const repTx = await reputationRegistry.write.upgradeToAndCall([
        reputationImplV2.address,
        "0x",
      ]);
      const repReceipt = await publicClient.getTransactionReceipt({ hash: repTx });
      const repEvent = repReceipt.logs.find((log) => log.topics[0] === upgradedEventSig);
      assert.ok(repEvent);
      assert.equal(
        `0x${repEvent!.topics[1]!.slice(26)}`.toLowerCase(),
        reputationImplV2.address.toLowerCase()
      );

      const valTx = await validationRegistry.write.upgradeToAndCall([
        validationImplV2.address,
        "0x",
      ]);
      const valReceipt = await publicClient.getTransactionReceipt({ hash: valTx });
      const valEvent = valReceipt.logs.find((log) => log.topics[0] === upgradedEventSig);
      assert.ok(valEvent);
      assert.equal(
        `0x${valEvent!.topics[1]!.slice(26)}`.toLowerCase(),
        validationImplV2.address.toLowerCase()
      );
    });
  });
});
