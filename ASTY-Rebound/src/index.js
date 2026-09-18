// ASTY Rebound API - Balance v1

import { PrivyClient } from "@privy-io/node";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

const SOLANA_RPC_URL =
  "https://api.mainnet-beta.solana.com";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;


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

    headers["Vary"] =
      "Origin";

    headers[
      "Access-Control-Allow-Methods"
    ] = "GET,POST,OPTIONS";

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
      "string" &&

    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
      .test(value)
  );
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
    getBearerToken(request);

  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      message:
        "Missing authentication token.",
    };
  }

  const privy =
    createPrivyClient(env);

  try {
    /*
     * Keep the same Privy verification
     * flow already working for
     * /account/sync.
     */
    const claims =
      await privy
        .utils()
        .auth()
        .verifyAccessToken(
          accessToken
        );

    const userId =
      claims?.user_id;

    if (!userId) {
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
SOLANA RPC
====================================================
*/

async function solanaRpc(
  method,
  params
) {
  const response =
    await fetch(
      SOLANA_RPC_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `Solana RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data?.error) {
    throw new Error(
      data.error?.message ||
      "Solana RPC returned an error."
    );
  }

  return data?.result;
}


/*
====================================================
TOKEN / UNIT HELPERS
====================================================
*/

function formatUnits(
  rawValue,
  decimals
) {
  const raw =
    typeof rawValue === "bigint"
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


async function getSolBalance(
  walletAddress
) {
  const result =
    await solanaRpc(
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


async function getUsdcBalance(
  walletAddress
) {
  const result =
    await solanaRpc(
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

  const tokenAccounts =
    Array.isArray(
      result?.value
    )
      ? result.value
      : [];

  /*
   * A wallet can technically own
   * more than one token account
   * for the same mint.
   *
   * Sum all matching USDC accounts.
   */
  let totalRaw =
    0n;

  for (
    const tokenAccount
    of tokenAccounts
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

    tokenAccounts:
      tokenAccounts.length,
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
    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
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
    HEALTH
    ==================================================
    */

    if (
      request.method ===
        "GET" &&

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
            status: "ok",

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
            },
          }
        );
      } catch (error) {
        console.error(
          error
        );

        return json(
          request,
          {
            status:
              "error",

            service:
              "ASTY Rebound API",

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
        "GET" &&

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
            status: "ok",

            service:
              "ASTY Rebound API",

            privy: {
              sdkLoaded:
                true,

              clientInitialized:
                Boolean(
                  privy
                ),

              usersApiAvailable:
                typeof privy.users ===
                "function",

              walletsApiAvailable:
                typeof privy.wallets ===
                "function",
            },
          }
        );
      } catch (error) {
        console.error(
          error
        );

        return json(
          request,
          {
            status:
              "error",

            service:
              "ASTY Rebound API",

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
        "POST" &&

      url.pathname ===
        "/account/sync"
    ) {
      try {
        const auth =
          await verifyPrivyRequest(
            request,
            env
          );

        if (!auth.ok) {
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
          await env.DB
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


        if (existing) {
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


          await env.DB
            .prepare(
              `
              UPDATE rebound_users
              SET
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE
                privy_user_id = ?
              `
            )
            .bind(
              privyUserId
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
                    .rebound_wallet_id,

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
              FROM
                rebound_users
              WHERE
                phantom_address = ?
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
            INSERT INTO
              rebound_users (
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
        "GET" &&

      url.pathname ===
        "/account/balance"
    ) {
      try {
        /*
         * 1. Verify the logged-in
         * Privy user.
         */

        const auth =
          await verifyPrivyRequest(
            request,
            env
          );


        if (!auth.ok) {
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


        /*
         * 2. Get this user's permanent
         * Rebound wallet from D1.
         *
         * We deliberately do NOT accept
         * a wallet address from the browser.
         */

        const account =
          await env.DB
            .prepare(
              `
              SELECT
                phantom_address,
                rebound_wallet_address
              FROM
                rebound_users
              WHERE
                privy_user_id = ?
              LIMIT 1
              `
            )
            .bind(
              auth.userId
            )
            .first();


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


        if (
          !isSolanaAddress(
            walletAddress
          )
        ) {
          return json(
            request,
            {
              status:
                "error",

              message:
                "Stored Rebound wallet is invalid.",
            },
            500
          );
        }


        /*
         * 3. Read SOL and USDC
         * concurrently.
         */

        const [
          solBalance,
          usdcBalance
        ] =
          await Promise.all([
            getSolBalance(
              walletAddress
            ),

            getUsdcBalance(
              walletAddress
            ),
          ]);


        /*
         * 4. Return read-only
         * on-chain balances.
         */

        return json(
          request,
          {
            status:
              "ok",

            wallet:
              walletAddress,

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
              },

              sol: {
                decimals:
                  SOL_DECIMALS,

                lamports:
                  solBalance.raw,

                ui:
                  solBalance.ui,
              },
            },

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
              "Rebound balance is currently unavailable.",
          },
          503
        );
      }
    }


    /*
    ==================================================
    ROOT
    ==================================================
    */

    if (
      request.method ===
        "GET" &&

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

          endpoints: {
            health:
              "/health",

            privyTest:
              "/privy-test",

            accountSync:
              "POST /account/sync",

            accountBalance:
              "GET /account/balance",
          },
        }
      );
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
