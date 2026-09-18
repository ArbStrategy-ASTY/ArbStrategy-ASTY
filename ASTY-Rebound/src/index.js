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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const dbTest = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        return json(request, {
          status: "ok",
          service: "ASTY Rebound API",
          database: dbTest?.ok === 1 ? "connected" : "error",

          config: {
            privyAppId: Boolean(env.PRIVY_APP_ID),
            privyAppSecret: Boolean(env.PRIVY_APP_SECRET),
            privyAuthorizationKeyId: Boolean(
              env.PRIVY_AUTH_KEY_ID
            ),
            privyAuthorizationPrivateKey: Boolean(
              env.PRIVY_AUTH_PRIVATE_KEY
            ),
            privyPolicyId: Boolean(env.PRIVY_POLICY_ID),
          },
        });
      } catch (error) {
        return json(
          request,
          {
            status: "error",
            service: "ASTY Rebound API",
            message: "Backend health check failed.",
          },
          500
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json(request, {
        service: "ASTY Rebound API",
        status: "online",
        health: "/health",
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
