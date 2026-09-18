// ASTY Rebound API - Account Sync v1

import { PrivyClient } from "@privy-io/node";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Content-Type, Authorization";
  }

  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders(request),
  });
}

function createPrivyClient(env) {
  return new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  });
}

function isSolanaAddress(value) {
  return (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
  );
}

function getBearerToken(request) {
  const auth =
    request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7).trim();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const url = new URL(request.url);

    // --------------------------------------------------
    // HEALTH
    // --------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      try {
        const dbTest = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        return json(request, {
          status: "ok",
          service: "ASTY Rebound API",
          database:
            dbTest?.ok === 1
              ? "connected"
              : "error",

          config: {
            privyAppId:
              Boolean(env.PRIVY_APP_ID),

            privyAppSecret:
              Boolean(env.PRIVY_APP_SECRET),

            privyAuthorizationKeyId:
              Boolean(env.PRIVY_AUTH_KEY_ID),

            privyAuthorizationPrivateKey:
              Boolean(
                env.PRIVY_AUTH_PRIVATE_KEY
              ),

            privyPolicyId:
              Boolean(env.PRIVY_POLICY_ID),
          },
        });
      } catch (error) {
        return json(
          request,
          {
            status: "error",
            service: "ASTY Rebound API",
            message:
              "Backend health check failed.",
          },
          500
        );
      }
    }

    // --------------------------------------------------
    // PRIVY TEST
    // --------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/privy-test"
    ) {
      try {
        const privy =
          createPrivyClient(env);

        return json(request, {
          status: "ok",
          service: "ASTY Rebound API",

          privy: {
            sdkLoaded: true,

            clientInitialized:
              Boolean(privy),

            usersApiAvailable:
              typeof privy.users ===
              "function",

            walletsApiAvailable:
              typeof privy.wallets ===
              "function",
          },
        });
      } catch (error) {
        return json(
          request,
          {
            status: "error",
            service: "ASTY Rebound API",
            message:
              "Privy SDK initialization failed.",
          },
          500
        );
      }
    }

    // --------------------------------------------------
    // ACCOUNT SYNC
    // --------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/account/sync"
    ) {
      try {
        /*
         * 1. Require a real Privy access token.
         */

        const accessToken =
          getBearerToken(request);

        if (!accessToken) {
          return json(
            request,
            {
              status: "error",
              message:
                "Missing authentication token.",
            },
            401
          );
        }

        /*
         * 2. Verify the token server-side.
         */

        const privy =
          createPrivyClient(env);

        let claims;

        try {
          claims =
            await privy
              .utils()
              .auth()
              .verifyAccessToken(
                accessToken
              );
        } catch (error) {
          return json(
            request,
            {
              status: "error",
              message:
                "Invalid or expired Privy session.",
            },
            401
          );
        }

        const privyUserId =
          claims?.user_id;

        if (!privyUserId) {
          return json(
            request,
            {
              status: "error",
              message:
                "Privy user ID could not be verified.",
            },
            401
          );
        }

        /*
         * 3. Read the wallet data produced
         *    by our authenticated frontend.
         */

        const body =
          await request.json();

        const phantomAddress =
          body?.phantomAddress;

        const reboundWalletAddress =
          body?.reboundWalletAddress;

        const reboundWalletId =
          body?.reboundWalletId || null;

        if (
          !isSolanaAddress(
            phantomAddress
          )
        ) {
          return json(
            request,
            {
              status: "error",
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
              status: "error",
              message:
                "Invalid Rebound wallet address.",
            },
            400
          );
        }

        /*
         * Phantom and Rebound wallet must
         * never accidentally be identical.
         */

        if (
          phantomAddress ===
          reboundWalletAddress
        ) {
          return json(
            request,
            {
              status: "error",
              message:
                "Phantom and Rebound wallet cannot be identical.",
            },
            400
          );
        }

        /*
         * 4. Has this Privy user already
         *    been registered?
         */

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
            .bind(privyUserId)
            .first();

        /*
         * The initial wallet mapping is
         * permanent.
         *
         * No wallet switching.
         */

        if (existing) {
          if (
            existing.phantom_address !==
            phantomAddress
          ) {
            return json(
              request,
              {
                status: "error",
                message:
                  "This Rebound account is already linked to another Phantom wallet.",
              },
              409
            );
          }

          if (
            existing.rebound_wallet_address !==
            reboundWalletAddress
          ) {
            return json(
              request,
              {
                status: "error",
                message:
                  "A different Rebound wallet is already registered for this account.",
              },
              409
            );
          }

          /*
           * Same account, same wallets:
           * simply refresh updated_at.
           */

          await env.DB
            .prepare(
              `
              UPDATE rebound_users
              SET updated_at =
                CURRENT_TIMESTAMP
              WHERE privy_user_id = ?
              `
            )
            .bind(privyUserId)
            .run();

          return json(request, {
            status: "ok",
            synced: true,
            existing: true,

            account: {
              phantomAddress:
                existing.phantom_address,

              privyUserId:
                existing.privy_user_id,

              reboundWalletId:
                existing.rebound_wallet_id,

              reboundWalletAddress:
                existing.rebound_wallet_address,
            },
          });
        }

        /*
         * 5. Prevent the Phantom address
         *    from being linked to some
         *    other Privy account.
         */

        const existingPhantom =
          await env.DB
            .prepare(
              `
              SELECT privy_user_id
              FROM rebound_users
              WHERE phantom_address = ?
              LIMIT 1
              `
            )
            .bind(phantomAddress)
            .first();

        if (existingPhantom) {
          return json(
            request,
            {
              status: "error",
              message:
                "This Phantom wallet is already registered with ASTY Rebound.",
            },
            409
          );
        }

        /*
         * 6. Store the permanent mapping.
         */

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
            status: "ok",
            synced: true,
            existing: false,

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
            status: "error",
            message:
              "Account synchronization failed.",
          },
          500
        );
      }
    }

    // --------------------------------------------------
    // ROOT
    // --------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return json(request, {
        service: "ASTY Rebound API",
        status: "online",

        endpoints: {
          health: "/health",
          privyTest: "/privy-test",
          accountSync:
            "POST /account/sync",
        },
      });
    }

    return json(
      request,
      {
        status: "error",
        message: "Not found",
      },
      404
    );
  },
};
