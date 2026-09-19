// ASTY Rebound API
// Helius balances + deposits + Privy Additional Signer + controlled Jupiter test swap

import { PrivyClient } from "@privy-io/node";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com/";
const JUPITER_SWAP_BASE = "https://api.jup.ag/swap/v1"; // diagnostic test only

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

const JUPITER_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";

const SOLANA_MAINNET_CAIP2 =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

const TEST_SWAP_USDC_RAW = 100000n; // 0.10 USDC
const TEST_SWAP_SLIPPAGE_BPS = 50; // 0.5%

let solPriceCache = {
  price: null,
  expiresAt: 0,
};


/* ==================================================
   BASIC HELPERS
================================================== */

function corsHeaders(request) {
  const origin =
    request.headers.get("Origin");

  const headers = {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",
  };

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    headers[
      "Access-Control-Allow-Origin"
    ] = origin;

    headers[
      "Vary"
    ] = "Origin";

    headers[
      "Access-Control-Allow-Methods"
    ] =
      "GET,POST,OPTIONS";

    headers[
      "Access-Control-Allow-Headers"
    ] =
      "Content-Type, Authorization";
  }

  return headers;
}


function json(
  request,
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers:
        corsHeaders(request),
    }
  );
}


function createPrivyClient(env) {
  return new PrivyClient({
    appId:
      env.PRIVY_APP_ID,

    appSecret:
      env.PRIVY_APP_SECRET,
  });
}


function createAuthorizationContext(env) {
  if (
    !env.PRIVY_AUTH_PRIVATE_KEY
  ) {
    throw new Error(
      "PRIVY_AUTH_PRIVATE_KEY is not configured."
    );
  }

  return {
    authorization_private_keys: [
      env.PRIVY_AUTH_PRIVATE_KEY,
    ],
  };
}


function getBearerToken(request) {
  const auth =
    request.headers.get(
      "Authorization"
    ) || "";

  return auth.startsWith(
    "Bearer "
  )
    ? auth.slice(7).trim()
    : null;
}


function isSolanaAddress(value) {
  return (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
      .test(value)
  );
}


function isTransactionSignature(
  value
) {
  return (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{80,100}$/
      .test(value)
  );
}


function isPositiveAmount(value) {
  const text =
    String(
      value ?? ""
    ).trim();

  return (
    /^\d+(\.\d+)?$/.test(
      text
    ) &&
    Number.isFinite(
      Number(text)
    ) &&
    Number(text) > 0
  );
}


function formatUnits(
  rawValue,
  decimals
) {
  const raw =
    typeof rawValue ===
      "bigint"
      ? rawValue
      : BigInt(rawValue);

  const negative =
    raw < 0n;

  const absolute =
    negative
      ? -raw
      : raw;

  const base =
    10n **
    BigInt(decimals);

  const whole =
    absolute / base;

  const fraction =
    absolute % base;

  let result =
    whole.toString();

  if (
    decimals > 0
  ) {
    result +=
      "." +
      fraction
        .toString()
        .padStart(
          decimals,
          "0"
        );
  }

  return negative
    ? `-${result}`
    : result;
}


function utf8ToBase64(value) {
  const bytes =
    new TextEncoder()
      .encode(
        String(value)
      );

  let binary =
    "";

  for (
    const byte
    of bytes
  ) {
    binary +=
      String.fromCharCode(
        byte
      );
  }

  return btoa(binary);
}


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function getSafePrivyError(
  error
) {
  const status =
    Number.isFinite(
      Number(
        error?.status
      )
    )
      ? Number(
          error.status
        )
      : null;

  const code =
    error?.code ??
    error?.error?.code ??
    error?.body?.error?.code ??
    null;

  return {
    status,

    name:
      typeof error?.name ===
        "string"
        ? error.name
        : null,

    code:
      code == null
        ? null
        : String(code),

    message:
      typeof error?.message ===
        "string"
        ? error.message
            .slice(
              0,
              500
            )
        : "Privy request failed.",
  };
}


function looksLikePolicyDenial(
  info
) {
  const text =
    [
      info?.name,
      info?.code,
      info?.message,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  return (
    text.includes(
      "policy"
    ) ||
    text.includes(
      "denied"
    ) ||
    text.includes(
      "not allowed"
    ) ||
    text.includes(
      "not permitted"
    ) ||
    text.includes(
      "forbidden"
    )
  );
}


/* ==================================================
   PRIVY AUTH
================================================== */

async function verifyPrivyRequest(
  request,
  env
) {
  const accessToken =
    getBearerToken(
      request
    );

  if (
    !accessToken
  ) {
    return {
      ok: false,
      status: 401,
      message:
        "Missing authentication token.",
    };
  }

  try {
    const claims =
      await createPrivyClient(
        env
      )
        .utils()
        .auth()
        .verifyAccessToken(
          accessToken
        );

    if (
      !claims?.user_id
    ) {
      return {
        ok: false,
        status: 401,
        message:
          "Privy user ID could not be verified.",
      };
    }

    return {
      ok: true,
      userId:
        claims.user_id,
      claims,
    };

  } catch (error) {
    console.error(
      "Privy verification error:",
      error
    );

    return {
      ok: false,
      status: 401,
      message:
        "Invalid or expired Privy session.",
    };
  }
}


/* ==================================================
   D1
================================================== */

async function getReboundAccount(
  env,
  privyUserId
) {
  return env.DB
    .prepare(
      `
      SELECT
        phantom_address,
        privy_user_id,
        rebound_wallet_id,
        rebound_wallet_address,
        created_at,
        updated_at
      FROM rebound_users
      WHERE privy_user_id = ?
      LIMIT 1
      `
    )
    .bind(
      privyUserId
    )
    .first();
}


/* ==================================================
   HELIUS
================================================== */

function getHeliusUrl(env) {
  if (
    !env.HELIUS_API_KEY
  ) {
    throw new Error(
      "HELIUS_API_KEY is not configured."
    );
  }

  return (
    HELIUS_RPC_BASE +
    "?api-key=" +
    encodeURIComponent(
      env.HELIUS_API_KEY
    )
  );
}


async function heliusRpc(
  env,
  method,
  params
) {
  const response =
    await fetch(
      getHeliusUrl(env),
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body:
          JSON.stringify({
            jsonrpc:
              "2.0",

            id:
              "asty-rebound",

            method,

            params,
          }),
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Helius HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data =
    await response.json();

  if (
    data?.error
  ) {
    throw new Error(
      data.error?.message ||
      "Helius returned an RPC error."
    );
  }

  return (
    data?.result ??
    data
  );
}


/* ==================================================
   SOL BALANCE
================================================== */

async function getSolBalance(
  env,
  walletAddress
) {
  const result =
    await heliusRpc(
      env,
      "getBalance",
      [
        walletAddress,
        {
          commitment:
            "confirmed",
        },
      ]
    );

  const lamports =
    BigInt(
      result?.value ??
      0
    );

  return {
    raw:
      lamports
        .toString(),

    ui:
      formatUnits(
        lamports,
        SOL_DECIMALS
      ),
  };
}


/* ==================================================
   USDC
================================================== */

async function getUsdcViaDas(
  env,
  walletAddress
) {
  const result =
    await heliusRpc(
      env,
      "getTokenAccounts",
      {
        owner:
          walletAddress,

        mint:
          USDC_MINT,

        options: {
          showZeroBalance:
            true,
        },
      }
    );

  const accounts =
    Array.isArray(
      result?.token_accounts
    )
      ? result.token_accounts
      : [];

  let totalRaw =
    0n;

  for (
    const account
    of accounts
  ) {
    if (
      account?.amount !=
      null
    ) {
      totalRaw +=
        BigInt(
          String(
            account.amount
          )
        );
    }
  }

  return {
    raw:
      totalRaw.toString(),

    ui:
      formatUnits(
        totalRaw,
        USDC_DECIMALS
      ),

    method:
      "helius-getTokenAccounts",
  };
}


async function getUsdcViaStandardRpc(
  env,
  walletAddress
) {
  const result =
    await heliusRpc(
      env,
      "getTokenAccountsByOwner",
      [
        walletAddress,

        {
          mint:
            USDC_MINT,
        },

        {
          commitment:
            "confirmed",

          encoding:
            "jsonParsed",
        },
      ]
    );

  const accounts =
    Array.isArray(
      result?.value
    )
      ? result.value
      : [];

  let totalRaw =
    0n;

  for (
    const tokenAccount
    of accounts
  ) {
    const amount =
      tokenAccount
        ?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount
        ?.amount;

    if (
      typeof amount ===
        "string"
    ) {
      totalRaw +=
        BigInt(
          amount
        );
    }
  }

  return {
    raw:
      totalRaw.toString(),

    ui:
      formatUnits(
        totalRaw,
        USDC_DECIMALS
      ),

    method:
      "helius-getTokenAccountsByOwner",
  };
}


async function getUsdcBalance(
  env,
  walletAddress
) {
  try {
    return await getUsdcViaDas(
      env,
      walletAddress
    );

  } catch (error) {
    console.error(
      "DAS USDC lookup failed; using standard RPC:",
      error
    );

    return getUsdcViaStandardRpc(
      env,
      walletAddress
    );
  }
}


/* ==================================================
   SOL TRADING ACCOUNT / WSOL

   This is deliberately separated from native SOL.
   Native SOL remains the network-fee reserve.
================================================== */

async function getWsolTokenAccount(
  env,
  walletAddress
) {
  try {
    const result =
      await heliusRpc(
        env,
        "getTokenAccounts",
        {
          owner:
            walletAddress,

          mint:
            WSOL_MINT,

          options: {
            showZeroBalance:
              true,
          },
        }
      );

    const accounts =
      Array.isArray(
        result?.token_accounts
      )
        ? result.token_accounts
        : [];

    const account =
      accounts.find(
        item =>
          typeof item?.address ===
            "string" &&
          item?.owner ===
            walletAddress
      ) ||
      accounts.find(
        item =>
          typeof item?.address ===
            "string"
      ) ||
      null;

    if (
      account
    ) {
      const raw =
        BigInt(
          String(
            account?.amount ??
            "0"
          )
        );

      return {
        ready:
          true,

        address:
          account.address,

        raw:
          raw.toString(),

        ui:
          formatUnits(
            raw,
            SOL_DECIMALS
          ),

        method:
          "helius-getTokenAccounts",
      };
    }

  } catch (error) {
    console.error(
      "DAS WSOL lookup failed; using standard RPC:",
      error
    );
  }

  const result =
    await heliusRpc(
      env,
      "getTokenAccountsByOwner",
      [
        walletAddress,

        {
          mint:
            WSOL_MINT,
        },

        {
          commitment:
            "confirmed",

          encoding:
            "jsonParsed",
        },
      ]
    );

  const accounts =
    Array.isArray(
      result?.value
    )
      ? result.value
      : [];

  const tokenAccount =
    accounts.find(
      item =>
        typeof item?.pubkey ===
          "string" &&
        item?.account
          ?.data
          ?.parsed
          ?.info
          ?.owner ===
          walletAddress
    ) ||
    accounts[0] ||
    null;

  if (
    !tokenAccount
  ) {
    return {
      ready:
        false,

      address:
        null,

      raw:
        "0",

      ui:
        "0.000000000",

      method:
        "helius-getTokenAccountsByOwner",
    };
  }

  const raw =
    BigInt(
      String(
        tokenAccount
          ?.account
          ?.data
          ?.parsed
          ?.info
          ?.tokenAmount
          ?.amount ??
        "0"
      )
    );

  return {
    ready:
      true,

    address:
      tokenAccount.pubkey,

    raw:
      raw.toString(),

    ui:
      formatUnits(
        raw,
        SOL_DECIMALS
      ),

    method:
      "helius-getTokenAccountsByOwner",
  };
}


/* ==================================================
   DISPLAY PRICE
================================================== */

async function getSolUsdPrice(
  env
) {
  const now =
    Date.now();

  if (
    solPriceCache.price !=
      null &&
    now <
      solPriceCache.expiresAt
  ) {
    return solPriceCache.price;
  }

  const result =
    await heliusRpc(
      env,
      "getAsset",
      {
        id:
          WSOL_MINT,

        displayOptions: {
          showFungible:
            true,
        },
      }
    );

  const price =
    Number(
      result
        ?.token_info
        ?.price_info
        ?.price_per_token
    );

  if (
    !Number.isFinite(
      price
    ) ||
    price <= 0
  ) {
    throw new Error(
      "SOL USD price unavailable."
    );
  }

  solPriceCache = {
    price,

    expiresAt:
      now +
      60_000,
  };

  return price;
}


/* ==================================================
   BLOCKHASH
================================================== */

async function getLatestBlockhash(
  env
) {
  const result =
    await heliusRpc(
      env,
      "getLatestBlockhash",
      [
        {
          commitment:
            "confirmed",
        },
      ]
    );

  const blockhash =
    result?.value
      ?.blockhash;

  const lastValidBlockHeight =
    result?.value
      ?.lastValidBlockHeight;

  if (
    !blockhash ||
    !lastValidBlockHeight
  ) {
    throw new Error(
      "Could not obtain a fresh Solana blockhash."
    );
  }

  return {
    blockhash,
    lastValidBlockHeight,
  };
}


/* ==================================================
   PRIVY DELEGATED WALLET
================================================== */

async function getPrivyDelegatedWallet(
  privy,
  userId,
  reboundWalletAddress
) {
  const privyUser =
    await privy
      .users()
      ._get(
        userId
      );

  const linkedAccounts =
    Array.isArray(
      privyUser
        ?.linked_accounts
    )
      ? privyUser
          .linked_accounts
      : Array.isArray(
          privyUser
            ?.linkedAccounts
        )
        ? privyUser
            .linkedAccounts
        : [];

  return (
    linkedAccounts.find(
      item =>
        item?.type ===
          "wallet" &&
        item?.address ===
          reboundWalletAddress &&
        item?.delegated ===
          true
    ) ||
    null
  );
}


/* ==================================================
   JUPITER
================================================== */

async function jupiterFetch(
  env,
  path,
  options = {}
) {
  let lastError =
    null;

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          JUPITER_SWAP_BASE +
            path,
          {
            ...options,

            headers: {
              Accept:
                "application/json",

              ...(options.body
                ? {
                    "Content-Type":
                      "application/json",
                  }
                : {}),

              ...(env
                .JUPITER_API_KEY
                ? {
                    "x-api-key":
                      env
                        .JUPITER_API_KEY,
                  }
                : {}),

              ...(options.headers ||
                {}),
            },
          }
        );

      const text =
        await response.text();

      let data =
        null;

      try {
        data =
          text
            ? JSON.parse(
                text
              )
            : null;

      } catch {
        data =
          null;
      }

      if (
        !response.ok
      ) {
        const message =
          data?.error ||
          data?.message ||
          `Jupiter HTTP ${response.status}: ${text.slice(0, 240)}`;

        lastError =
          new Error(
            message
          );

        if (
          response.status ===
            429 &&
          attempt < 2
        ) {
          await sleep(
            2200 *
              (attempt + 1)
          );

          continue;
        }

        throw lastError;
      }

      return data;

    } catch (error) {
      lastError =
        error;

      if (
        attempt < 2
      ) {
        await sleep(
          700 *
            (attempt + 1)
        );

        continue;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Jupiter request failed."
    )
  );
}


function instructionProgramIds(
  plan
) {
  const ids =
    [];

  for (
    const item
    of plan
      ?.computeBudgetInstructions ||
    []
  ) {
    if (
      item?.programId
    ) {
      ids.push(
        item.programId
      );
    }
  }

  for (
    const item
    of plan
      ?.setupInstructions ||
    []
  ) {
    if (
      item?.programId
    ) {
      ids.push(
        item.programId
      );
    }
  }

  if (
    plan
      ?.tokenLedgerInstruction
      ?.programId
  ) {
    ids.push(
      plan
        .tokenLedgerInstruction
        .programId
    );
  }

  if (
    plan
      ?.swapInstruction
      ?.programId
  ) {
    ids.push(
      plan
        .swapInstruction
        .programId
    );
  }

  if (
    plan
      ?.cleanupInstruction
      ?.programId
  ) {
    ids.push(
      plan
        .cleanupInstruction
        .programId
    );
  }

  for (
    const item
    of plan
      ?.otherInstructions ||
    []
  ) {
    if (
      item?.programId
    ) {
      ids.push(
        item.programId
      );
    }
  }

  return [
    ...new Set(ids),
  ];
}


function extractPrivyTxHash(
  result
) {
  return (
    result?.hash ||
    result?.data?.hash ||
    result?.signature ||
    result?.result
      ?.signature ||
    null
  );
}


/* ==================================================
   ROOT
================================================== */

async function handleRoot(
  request
) {
  return json(
    request,
    {
      service:
        "ASTY Rebound API",

      status:
        "online",

      balanceSource:
        "Helius",

      displayPriceSource:
        "Helius DAS",

      endpoints: {
        health:
          "/health",

        privyTest:
          "/privy-test",

        accountSync:
          "POST /account/sync",

        accountBalance:
          "GET /account/balance",

        depositContext:
          "POST /deposit/context",

        transactionStatus:
          "GET /transaction/status?signature=...",

        tradingAuthorization:
          "GET /trading/authorization-config",

        prepareSolTrading:
          "POST /trading/prepare-sol-context",

        serverSignerTest:
          "POST /trading/server-signer-test",

        testSwap:
          "POST /trading/test-swap",
      },
    }
  );
}


/* ==================================================
   HEALTH
================================================== */

async function handleHealth(
  request,
  env
) {
  try {
    const dbTest =
      await env.DB
        .prepare(
          "SELECT 1 AS ok"
        )
        .first();

    return json(
      request,
      {
        status:
          "ok",

        service:
          "ASTY Rebound API",

        database:
          dbTest?.ok === 1
            ? "connected"
            : "error",

        config: {
          privyAppId:
            Boolean(
              env.PRIVY_APP_ID
            ),

          privyAppSecret:
            Boolean(
              env.PRIVY_APP_SECRET
            ),

          privyAuthorizationKeyId:
            Boolean(
              env.PRIVY_AUTH_KEY_ID
            ),

          privyAuthorizationPrivateKey:
            Boolean(
              env.PRIVY_AUTH_PRIVATE_KEY
            ),

          privyPolicyId:
            Boolean(
              env.PRIVY_POLICY_ID
            ),

          heliusApiKey:
            Boolean(
              env.HELIUS_API_KEY
            ),

          jupiterApiKey:
            Boolean(
              env.JUPITER_API_KEY
            ),
        },
      }
    );

  } catch (error) {
    console.error(
      "Health error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Backend health check failed.",
      },
      500
    );
  }
}


/* ==================================================
   PRIVY TEST
================================================== */

async function handlePrivyTest(
  request,
  env
) {
  try {
    const privy =
      createPrivyClient(
        env
      );

    return json(
      request,
      {
        status:
          "ok",

        service:
          "ASTY Rebound API",

        privy: {
          sdkLoaded:
            true,

          clientInitialized:
            Boolean(
              privy
            ),
        },
      }
    );

  } catch (error) {
    console.error(
      "Privy test error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Privy SDK initialization failed.",
      },
      500
    );
  }
}


/* ==================================================
   ACCOUNT SYNC
================================================== */

async function handleAccountSync(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const body =
      await request.json();

    const phantomAddress =
      body?.phantomAddress;

    const reboundWalletAddress =
      body
        ?.reboundWalletAddress;

    const reboundWalletId =
      body?.reboundWalletId ||
      null;

    if (
      !isSolanaAddress(
        phantomAddress
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Invalid Phantom wallet address.",
        },
        400
      );
    }

    if (
      !isSolanaAddress(
        reboundWalletAddress
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Invalid Rebound wallet address.",
        },
        400
      );
    }

    if (
      phantomAddress ===
      reboundWalletAddress
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Phantom and Rebound wallet cannot be identical.",
        },
        400
      );
    }

    const existing =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      existing
    ) {
      if (
        existing
          .phantom_address !==
        phantomAddress
      ) {
        return json(
          request,
          {
            status:
              "error",

            message:
              "This Rebound account is already linked to another Phantom wallet.",
          },
          409
        );
      }

      if (
        existing
          .rebound_wallet_address !==
        reboundWalletAddress
      ) {
        return json(
          request,
          {
            status:
              "error",

            message:
              "A different Rebound wallet is already registered for this account.",
          },
          409
        );
      }

      if (
        !existing
          .rebound_wallet_id &&
        reboundWalletId
      ) {
        await env.DB
          .prepare(
            `
            UPDATE rebound_users
            SET
              rebound_wallet_id = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE privy_user_id = ?
            `
          )
          .bind(
            reboundWalletId,
            auth.userId
          )
          .run();

      } else {
        await env.DB
          .prepare(
            `
            UPDATE rebound_users
            SET
              updated_at = CURRENT_TIMESTAMP
            WHERE privy_user_id = ?
            `
          )
          .bind(
            auth.userId
          )
          .run();
      }

      return json(
        request,
        {
          status:
            "ok",

          synced:
            true,

          existing:
            true,

          account: {
            phantomAddress:
              existing
                .phantom_address,

            privyUserId:
              existing
                .privy_user_id,

            reboundWalletId:
              existing
                .rebound_wallet_id ||
              reboundWalletId,

            reboundWalletAddress:
              existing
                .rebound_wallet_address,
          },
        }
      );
    }

    const existingPhantom =
      await env.DB
        .prepare(
          `
          SELECT
            privy_user_id
          FROM rebound_users
          WHERE phantom_address = ?
          LIMIT 1
          `
        )
        .bind(
          phantomAddress
        )
        .first();

    if (
      existingPhantom
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "This Phantom wallet is already registered with ASTY Rebound.",
        },
        409
      );
    }

    await env.DB
      .prepare(
        `
        INSERT INTO rebound_users (
          phantom_address,
          privy_user_id,
          rebound_wallet_id,
          rebound_wallet_address,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        `
      )
      .bind(
        phantomAddress,
        auth.userId,
        reboundWalletId,
        reboundWalletAddress
      )
      .run();

    return json(
      request,
      {
        status:
          "ok",

        synced:
          true,

        existing:
          false,

        account: {
          phantomAddress,

          privyUserId:
            auth.userId,

          reboundWalletId,

          reboundWalletAddress,
        },
      },
      201
    );

  } catch (error) {
    console.error(
      "Account sync error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Account synchronization failed.",
      },
      500
    );
  }
}


/* ==================================================
   BALANCE
================================================== */

async function handleBalance(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    const wallet =
      account
        .rebound_wallet_address;

    const [
      sol,
      usdc,
      tradingSol
    ] =
      await Promise.all([
        getSolBalance(
          env,
          wallet
        ),

        getUsdcBalance(
          env,
          wallet
        ),

        getWsolTokenAccount(
          env,
          wallet
        ),
      ]);

    let solUsd =
      null;

    try {
      solUsd =
        await getSolUsdPrice(
          env
        );

    } catch (error) {
      console.error(
        "SOL display price unavailable:",
        error
      );
    }

    const solAmount =
      Number(
        sol.ui
      );

    const usdcAmount =
      Number(
        usdc.ui
      );

    return json(
      request,
      {
        status:
          "ok",

        wallet,

        source:
          "helius",

        balances: {
          usdc: {
            mint:
              USDC_MINT,

            decimals:
              USDC_DECIMALS,

            raw:
              usdc.raw,

            ui:
              usdc.ui,

            usdValue:
              Number.isFinite(
                usdcAmount
              )
                ? usdcAmount
                : null,
          },

          sol: {
            decimals:
              SOL_DECIMALS,

            lamports:
              sol.raw,

            ui:
              sol.ui,

            usdValue:
              Number.isFinite(
                solAmount
              ) &&
              Number.isFinite(
                solUsd
              )
                ? solAmount *
                  solUsd
                : null,
          },

          tradingSol: {
            internalAsset:
              "WSOL",

            mint:
              WSOL_MINT,

            decimals:
              SOL_DECIMALS,

            ready:
              tradingSol.ready,

            tokenAccount:
              tradingSol.address,

            raw:
              tradingSol.raw,

            ui:
              tradingSol.ui,
          },
        },

        prices: {
          solUsd,
          usdcUsd:
            1,
        },

        priceUse:
          "display-only",

        commitment:
          "confirmed",
      }
    );

  } catch (error) {
    console.error(
      "Balance error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Your Rebound Balance is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   DEPOSIT
================================================== */

async function handleDepositContext(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.phantom_address ||
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    const body =
      await request.json();

    const asset =
      String(
        body?.asset ||
        ""
      ).toUpperCase();

    const amount =
      String(
        body?.amount ||
        ""
      ).trim();

    if (
      asset !== "SOL" &&
      asset !== "USDC"
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Unsupported deposit asset.",
        },
        400
      );
    }

    if (
      !isPositiveAmount(
        amount
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Enter a valid deposit amount.",
        },
        400
      );
    }

    const maxDecimals =
      asset === "USDC"
        ? USDC_DECIMALS
        : SOL_DECIMALS;

    const decimalPart =
      amount
        .split(".")[1] ||
      "";

    if (
      decimalPart.length >
      maxDecimals
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            `${asset} supports a maximum of ${maxDecimals} decimal places.`,
        },
        400
      );
    }

    const latest =
      await getLatestBlockhash(
        env
      );

    return json(
      request,
      {
        status:
          "ok",

        chain:
          "solana:mainnet",

        asset,

        amount,

        decimals:
          maxDecimals,

        from:
          account
            .phantom_address,

        to:
          account
            .rebound_wallet_address,

        usdcMint:
          USDC_MINT,

        blockhash:
          latest.blockhash,

        lastValidBlockHeight:
          latest
            .lastValidBlockHeight,
      }
    );

  } catch (error) {
    console.error(
      "Deposit context error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Deposit preparation is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   TRANSACTION STATUS
================================================== */

async function handleTransactionStatus(
  request,
  env,
  url
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const signature =
      url.searchParams
        .get(
          "signature"
        );

    if (
      !isTransactionSignature(
        signature
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Invalid transaction signature.",
        },
        400
      );
    }

    const result =
      await heliusRpc(
        env,
        "getSignatureStatuses",
        [
          [
            signature
          ],

          {
            searchTransactionHistory:
              true,
          },
        ]
      );

    const status =
      result
        ?.value?.[0] ||
      null;

    if (
      !status
    ) {
      return json(
        request,
        {
          status:
            "ok",

          found:
            false,

          confirmed:
            false,

          finalized:
            false,

          confirmationStatus:
            null,

          transactionError:
            null,
        }
      );
    }

    const confirmationStatus =
      status
        .confirmationStatus ||
      null;

    const transactionError =
      status.err ||
      null;

    const confirmed =
      !transactionError &&
      (
        confirmationStatus ===
          "confirmed" ||
        confirmationStatus ===
          "finalized"
      );

    const finalized =
      !transactionError &&
      confirmationStatus ===
        "finalized";

    return json(
      request,
      {
        status:
          "ok",

        found:
          true,

        confirmed,

        finalized,

        confirmationStatus,

        transactionError,

        slot:
          status.slot ??
          null,
      }
    );

  } catch (error) {
    console.error(
      "Transaction status error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Transaction status is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   ADDITIONAL SIGNER CONFIG
================================================== */

async function handleAuthorizationConfig(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    if (
      !env
        .PRIVY_AUTH_KEY_ID ||
      !env
        .PRIVY_AUTH_PRIVATE_KEY ||
      !env
        .PRIVY_POLICY_ID
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Automated trading is not configured yet.",
        },
        503
      );
    }

    return json(
      request,
      {
        status:
          "ok",

        wallet:
          account
            .rebound_wallet_address,

        signerId:
          env
            .PRIVY_AUTH_KEY_ID,

        policyId:
          env
            .PRIVY_POLICY_ID,

        policyProtected:
          true,
      }
    );

  } catch (error) {
    console.error(
      "Trading authorization config error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Automated trading authorization is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   PREPARE SOL TRADING

   Creates only the context.
   The actual ATA creation is signed by Phantom
   from the frontend.
================================================== */

async function handlePrepareSolContext(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.phantom_address ||
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    const wsol =
      await getWsolTokenAccount(
        env,
        account
          .rebound_wallet_address
      );

    if (
      wsol.ready
    ) {
      return json(
        request,
        {
          status:
            "ok",

          alreadyReady:
            true,

          from:
            account
              .phantom_address,

          owner:
            account
              .rebound_wallet_address,

          wsolMint:
            WSOL_MINT,

          tokenAccount:
            wsol.address,
        }
      );
    }

    const latest =
      await getLatestBlockhash(
        env
      );

    return json(
      request,
      {
        status:
          "ok",

        alreadyReady:
          false,

        from:
          account
            .phantom_address,

        owner:
          account
            .rebound_wallet_address,

        wsolMint:
          WSOL_MINT,

        blockhash:
          latest.blockhash,

        lastValidBlockHeight:
          latest
            .lastValidBlockHeight,
      }
    );

  } catch (error) {
    console.error(
      "Prepare SOL trading context error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "SOL trading preparation is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   SERVER SIGNER SECURITY TEST
================================================== */

async function handleServerSignerTest(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    const privy =
      createPrivyClient(
        env
      );

    const delegatedWallet =
      await getPrivyDelegatedWallet(
        privy,
        auth.userId,
        account
          .rebound_wallet_address
      );

    if (
      !delegatedWallet
    ) {
      return json(
        request,
        {
          status:
            "error",

          serverReady:
            false,

          delegated:
            false,

          message:
            "Privy does not report the Rebound Wallet as delegated yet.",
        },
        409
      );
    }

    const walletId =
      account
        .rebound_wallet_id ||
      delegatedWallet?.id ||
      null;

    if (
      !walletId
    ) {
      return json(
        request,
        {
          status:
            "error",

          serverReady:
            false,

          delegated:
            true,

          message:
            "Rebound Wallet ID is unavailable.",
        },
        409
      );
    }

    const message =
      utf8ToBase64(
        [
          "ASTY Rebound server signer security test",

          account
            .rebound_wallet_address,

          new Date()
            .toISOString(),
        ].join(
          " | "
        )
      );

    try {
      await privy
        .wallets()
        .solana()
        .signMessage(
          walletId,
          {
            message,

            authorization_context:
              createAuthorizationContext(
                env
              ),
          }
        );

      return json(
        request,
        {
          status:
            "warning",

          serverReady:
            true,

          delegated:
            true,

          policyProtected:
            false,

          result:
            "unexpectedly_allowed",

          message:
            "Server signing works, but signMessage was unexpectedly allowed. Review the trading policy before real trading.",
        },
        409
      );

    } catch (error) {
      const info =
        getSafePrivyError(
          error
        );

      if (
        looksLikePolicyDenial(
          info
        )
      ) {
        return json(
          request,
          {
            status:
              "ok",

            serverReady:
              true,

            delegated:
              true,

            authorizationRequestReachedPrivy:
              true,

            policyProtected:
              true,

            result:
              "blocked_as_expected",

            message:
              "Server signer reached Privy and the Trading Policy blocked the non-trading signMessage request as expected.",

            privy:
              info,
          }
        );
      }

      return json(
        request,
        {
          status:
            "error",

          serverReady:
            false,

          delegated:
            true,

          authorizationRequestReachedPrivy:
            true,

          policyProtected:
            null,

          result:
            "blocked_unclassified",

          message:
            "Privy rejected the server signing test, but the response was not clearly identified as a policy denial.",

          privy:
            info,
        },
        502
      );
    }

  } catch (error) {
    console.error(
      "Server signer test error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        serverReady:
          false,

        message:
          "Server signer test could not be completed.",

        privy:
          getSafePrivyError(
            error
          ),
      },
      503
    );
  }
}


/* ==================================================
   TEST SWAP

   Exactly 0.10 USDC -> WSOL.

   Before Privy receives the transaction,
   Jupiter's instruction plan is inspected.
================================================== */

async function handleTestSwap(
  request,
  env
) {
  try {
    const auth =
      await verifyPrivyRequest(
        request,
        env
      );

    if (
      !auth.ok
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            auth.message,
        },
        auth.status
      );
    }

    let body =
      {};

    try {
      body =
        await request.json();

    } catch {
      body =
        {};
    }

    if (
      body?.confirm !==
      "TEST_SWAP_0_10_USDC_TO_SOL"
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Explicit test swap confirmation is required.",
        },
        400
      );
    }

    const account =
      await getReboundAccount(
        env,
        auth.userId
      );

    if (
      !account
        ?.rebound_wallet_address
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound account not found.",
        },
        404
      );
    }

    const walletAddress =
      account
        .rebound_wallet_address;

    const [
      usdc,
      nativeSol,
      tradingSol
    ] =
      await Promise.all([
        getUsdcBalance(
          env,
          walletAddress
        ),

        getSolBalance(
          env,
          walletAddress
        ),

        getWsolTokenAccount(
          env,
          walletAddress
        ),
      ]);

    if (
      BigInt(
        usdc.raw
      ) <
      TEST_SWAP_USDC_RAW
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "At least 0.10 USDC is required for the test swap.",
        },
        409
      );
    }

    if (
      BigInt(
        nativeSol.raw
      ) <
      100000n
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "The Rebound Wallet needs a small native SOL balance for network fees before the test swap.",
        },
        409
      );
    }

    if (
      !tradingSol.ready ||
      !tradingSol.address
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "sol-trading-preparation",

          needsPreparation:
            true,

          message:
            "SOL trading is not prepared yet. Create the Rebound Wallet's SOL trading account first.",
        },
        409
      );
    }

    const privy =
      createPrivyClient(
        env
      );

    const delegatedWallet =
      await getPrivyDelegatedWallet(
        privy,
        auth.userId,
        walletAddress
      );

    if (
      !delegatedWallet
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Automated Trading is not enabled for this Rebound Wallet.",
        },
        409
      );
    }

    const walletId =
      account
        .rebound_wallet_id ||
      delegatedWallet?.id ||
      null;

    if (
      !walletId
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "Rebound Wallet ID is unavailable.",
        },
        409
      );
    }

    const quoteParams =
      new URLSearchParams({
        inputMint:
          USDC_MINT,

        outputMint:
          WSOL_MINT,

        amount:
          TEST_SWAP_USDC_RAW
            .toString(),

        slippageBps:
          String(
            TEST_SWAP_SLIPPAGE_BPS
          ),

        swapMode:
          "ExactIn",

        restrictIntermediateTokens:
          "true",

        instructionVersion:
          "V2",
      });

    const quote =
      await jupiterFetch(
        env,
        `/quote?${quoteParams.toString()}`
      );

    if (
      !quote ||
      quote.inputMint !==
        USDC_MINT ||
      quote.outputMint !==
        WSOL_MINT ||
      String(
        quote.inAmount
      ) !==
        TEST_SWAP_USDC_RAW
          .toString() ||
      !Array.isArray(
        quote.routePlan
      ) ||
      quote.routePlan.length ===
        0
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "jupiter-quote",

          message:
            "Jupiter did not return a valid test-swap route.",
        },
        502
      );
    }

    const priceImpactPct =
      Number(
        quote.priceImpactPct
      );

    if (
      Number.isFinite(
        priceImpactPct
      ) &&
      priceImpactPct >
        0.01
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "jupiter-quote",

          message:
            "Test swap rejected because Jupiter reported more than 1% price impact.",

          priceImpactPct,
        },
        409
      );
    }

    const swapBuildBody = {
      quoteResponse:
        quote,

      userPublicKey:
        walletAddress,

      wrapAndUnwrapSol:
        false,

      destinationTokenAccount:
        tradingSol.address,

      dynamicComputeUnitLimit:
        true,

      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports:
            10000,

          priorityLevel:
            "medium",
        },
      },
    };

    /*
     * Keyless Jupiter is deliberately
     * rate-limited. Avoid back-to-back
     * requests if no API key is present.
     */
    if (
      !env
        .JUPITER_API_KEY
    ) {
      await sleep(
        2100
      );
    }

    /*
     * Ask Jupiter for the exact instruction
     * plan BEFORE asking Privy to sign.
     */
    const plan =
      await jupiterFetch(
        env,
        "/swap-instructions",
        {
          method:
            "POST",

          body:
            JSON.stringify(
              swapBuildBody
            ),
        }
      );

    const programs =
      instructionProgramIds(
        plan
      );

    const allowed =
      new Set([
        COMPUTE_BUDGET_PROGRAM_ID,
        JUPITER_PROGRAM_ID,
      ]);

    const unexpectedPrograms =
      programs.filter(
        id =>
          !allowed.has(
            id
          )
      );

    const hasSetup =
      Array.isArray(
        plan
          ?.setupInstructions
      ) &&
      plan
        .setupInstructions
        .length > 0;

    const hasCleanup =
      Boolean(
        plan
          ?.cleanupInstruction
      );

    const hasOther =
      Array.isArray(
        plan
          ?.otherInstructions
      ) &&
      plan
        .otherInstructions
        .length > 0;

    const hasTokenLedger =
      Boolean(
        plan
          ?.tokenLedgerInstruction
      );

    if (
      unexpectedPrograms.length ||
      hasSetup ||
      hasCleanup ||
      hasOther ||
      hasTokenLedger ||
      !programs.includes(
        JUPITER_PROGRAM_ID
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "policy-preflight",

          message:
            "Jupiter still requires instructions outside the restricted ASTY Rebound trading policy. Nothing was signed or sent.",

          programs,

          unexpectedPrograms,

          hasSetupInstructions:
            hasSetup,

          hasCleanupInstruction:
            hasCleanup,

          hasOtherInstructions:
            hasOther,

          hasTokenLedgerInstruction:
            hasTokenLedger,
        },
        409
      );
    }

    if (
      !env
        .JUPITER_API_KEY
    ) {
      await sleep(
        2100
      );
    }

    const swapResponse =
      await jupiterFetch(
        env,
        "/swap",
        {
          method:
            "POST",

          body:
            JSON.stringify(
              swapBuildBody
            ),
        }
      );

    const swapTransaction =
      swapResponse
        ?.swapTransaction;

    if (
      typeof swapTransaction !==
        "string" ||
      swapTransaction.length <
        100
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "jupiter-build",

          message:
            "Jupiter did not return a valid swap transaction.",
        },
        502
      );
    }

    let sendResult;

    try {
      sendResult =
        await privy
          .wallets()
          .solana()
          .signAndSendTransaction(
            walletId,
            {
              caip2:
                SOLANA_MAINNET_CAIP2,

              transaction:
                swapTransaction,

              authorization_context:
                createAuthorizationContext(
                  env
                ),
            }
          );

    } catch (error) {
      const info =
        getSafePrivyError(
          error
        );

      return json(
        request,
        {
          status:
            "error",

          stage:
            "privy-sign-and-send",

          policyDenied:
            looksLikePolicyDenial(
              info
            ),

          message:
            `Privy rejected the test swap: ${info.message}`,

          privy:
            info,
        },
        409
      );
    }

    const signature =
      extractPrivyTxHash(
        sendResult
      );

    if (
      !signature ||
      !isTransactionSignature(
        signature
      )
    ) {
      return json(
        request,
        {
          status:
            "error",

          stage:
            "privy-response",

          message:
            "Privy accepted the test swap but did not return a valid Solana transaction signature.",
        },
        502
      );
    }

    return json(
      request,
      {
        status:
          "ok",

        result:
          "submitted",

        assetIn:
          "USDC",

        amountIn:
          "0.10",

        assetOut:
          "SOL",

        internalAssetOut:
          "WSOL",

        quotedOutRaw:
          String(
            quote.outAmount ||
            ""
          ),

        slippageBps:
          TEST_SWAP_SLIPPAGE_BPS,

        priceImpactPct:
          quote
            .priceImpactPct ??
          null,

        signature,
      }
    );

  } catch (error) {
    console.error(
      "Test swap error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          error?.message ||
          "The test swap could not be completed.",
      },
      503
    );
  }
}


/* ==================================================
   ROUTER
================================================== */

export default {
  async fetch(
    request,
    env
  ) {
    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status:
            204,

          headers:
            corsHeaders(
              request
            ),
        }
      );
    }

    const url =
      new URL(
        request.url
      );

    const key =
      `${request.method} ${url.pathname}`;

    switch (
      key
    ) {
      case "GET /":
        return handleRoot(
          request
        );

      case "GET /health":
        return handleHealth(
          request,
          env
        );

      case "GET /privy-test":
        return handlePrivyTest(
          request,
          env
        );

      case "POST /account/sync":
        return handleAccountSync(
          request,
          env
        );

      case "GET /account/balance":
        return handleBalance(
          request,
          env
        );

      case "POST /deposit/context":
        return handleDepositContext(
          request,
          env
        );

      case "GET /transaction/status":
        return handleTransactionStatus(
          request,
          env,
          url
        );

      case "GET /trading/authorization-config":
        return handleAuthorizationConfig(
          request,
          env
        );

      case "POST /trading/prepare-sol-context":
        return handlePrepareSolContext(
          request,
          env
        );

      case "POST /trading/server-signer-test":
        return handleServerSignerTest(
          request,
          env
        );

      case "POST /trading/test-swap":
        return handleTestSwap(
          request,
          env
        );

      default:
        return json(
          request,
          {
            status:
              "error",

            message:
              "Not found",
          },
          404
        );
    }
  },
};
