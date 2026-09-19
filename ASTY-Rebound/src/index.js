// ASTY Rebound API - Balance + USD + Automated Trading Authorization
// + Safe Server Signer Security Test

import { PrivyClient } from "@privy-io/node";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

const HELIUS_RPC_BASE =
  "https://mainnet.helius-rpc.com/";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;


/*
====================================================
SHORT-LIVED PRICE CACHE

Only used for UI dollar estimates.
Never for trading decisions.
====================================================
*/

let solPriceCache = {
  price: null,
  expiresAt: 0,
};


/*
====================================================
BASIC HELPERS
====================================================
*/

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


function utf8ToBase64(value) {

  const bytes =
    new TextEncoder().encode(
      String(value)
    );


  let binary =
    "";


  for (
    let index = 0;
    index < bytes.length;
    index++
  ) {

    binary +=
      String.fromCharCode(
        bytes[index]
      );

  }


  return btoa(binary);
}


function getSafePrivyError(error) {

  const status =

    Number.isFinite(
      Number(
        error?.status
      )
    )

    ?

    Number(
      error.status
    )

    :

    null;


  const name =

    typeof error?.name ===
      "string"

    ?

    error.name

    :

    null;


  const code =

    error?.code

    ??

    error?.error?.code

    ??

    error?.body?.error?.code

    ??

    null;


  const message =

    typeof error?.message ===
      "string"

    ?

    error.message

    :

    "Privy request failed.";


  return {

    status,

    name,

    code:

      code === null ||
      code === undefined

      ?

      null

      :

      String(code),

    message:
      message.slice(
        0,
        300
      ),

  };
}


function looksLikePolicyDenial(
  errorInfo
) {

  const text =

    [
      errorInfo?.name,
      errorInfo?.code,
      errorInfo?.message,
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


function getBearerToken(request) {

  const auth =
    request.headers.get(
      "Authorization"
    ) || "";


  if (
    !auth.startsWith(
      "Bearer "
    )
  ) {

    return null;

  }


  return auth
    .slice(7)
    .trim();
}


function isSolanaAddress(value) {

  return (

    typeof value ===
      "string"

    &&

    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
      .test(value)

  );
}


function isTransactionSignature(
  value
) {

  return (

    typeof value ===
      "string"

    &&

    /^[1-9A-HJ-NP-Za-km-z]{80,100}$/
      .test(value)

  );
}


function isPositiveAmount(value) {

  if (
    typeof value !==
      "string"

    &&

    typeof value !==
      "number"
  ) {

    return false;

  }


  const text =
    String(value)
      .trim();


  if (
    !/^\d+(\.\d+)?$/
      .test(text)
  ) {

    return false;

  }


  const number =
    Number(text);


  return (

    Number.isFinite(number)

    &&

    number > 0

  );
}


function formatUnits(
  rawValue,
  decimals
) {

  const raw =

    typeof rawValue ===
      "bigint"

    ?

    rawValue

    :

    BigInt(rawValue);


  const negative =
    raw < 0n;


  const absolute =

    negative

    ?

    -raw

    :

    raw;


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


/*
====================================================
PRIVY AUTH
====================================================
*/

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

    const privy =
      createPrivyClient(
        env
      );


    const claims =

      await privy
        .utils()
        .auth()
        .verifyAccessToken(
          accessToken
        );


    const userId =
      claims?.user_id;


    if (
      !userId
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

      userId,

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


/*
====================================================
D1 ACCOUNT
====================================================
*/

async function getReboundAccount(
  env,
  privyUserId
) {

  return await env.DB
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


/*
====================================================
HELIUS
====================================================
*/

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

          "Accept":
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


/*
====================================================
SOL BALANCE
====================================================
*/

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
      result?.value ?? 0
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


/*
====================================================
USDC BALANCE - HELIUS DAS
====================================================
*/

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

    ?

    result.token_accounts

    :

    [];


  let totalRaw =
    0n;


  for (
    const account
    of accounts
  ) {

    const amount =
      account?.amount;


    if (
      amount !== undefined &&
      amount !== null
    ) {

      totalRaw +=
        BigInt(
          String(amount)
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


/*
====================================================
USDC BALANCE - STANDARD RPC FALLBACK
====================================================
*/

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

    ?

    result.value

    :

    [];


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


    return await getUsdcViaStandardRpc(
      env,
      walletAddress
    );

  }
}


/*
====================================================
SOL USD PRICE

Display only.

Never use this value for
strategy triggers or trade execution.
====================================================
*/

async function getSolUsdPrice(
  env
) {

  const now =
    Date.now();


  if (

    solPriceCache.price !==
      null

    &&

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

    !Number.isFinite(price)

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

      now

      +

      60 * 1000,

  };


  return price;
}


/*
====================================================
LATEST BLOCKHASH
====================================================
*/

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
    result?.value?.blockhash;


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


/*
====================================================
WORKER
====================================================
*/

export default {

  async fetch(
    request,
    env
  ) {


    /*
    ==================================================
    CORS
    ==================================================
    */

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


    /*
    ==================================================
    ROOT
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/"

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

            serverSignerTest:
              "POST /trading/server-signer-test",

          },

        }

      );

    }


    /*
    ==================================================
    HEALTH
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/health"

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

              ?

              "connected"

              :

              "error",


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


    /*
    ==================================================
    PRIVY TEST
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/privy-test"

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


    /*
    ==================================================
    ACCOUNT SYNC
    ==================================================
    */

    if (

      request.method ===
        "POST"

      &&

      url.pathname ===
        "/account/sync"

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


        const privyUserId =
          auth.userId;


        const body =
          await request.json();


        const phantomAddress =
          body?.phantomAddress;


        const reboundWalletAddress =
          body?.reboundWalletAddress;


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

            privyUserId

          );


        if (
          existing
        ) {


          if (

            existing
              .phantom_address

            !==

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
              .rebound_wallet_address

            !==

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
                privyUserId
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
                privyUserId
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

            privyUserId,

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

              privyUserId,

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


    /*
    ==================================================
    REBOUND BALANCE
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/account/balance"

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


        const walletAddress =

          account
            .rebound_wallet_address;


        const [

          solBalance,

          usdcBalance

        ] =

          await Promise.all([


            getSolBalance(

              env,

              walletAddress

            ),


            getUsdcBalance(

              env,

              walletAddress

            ),

          ]);


        let solUsdPrice =
          null;


        try {


          solUsdPrice =

            await getSolUsdPrice(
              env
            );


        } catch (priceError) {


          console.error(
            "SOL display price unavailable:",
            priceError
          );

        }


        const solAmount =

          Number(
            solBalance.ui
          );


        const usdcAmount =

          Number(
            usdcBalance.ui
          );


        const solUsdValue =

          Number.isFinite(
            solAmount
          )

          &&

          Number.isFinite(
            solUsdPrice
          )

          ?

          solAmount *
          solUsdPrice

          :

          null;


        const usdcUsdValue =

          Number.isFinite(
            usdcAmount
          )

          ?

          usdcAmount

          :

          null;


        return json(

          request,

          {

            status:
              "ok",

            wallet:
              walletAddress,

            source:
              "helius",


            balances: {


              usdc: {

                mint:
                  USDC_MINT,

                decimals:
                  USDC_DECIMALS,

                raw:
                  usdcBalance.raw,

                ui:
                  usdcBalance.ui,

                usdValue:
                  usdcUsdValue,

              },


              sol: {

                decimals:
                  SOL_DECIMALS,

                lamports:
                  solBalance.raw,

                ui:
                  solBalance.ui,

                usdValue:
                  solUsdValue,

              },

            },


            prices: {

              solUsd:
                solUsdPrice,

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


    /*
    ==================================================
    DEPOSIT CONTEXT
    ==================================================
    */

    if (

      request.method ===
        "POST"

      &&

      url.pathname ===
        "/deposit/context"

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

          ||

          !account
            .phantom_address

          ||

          !account
            .rebound_wallet_address

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
            body?.asset || ""
          )

          .toUpperCase();


        const amount =

          String(
            body?.amount || ""
          )

          .trim();


        if (

          asset !==
            "SOL"

          &&

          asset !==
            "USDC"

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


        const decimalPart =

          amount
            .split(".")[1]

          ||

          "";


        const maxDecimals =

          asset ===
            "USDC"

          ?

          USDC_DECIMALS

          :

          SOL_DECIMALS;


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


    /*
    ==================================================
    TRANSACTION STATUS
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/transaction/status"

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

          url.searchParams.get(
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


        const transactionStatus =

          result?.value?.[0]

          ||

          null;


        if (
          !transactionStatus
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

          transactionStatus
            .confirmationStatus

          ||

          null;


        const transactionError =

          transactionStatus
            .err

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

              transactionStatus
                .slot

              ??

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


    /*
    ==================================================
    AUTOMATED TRADING AUTHORIZATION CONFIG
    ==================================================
    */

    if (

      request.method ===
        "GET"

      &&

      url.pathname ===
        "/trading/authorization-config"

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

          ||

          !account
            .rebound_wallet_address

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


    /*
    ==================================================
    SERVER SIGNER SECURITY TEST

    No blockchain transaction is sent.

    The Worker asks Privy to sign a harmless message
    from the user's Rebound Wallet using the server
    authorization key.

    Our current Jupiter-only Trading Policy should
    reject signMessage. That is the expected result.
    ==================================================
    */

    if (

      request.method ===
        "POST"

      &&

      url.pathname ===
        "/trading/server-signer-test"

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

          ||

          !account
            .rebound_wallet_address

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
                "Automated trading is not fully configured.",

            },

            503

          );

        }


        const privy =
          createPrivyClient(
            env
          );


        /*
         * Verify from Privy's server-side user object
         * that this exact Rebound Wallet is delegated.
         */

        const privyUser =

          await privy
            .users()
            ._get(
              auth.userId
            );


        const linkedAccounts =

          Array.isArray(
            privyUser?.linked_accounts
          )

          ?

          privyUser.linked_accounts

          :

          Array.isArray(
            privyUser?.linkedAccounts
          )

          ?

          privyUser.linkedAccounts

          :

          [];


        const delegatedWallet =

          linkedAccounts.find(

            item =>

              item?.type ===
                "wallet"

              &&

              item?.address ===
                account
                  .rebound_wallet_address

              &&

              item?.delegated ===
                true

          )

          ||

          null;


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


        const authorizationContext =

          createAuthorizationContext(
            env
          );


        const testMessage =

          [

            "ASTY Rebound server signer security test",

            account
              .rebound_wallet_address,

            new Date()
              .toISOString(),

          ]

            .join(
              " | "
            );


        const base64Message =

          utf8ToBase64(
            testMessage
          );


        try {


          /*
           * No transaction.
           * No asset movement.
           * No SOL network fee.
           *
           * This request SHOULD be denied by our
           * Trading Policy because signMessage is
           * intentionally not allowed.
           */

          await privy

            .wallets()

            .solana()

            .signMessage(

              walletId,

              {

                message:
                  base64Message,

                authorization_context:
                  authorizationContext,

              }

            );


          /*
           * If this succeeds, the signer works,
           * but the policy is wider than intended.
           */

          return json(

            request,

            {

              status:
                "warning",

              serverReady:
                true,

              delegated:
                true,

              authorizationRequestReachedPrivy:
                true,

              policyProtected:
                false,

              result:
                "unexpectedly_allowed",

              message:
                "Server signing works, but signMessage was unexpectedly allowed. Review the ASTY Rebound Trading Policy before enabling real trading.",

            },

            409

          );


        } catch (signError) {


          const errorInfo =

            getSafePrivyError(
              signError
            );


          const policyDenied =

            looksLikePolicyDenial(
              errorInfo
            );


          if (
            policyDenied
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
                  errorInfo,

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
                errorInfo,

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


    /*
    ==================================================
    404
    ==================================================
    */

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

  },
};
