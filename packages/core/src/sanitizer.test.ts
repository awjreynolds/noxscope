import { describe, expect, it } from "vitest";
import { createSanitizer, type AdapterSanitizationManifest } from "./sanitizer.js";

const manifest: AdapterSanitizationManifest = {
  adapter: { id: "test.adapter", version: "1.0.0", sourceVersions: ["fixture/1"] },
  policy: { id: "noxscope.redaction", version: "1.0.0", digest: "policy-fixture" },
  projections: [
    {
      source: "state.ready",
      target: "snapshot.ready",
      classification: "S3",
      transform: "copy",
    },
    {
      source: "diagnostic.message",
      target: "event.message",
      classification: "S3",
      transform: "copy",
    },
  ],
};

describe("Sanitizer", () => {
  it("projects only reviewed fields and reports denied native fields without echoing them", async () => {
    const sanitizer = createSanitizer();
    const result = await sanitizer.sanitize(
      {
        state: { ready: true, seed: "never-cross-the-seam" },
        diagnostic: { message: "sync started", rawTransaction: "signed-private-payload" },
        unreviewed: "drop me",
      },
      manifest,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        value: { snapshot: { ready: true }, event: { message: "sync started" } },
        audit: {
          policy: manifest.policy,
          manifest: { id: "test.adapter", version: "1.0.0" },
          decisions: { copied: 2, pseudonymised: 0, transformed: 0, removed: 3 },
          redactions: [
            { path: "diagnostic.rawtransaction", reason: "private-payload" },
            { path: "state.seed", reason: "secret" },
            { path: "unreviewed", reason: "policy" },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("never-cross-the-seam");
    expect(JSON.stringify(result)).not.toContain("signed-private-payload");
  });

  it("removes secret encodings and Unicode-disguised forbidden keys from allowlisted diagnostics", async () => {
    const sanitizer = createSanitizer();
    const detectorManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections: [
        "safe",
        "mnemonicLeak",
        "pemLeak",
        "jwtLeak",
        "bearerLeak",
        "assignmentLeak",
        "entropyLeak",
      ].map((source) => ({
        source: `diagnostic.${source}`,
        target: `event.${source}`,
        classification: "S3" as const,
        transform: "copy" as const,
      })),
    };
    const canaries = {
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      pem: "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3hzY29wZSJ9.c2lnbmF0dXJl",
      bearer: "Bearer n0xscope-secret-token-value",
      assignment: "api_key=n0xscope-secret-assignment",
      entropy: "a3".repeat(64),
    };

    const result = await sanitizer.sanitize(
      {
        diagnostic: {
          safe: "sync completed",
          mnemonicLeak: canaries.mnemonic,
          pemLeak: canaries.pem,
          jwtLeak: canaries.jwt,
          bearerLeak: canaries.bearer,
          assignmentLeak: canaries.assignment,
          entropyLeak: canaries.entropy,
        },
        sｅｅｄ: "unicode-key-canary",
      },
      detectorManifest,
    );

    expect(result.ok && result.value.value).toEqual({ event: { safe: "sync completed" } });
    const serialized = JSON.stringify(result);
    for (const canary of [...Object.values(canaries), "unicode-key-canary"]) {
      expect(serialized).not.toContain(canary);
    }
    expect(result.ok && result.value.audit.decisions).toEqual({
      copied: 1,
      pseudonymised: 0,
      transformed: 0,
      removed: 7,
    });
  });

  it("applies structured transforms and recording-scoped HMAC pseudonyms", async () => {
    const sanitizer = createSanitizer();
    const transformManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections: [
        {
          source: "wallet.address",
          target: "snapshot.address",
          classification: "S2",
          transform: "pseudonym",
        },
        {
          source: "configuration.nodeUrl",
          target: "dependency.endpoint",
          classification: "S2",
          transform: "url",
        },
        {
          source: "request.headers",
          target: "request.headers",
          classification: "S3",
          transform: "headers",
          allowedHeaders: ["content-type", "x-protocol-version"],
        },
        {
          source: "failure",
          target: "error",
          classification: "S3",
          transform: "error",
        },
        {
          source: "transactionBytes",
          target: "transaction.byteLength",
          classification: "S1",
          transform: "byte-length",
        },
      ],
    };
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);

    const result = await sanitizer.sanitize(
      {
        wallet: { address: "addr_test1abc" },
        configuration: {
          nodeUrl: "https://wallet:password@node.example:9944/private?token=secret#fragment",
        },
        request: {
          headers: {
            "Content-Type": "application/json",
            "X-Protocol-Version": "4.0.1",
            Authorization: "Bearer never-export",
          },
        },
        failure: {
          code: "NODE_UNAVAILABLE",
          message: "Node unavailable",
          retryable: true,
          stack: "private stack",
        },
        transactionBytes: "deadbeef",
      },
      transformManifest,
      { pseudonymKey: key },
    );

    expect(result.ok && result.value.value).toEqual({
      snapshot: {
        address: "hmac-sha256:05f73ff853a2cba2b6d34a5582ccfabc5937f1f19d944a91d35c2b75b79e5210",
      },
      dependency: { endpoint: "https://node.example:9944" },
      request: {
        headers: {
          "content-type": "application/json",
          "x-protocol-version": "4.0.1",
        },
      },
      error: { code: "NODE_UNAVAILABLE", message: "Node unavailable", retryable: true },
      transaction: { byteLength: 8 },
    });
    expect(JSON.stringify(result)).not.toContain("never-export");
    expect(JSON.stringify(result)).not.toContain("private stack");
    expect(JSON.stringify(result)).not.toContain("addr_test1abc");
  });

  it("rejects hostile shapes within hard limits without invoking getters or echoing values", async () => {
    const sanitizer = createSanitizer();
    let getterInvoked = false;
    const withGetter = {} as Record<string, unknown>;
    Object.defineProperty(withGetter, "state", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return { ready: true };
      },
    });
    const longCanary = `never-echo-${"x".repeat(16 * 1024)}`;

    const getterResult = await sanitizer.sanitize(withGetter, manifest);
    const longResult = await sanitizer.sanitize(
      { state: { ready: true }, diagnostic: { message: longCanary } },
      manifest,
    );

    expect(getterInvoked).toBe(false);
    expect(getterResult).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "Sanitization input or manifest is invalid",
        retryable: false,
      },
    });
    expect(longResult).toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Sanitization input exceeds a resource limit",
        retryable: false,
      },
    });
    expect(JSON.stringify(longResult)).not.toContain(longCanary);
  });

  it("emits only manifest-projected inert JSON raw detail", async () => {
    const sanitizer = createSanitizer();
    const rawManifest: AdapterSanitizationManifest = {
      ...manifest,
      raw: {
        namespace: "gsd.diagnostics",
        schemaVersion: "1",
        projections: [
          {
            source: "message",
            target: "message",
            classification: "S3",
            transform: "copy",
          },
          {
            source: "failure",
            target: "error",
            classification: "S3",
            transform: "error",
          },
        ],
      },
    };

    const result = await sanitizer.sanitizeRawDetail(
      {
        message: "indexer disconnected",
        failure: { code: "ECONNRESET", retryable: true, stack: "native stack" },
        rawTransaction: "never-cross",
      },
      rawManifest,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        namespace: "gsd.diagnostics",
        schemaVersion: "1",
        value: {
          message: "indexer disconnected",
          error: { code: "ECONNRESET", retryable: true },
        },
        sanitization: {
          policy: "noxscope.redaction",
          policyVersion: "1.0.0",
          redactions: [
            { path: "failure.stack", reason: "policy" },
            { path: "rawtransaction", reason: "private-payload" },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("never-cross");
    expect(JSON.stringify(result)).not.toContain("native stack");
  });

  it("keeps GSD, Moth, and connector fixture projections source-independent", async () => {
    const sanitizer = createSanitizer();
    const fixtures: readonly {
      name: string;
      input: Record<string, unknown>;
      projections: AdapterSanitizationManifest["projections"];
      expected: unknown;
      canaries: readonly string[];
    }[] = [
      {
        name: "GSD",
        input: {
          state: { ready: true, syncPhase: "replay" },
          failure: { code: "SUBMIT_FAILED", message: "Rejected", rawTransaction: "gsd-tx" },
          sdkCheckpoint: "gsd-checkpoint",
        },
        projections: [
          {
            source: "state.ready",
            target: "snapshot.ready",
            classification: "S3",
            transform: "copy",
          },
          {
            source: "state.syncPhase",
            target: "snapshot.syncPhase",
            classification: "S3",
            transform: "copy",
          },
          { source: "failure", target: "error", classification: "S3", transform: "error" },
        ],
        expected: {
          snapshot: { ready: true, syncPhase: "replay" },
          error: { code: "SUBMIT_FAILED", message: "Rejected" },
        },
        canaries: ["gsd-tx", "gsd-checkpoint"],
      },
      {
        name: "Moth",
        input: {
          ready: true,
          walletName: "moth-personal",
          networkId: "undeployed",
          syncProgress: { percentage: 75 },
          daemonToken: "moth-token",
        },
        projections: [
          { source: "ready", target: "snapshot.ready", classification: "S3", transform: "copy" },
          {
            source: "walletName",
            target: "snapshot.wallet",
            classification: "S2",
            transform: "pseudonym",
          },
          {
            source: "networkId",
            target: "snapshot.network",
            classification: "S3",
            transform: "copy",
          },
          {
            source: "syncProgress.percentage",
            target: "snapshot.percentage",
            classification: "S3",
            transform: "copy",
          },
        ],
        expected: {
          snapshot: {
            ready: true,
            wallet: "hmac-sha256:9ea2d9478dbbfcf34b71b4715408804c4b277e0ffe092c50a7afc27a2283eae9",
            network: "undeployed",
            percentage: 75,
          },
        },
        canaries: ["moth-personal", "moth-token"],
      },
      {
        name: "connector",
        input: {
          provider: { rdns: "wallet.example", apiVersion: "4.0.1" },
          configuration: { node: "wss://user:secret@node.example/socket?apiKey=secret" },
          headers: { "Content-Type": "application/json", Authorization: "Bearer connector-token" },
          signedTx: "connector-transaction",
        },
        projections: [
          {
            source: "provider.rdns",
            target: "provider.rdns",
            classification: "S4",
            transform: "copy",
          },
          {
            source: "provider.apiVersion",
            target: "provider.apiVersion",
            classification: "S4",
            transform: "copy",
          },
          {
            source: "configuration.node",
            target: "dependency.endpoint",
            classification: "S2",
            transform: "url",
          },
          {
            source: "headers",
            target: "headers",
            classification: "S3",
            transform: "headers",
            allowedHeaders: ["content-type"],
          },
        ],
        expected: {
          provider: { rdns: "wallet.example", apiVersion: "4.0.1" },
          dependency: { endpoint: "wss://node.example" },
          headers: { "content-type": "application/json" },
        },
        canaries: ["connector-token", "connector-transaction", "user:secret", "apiKey=secret"],
      },
    ];
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);

    for (const fixture of fixtures) {
      const result = await sanitizer.sanitize(
        fixture.input,
        { ...manifest, projections: fixture.projections },
        { pseudonymKey: key },
      );
      expect(result.ok && result.value.value, fixture.name).toEqual(fixture.expected);
      for (const canary of fixture.canaries) expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it("removes generated forbidden-key canaries under normalization variants", async () => {
    const sanitizer = createSanitizer();
    const forbidden = [
      "s-e-e-d",
      "PRIVATE_KEY",
      "viewing key",
      "ＡＰＩＫｅｙ",
      "raw-transaction",
      "key.material.provider",
      "recovery_phrase",
      "set-cookie",
    ];

    for (const [index, key] of forbidden.entries()) {
      const canary = `generated-canary-${index}`;
      const result = await sanitizer.sanitize(
        { state: { ready: true }, nested: { [key]: canary } },
        { ...manifest, projections: manifest.projections.slice(0, 1) },
      );
      expect(result.ok, key).toBe(true);
      expect(JSON.stringify(result), key).not.toContain(canary);
      expect(result.ok && result.value.audit.decisions.removed, key).toBe(1);
    }
  });

  it("enforces depth, cardinality, array, and sanitized-record ceilings", async () => {
    const sanitizer = createSanitizer();
    let deep: Record<string, unknown> = { value: true };
    for (let index = 0; index < 33; index += 1) deep = { nested: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`field${index}`, index]),
    );
    const largeArray = Array.from({ length: 4_097 }, (_, index) => index);
    const outputInput = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field${index}`,
        `safe diagnostic: ${"x ".repeat(6_990)}`,
      ]),
    );
    const outputManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections: Array.from({ length: 20 }, (_, index) => ({
        source: `field${index}`,
        target: `field${index}`,
        classification: "S3" as const,
        transform: "copy" as const,
      })),
    };

    for (const [input, selectedManifest] of [
      [deep, { ...manifest, projections: [] }],
      [wide, { ...manifest, projections: [] }],
      [{ values: largeArray }, { ...manifest, projections: [] }],
      [outputInput, outputManifest],
    ] as const) {
      expect(await sanitizer.sanitize(input, selectedManifest)).toEqual({
        ok: false,
        error: {
          code: "overflow",
          message: "Sanitization input exceeds a resource limit",
          retryable: false,
        },
      });
    }
  });

  it("rejects manifests that try to copy S0 or S1 material", async () => {
    const sanitizer = createSanitizer();
    for (const classification of ["S0", "S1"] as const) {
      const result = await sanitizer.sanitize(
        { payload: "authority-canary" },
        {
          ...manifest,
          projections: [
            {
              source: "payload",
              target: "payload",
              classification,
              transform: "copy",
            },
          ],
        },
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid",
          message: "Sanitization input or manifest is invalid",
          retryable: false,
        },
      });
      expect(JSON.stringify(result)).not.toContain("authority-canary");
    }
  });

  it("rejects an S3 projection that falsely classifies a seed source path", async () => {
    const sanitizer = createSanitizer();
    const result = await sanitizer.sanitize(
      { seed: "seed-authority-canary" },
      {
        ...manifest,
        projections: [
          {
            source: "seed",
            target: "event.message",
            classification: "S3",
            transform: "copy",
          },
        ],
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "Sanitization input or manifest is invalid",
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("seed-authority-canary");
  });

  it("rejects an S4 projection that falsely classifies a raw-transaction source path", async () => {
    const sanitizer = createSanitizer();
    const result = await sanitizer.sanitize(
      { rawTransaction: "private-transaction-canary" },
      {
        ...manifest,
        projections: [
          {
            source: "rawTransaction",
            target: "product.metadata",
            classification: "S4",
            transform: "copy",
          },
        ],
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "Sanitization input or manifest is invalid",
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-transaction-canary");
  });

  it("rejects malformed hostile manifests without invoking accessors or echoing their values", async () => {
    const sanitizer = createSanitizer();
    const expectedInvalid = {
      ok: false,
      error: {
        code: "invalid",
        message: "Sanitization input or manifest is invalid",
        retryable: false,
      },
    };
    let getterInvoked = false;
    const accessorManifest = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorManifest, "adapter", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "manifest-accessor-canary";
      },
    });
    const cyclicManifest: Record<string, unknown> = { ...manifest };
    cyclicManifest.self = cyclicManifest;
    const duplicateNormalizedManifest = {
      ...manifest,
      policy: {
        ...manifest.policy,
        ｄｉｇｅｓｔ: "duplicate-normalized-canary",
      },
    };

    for (const hostileManifest of [
      null,
      { adapter: "manifest-shape-canary" },
      accessorManifest,
      cyclicManifest,
      duplicateNormalizedManifest,
    ]) {
      const result = await sanitizer.sanitize(
        { state: { ready: true } },
        hostileManifest as AdapterSanitizationManifest,
      );
      expect(result).toEqual(expectedInvalid);
      expect(JSON.stringify(result)).not.toMatch(/canary/);
    }
    expect(getterInvoked).toBe(false);
  });

  it("limits complete raw detail to 64 KiB while retaining the 256 KiB record ceiling", async () => {
    const sanitizer = createSanitizer();
    const largeFields = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `field${index}`,
        `safe diagnostic ${index}: ${"x".repeat(13_980)}`,
      ]),
    );
    const projections = Array.from({ length: 5 }, (_, index) => ({
      source: `field${index}`,
      target: `field${index}`,
      classification: "S3" as const,
      transform: "copy" as const,
    }));
    const rawManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections,
      raw: {
        namespace: "mock.large-detail",
        schemaVersion: "1",
        projections: projections.map((projection) => ({ ...projection })),
      },
    };

    const ordinary = await sanitizer.sanitize(largeFields, rawManifest);
    const raw = await sanitizer.sanitizeRawDetail(largeFields, rawManifest);

    expect(ordinary.ok).toBe(true);
    expect(raw).toEqual({
      ok: false,
      error: {
        code: "overflow",
        message: "Sanitization input exceeds a resource limit",
        retryable: false,
      },
    });
  });

  it("removes Unicode secret phrases, credential URLs, normalized assignments, and key stores", async () => {
    const sanitizer = createSanitizer();
    const secrets = [
      "ábaco abdomen abeja abierto abogado abono aborto abrazo abrir abuelo abuso acabar",

      "あいこくしん あいさつ あいだ あおぞら あかちゃん あきる あけがた あける あこがれる あさい あさひ あしあと あじわう あずかる あそぶ",
      "的 一 是 在 不 了 有 和 人 这 中 大 为 上 个 国 我 以",

      "абажур абзац абонент абрикос автобус август автор адрес азбука айва акула алмаз алтарь альбом ангел антенна аптека арбуз арена артист архив",

      "أبجد إبرة أثاث أجمل أحمر أخبار إدارة إذن أرنب أزرق أسد أشجار أطفال إعصار أغنية أفكار أقلام أكبر ألماس أمطار أنوار أهل أوتار أيام",
      "https://wallet-user:wallet-password@node.example.test/private",
      "private_key=private-key-canary",
      "spending-key: spending-key-canary",
      "viewing key = viewing-key-canary",
      "signing.key=signing-key-canary",
      "proving key: proving-key-canary",
      "access-token=access-token-canary",
      "refresh token: refresh-token-canary",
      "session_token=session-token-canary",
      "cookie=session-cookie-canary",
      "client secret=client-secret-canary",
      "raw tx=raw-transaction-canary",
      "proof=proof-canary",
      "witness: witness-canary",
      "redeemer=redeemer-canary",
      "checkpoint: checkpoint-canary",
      "vault=vault-canary",

      '{"version":3,"crypto":{"cipher":"aes-128-ctr","ciphertext":"keystore-canary","kdf":"scrypt","mac":"001122"}}',
      '{"account":{"privateKey":"json-private-key-canary"}}',
    ] as const;
    const secretFields = Object.fromEntries(
      secrets.map((secret, index) => [`case${index}`, secret]),
    );
    const detectorManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections: secrets.map((_, index) => ({
        source: `diagnostic.case${index}`,
        target: `event.case${index}`,
        classification: "S3" as const,
        transform: "copy" as const,
      })),
    };

    const result = await sanitizer.sanitize({ diagnostic: secretFields }, detectorManifest);

    expect(result.ok && result.value.value).toEqual({});
    expect(result.ok && result.value.audit.decisions.removed).toBe(secrets.length);
    const serialized = JSON.stringify(result);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  it("retains ordinary prose and public identifiers that resemble secret encodings", async () => {
    const sanitizer = createSanitizer();
    const benign = {
      prose:
        "Sync completed normally, and the wallet is now ready for another requested operation.",
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      transactionHash: "a3".repeat(32),
      publicAddress: "addr_test1vqpz3u8m7y5w4x2c9publicaddress",
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA111111111111111111111111111111111111111=\n-----END PUBLIC KEY-----",
      shortDiagnostic: "Node connected",
      benignUrl: "https://node.example.test:9944/status?network=preview",
    };
    const benignManifest: AdapterSanitizationManifest = {
      ...manifest,
      projections: Object.keys(benign).map((source) => ({
        source: `diagnostic.${source}`,
        target: `event.${source}`,
        classification: "S3" as const,
        transform: "copy" as const,
      })),
    };

    const result = await sanitizer.sanitize({ diagnostic: benign }, benignManifest);

    expect(result.ok && result.value.value).toEqual({ event: benign });
    expect(result.ok && result.value.audit.decisions).toEqual({
      copied: Object.keys(benign).length,
      pseudonymised: 0,
      transformed: 0,
      removed: 0,
    });
  });
});
