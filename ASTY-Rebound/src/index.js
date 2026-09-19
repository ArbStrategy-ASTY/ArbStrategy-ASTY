import { PrivyClient } from "@privy-io/node";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com/";
const JUPITER_SWAP_BASE = "https://api.jup.ag/swap/v1";
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";

const ASTY_MINT = "ASTYqeaoK83Zs1pTFEXZUB6BM8cG8YLTsN852NUkt7ZR";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const JUPITER_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";

const SOLANA_MAINNET_CAIP2 =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const ASTY_DECIMALS = 9;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const PRICE_MICRO_DECIMALS = 6;

const MIN_STRATEGY_USDC_RAW = 25_000_000n;
const ASTY_GATE_RAW = 2_500n * 10n ** 9n;
const TEST_SWAP_USDC_RAW = 100_000n;
const TEST_SWAP_SLIPPAGE_BPS = 50;

const PRESETS = Object.freeze({
  frequent: {
    dipBps: 300,
    takeProfitBps: 250,
  },

  balanced: {
    dipBps: 500,
    takeProfitBps: 400,
  },

  deep_dip: {
    dipBps: 800,
    takeProfitBps: 600,
  },
});

const ACTIVE_STRATEGY_STATUSES = [
  "WATCHING",
  "BUY_TRIGGERED",
  "BOUGHT",
  "SELL_TRIGGERED",
  "PAUSED",
];

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

    headers.Vary =
      "Origin";

    headers[
      "Access-Control-Allow-Methods"
    ] = "GET,POST,OPTIONS";

    headers[
      "Access-Control-Allow-Headers"
    ] = "Content-Type, Authorization";
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
    ? auth
        .slice(7)
        .trim()
    : null;
}


function isSolanaAddress(value) {
  return (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
      .test(value)
  );
}


function isTransactionSignature(value) {
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
    /^\d+(\.\d+)?$/
      .test(text) &&
    Number.isFinite(
      Number(text)
    ) &&
    Number(text) > 0
  );
}


function parseDecimalToRaw(
  value,
  decimals
) {
  const text =
    String(
      value ?? ""
    ).trim();

  if (
    !/^\d+(\.\d+)?$/
      .test(text)
  ) {
    throw new Error(
      "Invalid decimal amount."
    );
  }

  const [
    whole,
    fraction = ""
  ] =
    text.split(".");

  if (
    fraction.length >
    decimals
  ) {
    throw new Error(
      `Maximum ${decimals} decimal places.`
    );
  }

  return (
    BigInt(whole) *
      10n **
      BigInt(decimals)
    +
    BigInt(
      fraction
        .padEnd(
          decimals,
          "0"
        )
      ||
      "0"
    )
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
    absolute /
    base;

  const fraction =
    absolute %
    base;

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


function formatMicroUsd(rawValue) {
  if (
    rawValue == null
  ) {
    return null;
  }

  const text =
    formatUnits(
      BigInt(
        String(rawValue)
      ),
      PRICE_MICRO_DECIMALS
    );

  return (
    text
      .replace(
        /0+$/,
        ""
      )
      .replace(
        /\.$/,
        ""
      )
    ||
    "0"
  );
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


function getSafePrivyError(error) {
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
    error?.code
    ??
    error?.error?.code
    ??
    error?.body?.error?.code
    ??
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


function looksLikePolicyDenial(info) {
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
    )
    ||
    text.includes(
      "denied"
    )
    ||
    text.includes(
      "not allowed"
    )
    ||
    text.includes(
      "not permitted"
    )
    ||
    text.includes(
      "forbidden"
    )
  );
}


function normalizeBoolean(
  value,
  defaultValue = false
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return defaultValue;
  }

  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  ) {
    return true;
  }

  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false"
  ) {
    return false;
  }

  throw new Error(
    "Invalid boolean value."
  );
}


function normalizeBps(
  value,
  fieldName,
  {
    min = 1,
    max = 10000,
  } = {}
) {
  const number =
    Number(value);

  if (
    !Number.isInteger(
      number
    ) ||
    number < min ||
    number > max
  ) {
    throw new Error(
      `${fieldName} must be an integer between ${min} and ${max} basis points.`
    );
  }

  return number;
}


function activeStatusSqlPlaceholders() {
  return ACTIVE_STRATEGY_STATUSES
    .map(
      () => "?"
    )
    .join(",");
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

  }
  catch(error) {
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
   D1 ACCOUNT
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
    HELIUS_RPC_BASE
    +
    "?api-key="
    +
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
      `Helius HTTP ${response.status}: ${body.slice(0,300)}`
    );
  }

  const data =
    await response.json();

  if (
    data?.error
  ) {
    throw new Error(
      data.error?.message
      ||
      "Helius returned an RPC error."
    );
  }

  return (
    data?.result
    ??
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
      result?.value
      ??
      0
    );

  return {
    raw:
      lamports.toString(),

    ui:
      formatUnits(
        lamports,
        SOL_DECIMALS
      ),
  };
}


/* ==================================================
   TOKEN BALANCE
================================================== */

async function getTokenBalanceViaDas(
  env,
  walletAddress,
  mint,
  decimals
) {
  const result =
    await heliusRpc(
      env,
      "getTokenAccounts",
      {
        owner:
          walletAddress,

        mint,

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
      account?.amount
      !=
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
        decimals
      ),

    method:
      "helius-getTokenAccounts",
  };
}


async function getTokenBalanceViaStandardRpc(
  env,
  walletAddress,
  mint,
  decimals
) {
  const result =
    await heliusRpc(
      env,
      "getTokenAccountsByOwner",
      [
        walletAddress,

        {
          mint,
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
        BigInt(amount);
    }
  }

  return {
    raw:
      totalRaw.toString(),

    ui:
      formatUnits(
        totalRaw,
        decimals
      ),

    method:
      "helius-getTokenAccountsByOwner",
  };
}


async function getTokenBalance(
  env,
  walletAddress,
  mint,
  decimals
) {
  try {
    return await getTokenBalanceViaDas(
      env,
      walletAddress,
      mint,
      decimals
    );
  }
  catch(error) {
    console.error(
      `DAS token lookup failed for ${mint}; using standard RPC:`,
      error
    );

    return getTokenBalanceViaStandardRpc(
      env,
      walletAddress,
      mint,
      decimals
    );
  }
}


async function getUsdcBalance(
  env,
  walletAddress
) {
  return getTokenBalance(
    env,
    walletAddress,
    USDC_MINT,
    USDC_DECIMALS
  );
}


async function getAstyBalance(
  env,
  walletAddress
) {
  return getTokenBalance(
    env,
    walletAddress,
    ASTY_MINT,
    ASTY_DECIMALS
  );
}


/* ==================================================
   WSOL TRADING ACCOUNT
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
            "string"
          &&
          item?.owner ===
            walletAddress
      )
      ||
      accounts.find(
        item =>
          typeof item?.address ===
            "string"
      )
      ||
      null;

    if (
      account
    ) {
      const raw =
        BigInt(
          String(
            account?.amount
            ??
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
  }
  catch(error) {
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
          "string"
        &&
        item?.account
          ?.data
          ?.parsed
          ?.info
          ?.owner ===
          walletAddress
    )
    ||
    accounts[0]
    ||
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
          ?.amount
        ??
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
   SOL DISPLAY PRICE
================================================== */

async function getSolUsdPrice(env) {
  const now =
    Date.now();

  if (
    solPriceCache.price != null &&
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
    )
    ||
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

async function getLatestBlockhash(env) {
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
    !blockhash
    ||
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
      ._get(userId);

  const linkedAccounts =
    Array.isArray(
      privyUser?.linked_accounts
    )
      ? privyUser.linked_accounts
      : Array.isArray(
          privyUser?.linkedAccounts
        )
        ? privyUser.linkedAccounts
        : [];

  return (
    linkedAccounts.find(
      item =>
        item?.type ===
          "wallet"
        &&
        item?.address ===
          reboundWalletAddress
        &&
        item?.delegated ===
          true
    )
    ||
    null
  );
}


/* ==================================================
   JUPITER SWAP
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
          JUPITER_SWAP_BASE
          +
          path,
          {
            ...options,

            headers: {
              Accept:
                "application/json",

              ...(
                options.body
                  ? {
                      "Content-Type":
                        "application/json",
                    }
                  : {}
              ),

              ...(
                env.JUPITER_API_KEY
                  ? {
                      "x-api-key":
                        env.JUPITER_API_KEY,
                    }
                  : {}
              ),

              ...(
                options.headers
                ||
                {}
              ),
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
            ? JSON.parse(text)
            : null;
      }
      catch {
        data =
          null;
      }

      if (
        !response.ok
      ) {
        const message =
          data?.error
          ||
          data?.message
          ||
          `Jupiter HTTP ${response.status}: ${text.slice(0,240)}`;

        lastError =
          new Error(message);

        if (
          response.status ===
            429
          &&
          attempt < 2
        ) {
          await sleep(
            2200 *
            (
              attempt + 1
            )
          );

          continue;
        }

        throw lastError;
      }

      return data;
    }
    catch(error) {
      lastError =
        error;

      if (
        attempt < 2
      ) {
        await sleep(
          700 *
          (
            attempt + 1
          )
        );

        continue;
      }
    }
  }

  throw (
    lastError
    ||
    new Error(
      "Jupiter request failed."
    )
  );
}


/* ==================================================
   JUPITER PRICE WATCHER PRICE
================================================== */

async function getJupiterSolPriceMicroUsdc(env) {
  const url =
    new URL(
      JUPITER_PRICE_URL
    );

  url.searchParams.set(
    "ids",
    WSOL_MINT
  );

  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          Accept:
            "application/json",

          ...(
            env.JUPITER_API_KEY
              ? {
                  "x-api-key":
                    env.JUPITER_API_KEY,
                }
              : {}
          ),
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
        ? JSON.parse(text)
        : null;
  }
  catch {
    data =
      null;
  }

  if (
    !response.ok
  ) {
    throw new Error(
      data?.message
      ||
      data?.error
      ||
      `Jupiter Price HTTP ${response.status}: ${text.slice(0,240)}`
    );
  }

  const usdPrice =
    Number(
      data
        ?.[WSOL_MINT]
        ?.usdPrice
    );

  if (
    !Number.isFinite(
      usdPrice
    )
    ||
    usdPrice <= 0
  ) {
    throw new Error(
      "Jupiter Price API did not return a valid SOL price."
    );
  }

  const micro =
    BigInt(
      Math.round(
        usdPrice *
        1_000_000
      )
    );

  return {
    micro,
    usdPrice,

    blockId:
      data
        ?.[WSOL_MINT]
        ?.blockId
      ??
      null,

    priceChange24h:
      data
        ?.[WSOL_MINT]
        ?.priceChange24h
      ??
      null,
  };
}


function instructionProgramIds(plan) {
  const ids =
    [];

  for (
    const item
    of plan
      ?.computeBudgetInstructions
      ||
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
      ?.setupInstructions
      ||
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
      ?.otherInstructions
      ||
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


function extractPrivyTxHash(result) {
  return (
    result?.hash
    ||
    result?.data?.hash
    ||
    result?.signature
    ||
    result?.result?.signature
    ||
    null
  );
}


/* ==================================================
   STRATEGY HELPERS
================================================== */

function normalizeStrategyRow(row) {
  if (
    !row
  ) {
    return null;
  }

  return {
    id:
      row.id,

    assetSymbol:
      row.asset_symbol,

    status:
      row.status,

    preset:
      row.preset,

    dipBps:
      Number(
        row.dip_bps
      ),

    takeProfitBps:
      Number(
        row.take_profit_bps
      ),

    stopLossEnabled:
      Boolean(
        row.stop_loss_enabled
      ),

    stopLossBps:
      row.stop_loss_bps == null
        ? null
        : Number(
            row.stop_loss_bps
          ),

    autoRepeat:
      Boolean(
        row.auto_repeat
      ),

    compound:
      Boolean(
        row.compound
      ),

    initialCapitalUsdcRaw:
      String(
        row.initial_capital_usdc_raw
      ),

    reservedCapitalUsdcRaw:
      String(
        row.reserved_capital_usdc_raw
      ),

    currentCycleCapitalUsdcRaw:
      String(
        row.current_cycle_capital_usdc_raw
      ),

    freeProfitUsdcRaw:
      String(
        row.free_profit_usdc_raw
        ??
        0
      ),

    initialCapitalUsdc:
      formatUnits(
        BigInt(
          row.initial_capital_usdc_raw
        ),
        USDC_DECIMALS
      ),

    reservedCapitalUsdc:
      formatUnits(
        BigInt(
          row.reserved_capital_usdc_raw
        ),
        USDC_DECIMALS
      ),

    currentCycleCapitalUsdc:
      formatUnits(
        BigInt(
          row.current_cycle_capital_usdc_raw
        ),
        USDC_DECIMALS
      ),

    freeProfitUsdc:
      formatUnits(
        BigInt(
          row.free_profit_usdc_raw
          ??
          0
        ),
        USDC_DECIMALS
      ),

    hwmPriceMicroUsdc:
      row.hwm_price_micro_usdc == null
        ? null
        : String(
            row.hwm_price_micro_usdc
          ),

    currentPriceMicroUsdc:
      row.current_price_micro_usdc == null
        ? null
        : String(
            row.current_price_micro_usdc
          ),

    buyTriggerPriceMicroUsdc:
      row.buy_trigger_price_micro_usdc == null
        ? null
        : String(
            row.buy_trigger_price_micro_usdc
          ),

    hwmPriceUsd:
      formatMicroUsd(
        row.hwm_price_micro_usdc
      ),

    currentPriceUsd:
      formatMicroUsd(
        row.current_price_micro_usdc
      ),

    buyTriggerPriceUsd:
      formatMicroUsd(
        row.buy_trigger_price_micro_usdc
      ),

    buyFillPriceMicroUsdc:
      row.buy_fill_price_micro_usdc == null
        ? null
        : String(
            row.buy_fill_price_micro_usdc
          ),

    takeProfitPriceMicroUsdc:
      row.take_profit_price_micro_usdc == null
        ? null
        : String(
            row.take_profit_price_micro_usdc
          ),

    stopLossPriceMicroUsdc:
      row.stop_loss_price_micro_usdc == null
        ? null
        : String(
            row.stop_loss_price_micro_usdc
          ),

    entryWsolRaw:
      row.entry_wsol_raw == null
        ? null
        : String(
            row.entry_wsol_raw
          ),

    cycleNumber:
      Number(
        row.cycle_number
        ??
        1
      ),

    astyGateCheckedAt:
      row.asty_gate_checked_at
      ??
      null,

    astyBalanceRawAtCreation:
      row.asty_balance_raw_at_creation
      ??
      null,

    buyTriggeredAt:
      row.buy_triggered_at
      ??
      null,

    boughtAt:
      row.bought_at
      ??
      null,

    sellTriggeredAt:
      row.sell_triggered_at
      ??
      null,

    soldAt:
      row.sold_at
      ??
      null,

    pausedAt:
      row.paused_at
      ??
      null,

    stoppedAt:
      row.stopped_at
      ??
      null,

    lastPriceAt:
      row.last_price_at
      ??
      null,

    pendingAction:
      row.pending_action
      ??
      null,

    pendingSignature:
      row.pending_signature
      ??
      null,

    pendingActionStartedAt:
      row.pending_action_started_at
      ??
      null,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}


async function getReservedCapitalRaw(
  env,
  privyUserId
) {
  const row =
    await env.DB
      .prepare(
        `
        SELECT
          CAST(
            COALESCE(
              SUM(reserved_capital_usdc_raw),
              0
            )
            AS TEXT
          ) AS reserved_raw
        FROM rebound_strategies
        WHERE privy_user_id = ?
          AND status IN (
            ${activeStatusSqlPlaceholders()}
          )
        `
      )
      .bind(
        privyUserId,
        ...ACTIVE_STRATEGY_STATUSES
      )
      .first();

  return BigInt(
    String(
      row?.reserved_raw
      ??
      0
    )
  );
}


function resolveStrategyConfiguration(body) {
  const preset =
    String(
      body?.preset
      ||
      "balanced"
    )
      .trim()
      .toLowerCase();

  let dipBps;
  let takeProfitBps;

  if (
    PRESETS[preset]
  ) {
    dipBps =
      PRESETS[
        preset
      ].dipBps;

    takeProfitBps =
      PRESETS[
        preset
      ].takeProfitBps;
  }
  else if (
    preset ===
    "custom"
  ) {
    dipBps =
      normalizeBps(
        body?.dipBps,
        "dipBps",
        {
          min: 50,
          max: 5000,
        }
      );

    takeProfitBps =
      normalizeBps(
        body?.takeProfitBps,
        "takeProfitBps",
        {
          min: 50,
          max: 10000,
        }
      );
  }
  else {
    throw new Error(
      "Unsupported strategy preset."
    );
  }

  const stopLossEnabled =
    normalizeBoolean(
      body?.stopLossEnabled,
      false
    );

  const stopLossBps =
    stopLossEnabled
      ? normalizeBps(
          body?.stopLossBps,
          "stopLossBps",
          {
            min: 50,
            max: 5000,
          }
        )
      : null;

  return {
    preset,
    dipBps,
    takeProfitBps,
    stopLossEnabled,
    stopLossBps,

    autoRepeat:
      normalizeBoolean(
        body?.autoRepeat,
        false
      ),

    compound:
      normalizeBoolean(
        body?.compound,
        false
      ),
  };
}


/* ==================================================
   WATCHER
================================================== */

async function loadWatchingStrategies(
  env,
  privyUserId = null
) {
  const sql =
    privyUserId
      ? `
        SELECT *
        FROM rebound_strategies
        WHERE status = 'WATCHING'
          AND asset_symbol = 'SOL'
          AND privy_user_id = ?
        ORDER BY created_at ASC
        `
      : `
        SELECT *
        FROM rebound_strategies
        WHERE status = 'WATCHING'
          AND asset_symbol = 'SOL'
        ORDER BY created_at ASC
        `;

  const result =
    privyUserId
      ? await env.DB
          .prepare(sql)
          .bind(
            privyUserId
          )
          .all()

      : await env.DB
          .prepare(sql)
          .all();

  return Array.isArray(
    result?.results
  )
    ? result.results
    : [];
}


function priceMoveFraction(
  previousRaw,
  nextRaw
) {
  const previous =
    Number(
      previousRaw
    );

  const next =
    Number(
      nextRaw
    );

  if (
    !Number.isFinite(
      previous
    )
    ||
    previous <= 0
    ||
    !Number.isFinite(
      next
    )
    ||
    next <= 0
  ) {
    return 0;
  }

  return (
    Math.abs(
      next -
      previous
    )
    /
    previous
  );
}


async function runPriceWatcher(
  env,
  {
    source = "cron",
    privyUserId = null,
  } = {}
) {
  const strategies =
    await loadWatchingStrategies(
      env,
      privyUserId
    );

  if (
    strategies.length === 0
  ) {
    return {
      ok: true,

      mode:
        "watch-only",

      executionEnabled:
        false,

      source,

      checked:
        0,

      updated:
        0,

      triggered:
        0,

      message:
        "No WATCHING SOL strategies found.",
    };
  }

  let priceInfo =
    await getJupiterSolPriceMicroUsdc(
      env
    );

  let needsConfirmation =
    false;

  for (
    const strategy
    of strategies
  ) {
    if (
      strategy
        .current_price_micro_usdc
      !=
      null
      &&
      priceMoveFraction(
        strategy
          .current_price_micro_usdc,
        priceInfo.micro
      ) > 0.20
    ) {
      needsConfirmation =
        true;

      break;
    }
  }

  let safetyConfirmation =
    null;

  if (
    needsConfirmation
  ) {
    await sleep(
      1200
    );

    const second =
      await getJupiterSolPriceMicroUsdc(
        env
      );

    const betweenChecks =
      priceMoveFraction(
        priceInfo.micro,
        second.micro
      );

    if (
      betweenChecks >
      0.02
    ) {
      throw new Error(
        "Watcher safety check rejected an unstable >20% price move. No strategy state was changed."
      );
    }

    priceInfo =
      second;

    safetyConfirmation =
      "confirmed";
  }

  let updated =
    0;

  let triggered =
    0;

  const current =
    priceInfo.micro;

  for (
    const strategy
    of strategies
  ) {
    const oldHwm =
      strategy
        .hwm_price_micro_usdc
      ==
      null
        ? null
        : BigInt(
            String(
              strategy
                .hwm_price_micro_usdc
            )
          );

    const hwm =
      oldHwm == null
      ||
      current >
      oldHwm
        ? current
        : oldHwm;

    const dipBps =
      BigInt(
        Number(
          strategy.dip_bps
        )
      );

    const trigger =
      hwm *
      (
        10_000n -
        dipBps
      )
      /
      10_000n;

    const shouldTrigger =
      current <=
      trigger;

    let result;

    if (
      shouldTrigger
    ) {
      result =
        await env.DB
          .prepare(
            `
            UPDATE rebound_strategies
            SET
              status = 'BUY_TRIGGERED',
              current_price_micro_usdc = ?,
              hwm_price_micro_usdc = ?,
              buy_trigger_price_micro_usdc = ?,
              buy_triggered_at =
                COALESCE(
                  buy_triggered_at,
                  CURRENT_TIMESTAMP
                ),
              last_price_at =
                CURRENT_TIMESTAMP,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'WATCHING'
            `
          )
          .bind(
            current.toString(),
            hwm.toString(),
            trigger.toString(),
            strategy.id
          )
          .run();
    }
    else {
      result =
        await env.DB
          .prepare(
            `
            UPDATE rebound_strategies
            SET
              current_price_micro_usdc = ?,
              hwm_price_micro_usdc = ?,
              buy_trigger_price_micro_usdc = ?,
              last_price_at =
                CURRENT_TIMESTAMP,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'WATCHING'
            `
          )
          .bind(
            current.toString(),
            hwm.toString(),
            trigger.toString(),
            strategy.id
          )
          .run();
    }

    const changed =
      Number(
        result?.meta?.changes
        ??
        0
      );

    if (
      changed > 0
    ) {
      updated +=
        changed;

      if (
        shouldTrigger
      ) {
        triggered +=
          changed;
      }
    }
  }

  return {
    ok: true,

    mode:
      "watch-only",

    executionEnabled:
      false,

    source,

    checked:
      strategies.length,

    updated,

    triggered,

    currentPriceMicroUsdc:
      current.toString(),

    currentPriceUsd:
      formatMicroUsd(
        current
      ),

    priceSource:
      "Jupiter Price API V3",

    priceBlockId:
      priceInfo.blockId,

    priceChange24h:
      priceInfo.priceChange24h,

    safetyConfirmation,

    checkedAt:
      new Date()
        .toISOString(),
  };
}


/* ==================================================
   ROOT
================================================== */

async function handleRoot(request) {
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

      watcher: {
        mode:
          "watch-only",

        executionEnabled:
          false,

        priceSource:
          "Jupiter Price API V3",
      },

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

        strategyList:
          "GET /strategies",

        strategyCreate:
          "POST /strategies",

        watcherStatus:
          "GET /watcher/status",

        watcherRun:
          "POST /watcher/run",

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

        watcherMode:
          "watch-only",

        executionEnabled:
          false,

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
  }
  catch(error) {
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
            Boolean(privy),
        },
      }
    );
  }
  catch(error) {
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
      body?.reboundWalletId
      ||
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
          .rebound_wallet_id
        &&
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
      }
      else {
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
                .rebound_wallet_id
              ||
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
  }
  catch(error) {
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
      tradingSol,
      reservedRaw
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

        getReservedCapitalRaw(
          env,
          auth.userId
        ),
      ]);

    let solUsd =
      null;

    try {
      solUsd =
        await getSolUsdPrice(
          env
        );
    }
    catch(error) {
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

    const usdcRaw =
      BigInt(
        usdc.raw
      );

    const freeUsdcRaw =
      usdcRaw >
      reservedRaw
        ? usdcRaw -
          reservedRaw
        : 0n;

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

            reservedRaw:
              reservedRaw
                .toString(),

            reservedUi:
              formatUnits(
                reservedRaw,
                USDC_DECIMALS
              ),

            freeRaw:
              freeUsdcRaw
                .toString(),

            freeUi:
              formatUnits(
                freeUsdcRaw,
                USDC_DECIMALS
              ),
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
              )
              &&
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
  }
  catch(error) {
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
        ?.phantom_address
      ||
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
        body?.asset
        ||
        ""
      )
        .toUpperCase();

    const amount =
      String(
        body?.amount
        ||
        ""
      )
        .trim();

    if (
      asset !== "SOL"
      &&
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
        .split(".")[1]
      ||
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
  }
  catch(error) {
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
        .get("signature");

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
        ?.value?.[0]
      ||
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
      status.confirmationStatus
      ||
      null;

    const transactionError =
      status.err
      ||
      null;

    const confirmed =
      !transactionError
      &&
      (
        confirmationStatus ===
          "confirmed"
        ||
        confirmationStatus ===
          "finalized"
      );

    const finalized =
      !transactionError
      &&
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
          status.slot
          ??
          null,
      }
    );
  }
  catch(error) {
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
   GET STRATEGIES
================================================== */

async function handleStrategyList(
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

    const [
      queryResult,
      usdc,
      reservedRaw
    ] =
      await Promise.all([
        env.DB
          .prepare(
            `
            SELECT *
            FROM rebound_strategies
            WHERE privy_user_id = ?
            ORDER BY created_at DESC
            `
          )
          .bind(
            auth.userId
          )
          .all(),

        getUsdcBalance(
          env,
          account
            .rebound_wallet_address
        ),

        getReservedCapitalRaw(
          env,
          auth.userId
        ),
      ]);

    const walletUsdcRaw =
      BigInt(
        usdc.raw
      );

    const freeUsdcRaw =
      walletUsdcRaw >
      reservedRaw
        ? walletUsdcRaw -
          reservedRaw
        : 0n;

    const rows =
      Array.isArray(
        queryResult?.results
      )
        ? queryResult.results
        : [];

    return json(
      request,
      {
        status:
          "ok",

        strategies:
          rows.map(
            normalizeStrategyRow
          ),

        capital: {
          walletUsdcRaw:
            walletUsdcRaw
              .toString(),

          walletUsdc:
            formatUnits(
              walletUsdcRaw,
              USDC_DECIMALS
            ),

          reservedUsdcRaw:
            reservedRaw
              .toString(),

          reservedUsdc:
            formatUnits(
              reservedRaw,
              USDC_DECIMALS
            ),

          freeUsdcRaw:
            freeUsdcRaw
              .toString(),

          freeUsdc:
            formatUnits(
              freeUsdcRaw,
              USDC_DECIMALS
            ),
        },
      }
    );
  }
  catch(error) {
    console.error(
      "Strategy list error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Strategies are temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   CREATE STRATEGY
================================================== */

async function handleStrategyCreate(
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
        ?.phantom_address
      ||
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

    let body =
      {};

    try {
      body =
        await request.json();
    }
    catch {}

    let capitalRaw;
    let config;

    try {
      capitalRaw =
        parseDecimalToRaw(
          body?.capitalUsdc,
          USDC_DECIMALS
        );

      config =
        resolveStrategyConfiguration(
          body
        );
    }
    catch(error) {
      return json(
        request,
        {
          status:
            "error",

          message:
            error.message,
        },
        400
      );
    }

    if (
      capitalRaw <
      MIN_STRATEGY_USDC_RAW
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "A new strategy requires at least 25 USDC.",
        },
        400
      );
    }

    const [
      usdc,
      asty,
      reservedRaw
    ] =
      await Promise.all([
        getUsdcBalance(
          env,
          account
            .rebound_wallet_address
        ),

        getAstyBalance(
          env,
          account
            .phantom_address
        ),

        getReservedCapitalRaw(
          env,
          auth.userId
        ),
      ]);

    const walletUsdcRaw =
      BigInt(
        usdc.raw
      );

    const astyRaw =
      BigInt(
        asty.raw
      );

    const freeUsdcRaw =
      walletUsdcRaw >
      reservedRaw
        ? walletUsdcRaw -
          reservedRaw
        : 0n;

    if (
      astyRaw <
      ASTY_GATE_RAW
    ) {
      return json(
        request,
        {
          status:
            "error",

          code:
            "ASTY_GATE_NOT_MET",

          message:
            "At least 2,500 ASTY must be held in the linked Phantom wallet when creating a new strategy.",

          gate: {
            requiredAstyRaw:
              ASTY_GATE_RAW
                .toString(),

            requiredAsty:
              formatUnits(
                ASTY_GATE_RAW,
                ASTY_DECIMALS
              ),

            currentAstyRaw:
              astyRaw
                .toString(),

            currentAsty:
              formatUnits(
                astyRaw,
                ASTY_DECIMALS
              ),
          },
        },
        409
      );
    }

    if (
      freeUsdcRaw <
      capitalRaw
    ) {
      return json(
        request,
        {
          status:
            "error",

          code:
            "INSUFFICIENT_FREE_USDC",

          message:
            "Not enough free USDC is available for this strategy.",

          capital: {
            requestedUsdcRaw:
              capitalRaw
                .toString(),

            requestedUsdc:
              formatUnits(
                capitalRaw,
                USDC_DECIMALS
              ),

            walletUsdcRaw:
              walletUsdcRaw
                .toString(),

            walletUsdc:
              formatUnits(
                walletUsdcRaw,
                USDC_DECIMALS
              ),

            reservedUsdcRaw:
              reservedRaw
                .toString(),

            reservedUsdc:
              formatUnits(
                reservedRaw,
                USDC_DECIMALS
              ),

            freeUsdcRaw:
              freeUsdcRaw
                .toString(),

            freeUsdc:
              formatUnits(
                freeUsdcRaw,
                USDC_DECIMALS
              ),
          },
        },
        409
      );
    }

    const id =
      crypto.randomUUID();

    await env.DB
      .prepare(
        `
        INSERT INTO rebound_strategies (
          id,
          privy_user_id,
          phantom_address,
          rebound_wallet_address,
          asset_symbol,
          status,
          preset,
          dip_bps,
          take_profit_bps,
          stop_loss_enabled,
          stop_loss_bps,
          auto_repeat,
          compound,
          initial_capital_usdc_raw,
          reserved_capital_usdc_raw,
          current_cycle_capital_usdc_raw,
          free_profit_usdc_raw,
          cycle_number,
          asty_gate_checked_at,
          asty_balance_raw_at_creation,
          created_at,
          updated_at
        )
        VALUES (
          ?, ?, ?, ?,
          'SOL',
          'WATCHING',
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          0,
          1,
          CURRENT_TIMESTAMP,
          ?,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        `
      )
      .bind(
        id,
        auth.userId,
        account.phantom_address,
        account.rebound_wallet_address,
        config.preset,
        config.dipBps,
        config.takeProfitBps,
        config.stopLossEnabled
          ? 1
          : 0,
        config.stopLossBps,
        config.autoRepeat
          ? 1
          : 0,
        config.compound
          ? 1
          : 0,
        capitalRaw
          .toString(),
        capitalRaw
          .toString(),
        capitalRaw
          .toString(),
        astyRaw
          .toString()
      )
      .run();

    const row =
      await env.DB
        .prepare(
          `
          SELECT *
          FROM rebound_strategies
          WHERE id = ?
            AND privy_user_id = ?
          LIMIT 1
          `
        )
        .bind(
          id,
          auth.userId
        )
        .first();

    return json(
      request,
      {
        status:
          "ok",

        created:
          true,

        tradingActive:
          false,

        message:
          "Strategy created in WATCHING mode. Automatic execution is not enabled yet.",

        strategy:
          normalizeStrategyRow(
            row
          ),

        gate: {
          checked:
            true,

          requiredAstyRaw:
            ASTY_GATE_RAW
              .toString(),

          currentAstyRaw:
            astyRaw
              .toString(),
        },
      },
      201
    );
  }
  catch(error) {
    console.error(
      "Strategy create error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "The strategy could not be created.",
      },
      503
    );
  }
}


/* ==================================================
   WATCHER STATUS
================================================== */

async function handleWatcherStatus(
  request,
  env
) {
  try {
    const counts =
      await env.DB
        .prepare(
          `
          SELECT
            status,
            COUNT(*) AS count
          FROM rebound_strategies
          WHERE asset_symbol = 'SOL'
          GROUP BY status
          `
        )
        .all();

    const latest =
      await env.DB
        .prepare(
          `
          SELECT
            current_price_micro_usdc,
            hwm_price_micro_usdc,
            buy_trigger_price_micro_usdc,
            last_price_at
          FROM rebound_strategies
          WHERE asset_symbol = 'SOL'
            AND last_price_at IS NOT NULL
          ORDER BY last_price_at DESC
          LIMIT 1
          `
        )
        .first();

    const byStatus =
      {};

    for (
      const row
      of counts?.results
      ||
      []
    ) {
      byStatus[
        row.status
      ] =
        Number(
          row.count
          ||
          0
        );
    }

    return json(
      request,
      {
        status:
          "ok",

        mode:
          "watch-only",

        executionEnabled:
          false,

        priceSource:
          "Jupiter Price API V3",

        strategies: {
          watching:
            byStatus.WATCHING
            ||
            0,

          buyTriggered:
            byStatus.BUY_TRIGGERED
            ||
            0,

          bought:
            byStatus.BOUGHT
            ||
            0,

          sellTriggered:
            byStatus.SELL_TRIGGERED
            ||
            0,

          paused:
            byStatus.PAUSED
            ||
            0,

          stopped:
            byStatus.STOPPED
            ||
            0,
        },

        latest:
          latest
            ? {
                currentPriceMicroUsdc:
                  latest
                    .current_price_micro_usdc
                  ==
                  null
                    ? null
                    : String(
                        latest
                          .current_price_micro_usdc
                      ),

                currentPriceUsd:
                  formatMicroUsd(
                    latest
                      .current_price_micro_usdc
                  ),

                hwmPriceUsd:
                  formatMicroUsd(
                    latest
                      .hwm_price_micro_usdc
                  ),

                buyTriggerPriceUsd:
                  formatMicroUsd(
                    latest
                      .buy_trigger_price_micro_usdc
                  ),

                lastPriceAt:
                  latest
                    .last_price_at,
              }
            : null,
      }
    );
  }
  catch(error) {
    console.error(
      "Watcher status error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          "Watcher status is temporarily unavailable.",
      },
      503
    );
  }
}


/* ==================================================
   MANUAL WATCHER RUN
================================================== */

async function handleWatcherRun(
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

    const result =
      await runPriceWatcher(
        env,
        {
          source:
            "manual",

          privyUserId:
            auth.userId,
        }
      );

    return json(
      request,
      {
        status:
          "ok",

        ...result,
      }
    );
  }
  catch(error) {
    console.error(
      "Manual watcher run error:",
      error
    );

    return json(
      request,
      {
        status:
          "error",

        message:
          error?.message
          ||
          "Watcher run failed.",
      },
      503
    );
  }
}


/* ==================================================
   TRADING AUTH CONFIG
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
      !env.PRIVY_AUTH_KEY_ID
      ||
      !env.PRIVY_AUTH_PRIVATE_KEY
      ||
      !env.PRIVY_POLICY_ID
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
          env.PRIVY_AUTH_KEY_ID,

        policyId:
          env.PRIVY_POLICY_ID,

        policyProtected:
          true,
      }
    );
  }
  catch(error) {
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
        ?.phantom_address
      ||
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
  }
  catch(error) {
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
   SERVER SIGNER TEST
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
        .rebound_wallet_id
      ||
      delegatedWallet?.id
      ||
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
    }
    catch(error) {
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
  }
  catch(error) {
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
   REAL TEST SWAP
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
    }
    catch {}

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
      tradingSol,
      reservedRaw
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

        getReservedCapitalRaw(
          env,
          auth.userId
        ),
      ]);

    const walletUsdcRaw =
      BigInt(
        usdc.raw
      );

    const freeUsdcRaw =
      walletUsdcRaw >
      reservedRaw
        ? walletUsdcRaw -
          reservedRaw
        : 0n;

    if (
      freeUsdcRaw <
      TEST_SWAP_USDC_RAW
    ) {
      return json(
        request,
        {
          status:
            "error",

          message:
            "At least 0.10 free USDC is required for the test swap.",
        },
        409
      );
    }

    if (
      BigInt(
        nativeSol.raw
      )
      <
      100_000n
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
      !tradingSol.ready
      ||
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
        .rebound_wallet_id
      ||
      delegatedWallet?.id
      ||
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
      !quote
      ||
      quote.inputMint !==
        USDC_MINT
      ||
      quote.outputMint !==
        WSOL_MINT
      ||
      String(
        quote.inAmount
      ) !==
        TEST_SWAP_USDC_RAW
          .toString()
      ||
      !Array.isArray(
        quote.routePlan
      )
      ||
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
      )
      &&
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

    if (
      !env.JUPITER_API_KEY
    ) {
      await sleep(
        2100
      );
    }

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
          !allowed.has(id)
      );

    const hasSetup =
      Array.isArray(
        plan?.setupInstructions
      )
      &&
      plan
        .setupInstructions
        .length >
        0;

    const hasCleanup =
      Boolean(
        plan
          ?.cleanupInstruction
      );

    const hasOther =
      Array.isArray(
        plan?.otherInstructions
      )
      &&
      plan
        .otherInstructions
        .length >
        0;

    const hasTokenLedger =
      Boolean(
        plan
          ?.tokenLedgerInstruction
      );

    if (
      unexpectedPrograms.length
      ||
      hasSetup
      ||
      hasCleanup
      ||
      hasOther
      ||
      hasTokenLedger
      ||
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
      !env.JUPITER_API_KEY
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
        "string"
      ||
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
    }
    catch(error) {
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
      !signature
      ||
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
            quote.outAmount
            ||
            ""
          ),

        slippageBps:
          TEST_SWAP_SLIPPAGE_BPS,

        priceImpactPct:
          quote.priceImpactPct
          ??
          null,

        signature,
      }
    );
  }
  catch(error) {
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
          error?.message
          ||
          "The test swap could not be completed.",
      },
      503
    );
  }
}


/* ==================================================
   ROUTER
================================================== */

async function routeFetch(
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

  switch(key) {
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

    case "GET /strategies":
      return handleStrategyList(
        request,
        env
      );

    case "POST /strategies":
      return handleStrategyCreate(
        request,
        env
      );

    case "GET /watcher/status":
      return handleWatcherStatus(
        request,
        env
      );

    case "POST /watcher/run":
      return handleWatcherRun(
        request,
        env
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
}


/* ==================================================
   WORKER
================================================== */

export default {

  async fetch(
    request,
    env
  ) {
    return routeFetch(
      request,
      env
    );
  },


  async scheduled(
    controller,
    env
  ) {
    const result =
      await runPriceWatcher(
        env,
        {
          source:
            `cron:${controller.cron || "scheduled"}`,
        }
      );

    console.log(
      "ASTY Rebound watcher result:",
      JSON.stringify(
        result
      )
    );
  },
};
