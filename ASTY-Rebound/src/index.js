import { PrivyClient } from "@privy-io/node";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const ALLOWED_ORIGINS = new Set([
  "https://arbstrategy.net",
  "https://www.arbstrategy.net",
]);

const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com/";
const JUPITER_SWAP_BASE = "https://api.jup.ag/swap/v1"; // proven legacy test-swap path; keep frozen for now
const JUPITER_SWAP_V2_BUILD_URL = "https://api.jup.ag/swap/v2/build";
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";

const ASTY_MINT = "ASTYqeaoK83Zs1pTFEXZUB6BM8cG8YLTsN852NUkt7ZR";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const ASTY_DECIMALS = 9;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const PRICE_MICRO_DECIMALS = 6;

const MIN_STRATEGY_USDC_RAW = 25_000_000n;
const ASTY_GATE_RAW = 2_500n * 10n ** 9n;
const TEST_SWAP_USDC_RAW = 100_000n;
const TEST_SWAP_SLIPPAGE_BPS = 50;
const EXECUTION_SLIPPAGE_BPS = 50;
const MIN_GAS_LAMPORTS = 5_000_000n;
const RECOMMENDED_GAS_LAMPORTS = 20_000_000n;
const MAX_ROUTE_REFERENCE_SHORTFALL_BPS = 200;
const MAX_BUY_TRIGGER_OVERAGE_BPS = 50;
const EXECUTION_LOCK_STALE_MINUTES = 5;
const MAX_BUY_EXECUTIONS_PER_CRON = 3;
const MAX_SELL_EXECUTIONS_PER_CRON = 3;
const MAX_TP_QUOTE_UNDERAGE_BPS = 50;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

// These statuses still hold their reserved strategy capital as USDC in the wallet.
// BOUGHT / SELL_TRIGGERED are deployed into the asset and must not be subtracted
// a second time when calculating free on-chain USDC.
const USDC_HELD_STRATEGY_STATUSES = [
  "WATCHING",
  "BUY_TRIGGERED",
  "PAUSED",
];

const PRESETS = Object.freeze({
  frequent: { dipBps: 300, takeProfitBps: 250 },
  balanced: { dipBps: 500, takeProfitBps: 400 },
  deep_dip: { dipBps: 800, takeProfitBps: 600 },
});

const ACTIVE_STRATEGY_STATUSES = [
  "WATCHING",
  "BUY_TRIGGERED",
  "BOUGHT",
  "SELL_TRIGGERED",
  "PAUSED",
];

let solPriceCache = { price: null, expiresAt: 0 };

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
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
  return new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
}

function createAuthorizationContext(env) {
  if (!env.PRIVY_AUTH_PRIVATE_KEY) {
    throw new Error("PRIVY_AUTH_PRIVATE_KEY is not configured.");
  }
  return { authorization_private_keys: [env.PRIVY_AUTH_PRIVATE_KEY] };
}

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

function isSolanaAddress(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isTransactionSignature(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(value);
}

function isPositiveAmount(value) {
  const text = String(value ?? "").trim();
  return /^\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) > 0;
}

function parseDecimalToRaw(value, decimals) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Invalid decimal amount.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Maximum ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function formatUnits(rawValue, decimals) {
  const raw = typeof rawValue === "bigint" ? rawValue : BigInt(rawValue);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  let result = whole.toString();
  if (decimals > 0) result += "." + fraction.toString().padStart(decimals, "0");
  return negative ? `-${result}` : result;
}

function formatMicroUsd(rawValue) {
  if (rawValue == null) return null;
  const text = formatUnits(BigInt(String(rawValue)), PRICE_MICRO_DECIMALS);
  return text.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSafePrivyError(error) {
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : null;
  const code = error?.code ?? error?.error?.code ?? error?.body?.error?.code ?? null;
  return {
    status,
    name: typeof error?.name === "string" ? error.name : null,
    code: code == null ? null : String(code),
    message: typeof error?.message === "string" ? error.message.slice(0, 500) : "Privy request failed.",
  };
}

function looksLikePolicyDenial(info) {
  const text = [info?.name, info?.code, info?.message].filter(Boolean).join(" ").toLowerCase();
  return text.includes("policy") || text.includes("denied") || text.includes("not allowed") || text.includes("not permitted") || text.includes("forbidden");
}

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  throw new Error("Invalid boolean value.");
}

function normalizeBps(value, fieldName, { min = 1, max = 10000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max} basis points.`);
  }
  return number;
}

function activeStatusSqlPlaceholders() {
  return ACTIVE_STRATEGY_STATUSES.map(() => "?").join(",");
}

function autoExecutionRequested(env) {
  return String(env?.AUTO_EXECUTION_ENABLED || "false").trim().toLowerCase() === "true";
}

function autoSellRequested(env) {
  return String(env?.AUTO_SELL_ENABLED || "false").trim().toLowerCase() === "true";
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

async function verifyPrivyRequest(request, env) {
  const accessToken = getBearerToken(request);
  if (!accessToken) return { ok: false, status: 401, message: "Missing authentication token." };
  try {
    const claims = await createPrivyClient(env).utils().auth().verifyAccessToken(accessToken);
    if (!claims?.user_id) return { ok: false, status: 401, message: "Privy user ID could not be verified." };
    return { ok: true, userId: claims.user_id, claims };
  } catch (error) {
    console.error("Privy verification error:", error);
    return { ok: false, status: 401, message: "Invalid or expired Privy session." };
  }
}

async function getReboundAccount(env, privyUserId) {
  return env.DB.prepare(`
    SELECT phantom_address, privy_user_id, rebound_wallet_id, rebound_wallet_address, created_at, updated_at
    FROM rebound_users
    WHERE privy_user_id = ?
    LIMIT 1
  `).bind(privyUserId).first();
}

function getHeliusUrl(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY is not configured.");
  return HELIUS_RPC_BASE + "?api-key=" + encodeURIComponent(env.HELIUS_API_KEY);
}

async function heliusRpc(env, method, params) {
  const response = await fetch(getHeliusUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "asty-rebound", method, params }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Helius HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  if (data?.error) throw new Error(data.error?.message || "Helius returned an RPC error.");
  return data?.result ?? data;
}

async function getSolBalance(env, walletAddress) {
  const result = await heliusRpc(env, "getBalance", [walletAddress, { commitment: "confirmed" }]);
  const lamports = BigInt(result?.value ?? 0);
  return { raw: lamports.toString(), ui: formatUnits(lamports, SOL_DECIMALS) };
}

async function getTokenBalanceViaDas(env, walletAddress, mint, decimals) {
  const result = await heliusRpc(env, "getTokenAccounts", {
    owner: walletAddress,
    mint,
    options: { showZeroBalance: true },
  });
  const accounts = Array.isArray(result?.token_accounts) ? result.token_accounts : [];
  let totalRaw = 0n;
  for (const account of accounts) {
    if (account?.amount != null) totalRaw += BigInt(String(account.amount));
  }
  return { raw: totalRaw.toString(), ui: formatUnits(totalRaw, decimals), method: "helius-getTokenAccounts" };
}

async function getTokenBalanceViaStandardRpc(env, walletAddress, mint, decimals) {
  const result = await heliusRpc(env, "getTokenAccountsByOwner", [
    walletAddress,
    { mint },
    { commitment: "confirmed", encoding: "jsonParsed" },
  ]);
  const accounts = Array.isArray(result?.value) ? result.value : [];
  let totalRaw = 0n;
  for (const tokenAccount of accounts) {
    const amount = tokenAccount?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string") totalRaw += BigInt(amount);
  }
  return { raw: totalRaw.toString(), ui: formatUnits(totalRaw, decimals), method: "helius-getTokenAccountsByOwner" };
}

async function getTokenBalance(env, walletAddress, mint, decimals) {
  try {
    return await getTokenBalanceViaDas(env, walletAddress, mint, decimals);
  } catch (error) {
    console.error(`DAS token lookup failed for ${mint}; using standard RPC:`, error);
    return getTokenBalanceViaStandardRpc(env, walletAddress, mint, decimals);
  }
}

async function getUsdcBalance(env, walletAddress) {
  return getTokenBalance(env, walletAddress, USDC_MINT, USDC_DECIMALS);
}

async function getAstyBalance(env, walletAddress) {
  return getTokenBalance(env, walletAddress, ASTY_MINT, ASTY_DECIMALS);
}

async function getOwnedTokenAccount(env, walletAddress, mint, decimals) {
  try {
    const result = await heliusRpc(env, "getTokenAccounts", {
      owner: walletAddress,
      mint,
      options: { showZeroBalance: true },
    });
    const accounts = Array.isArray(result?.token_accounts) ? result.token_accounts : [];
    const account = accounts.find((item) => typeof item?.address === "string" && item?.owner === walletAddress)
      || accounts.find((item) => typeof item?.address === "string")
      || null;
    if (account) {
      const raw = BigInt(String(account?.amount ?? "0"));
      return {
        ready: true,
        address: account.address,
        raw: raw.toString(),
        ui: formatUnits(raw, decimals),
        method: "helius-getTokenAccounts",
      };
    }
  } catch (error) {
    console.error(`DAS token-account lookup failed for ${mint}; using standard RPC:`, error);
  }

  const result = await heliusRpc(env, "getTokenAccountsByOwner", [
    walletAddress,
    { mint },
    { commitment: "confirmed", encoding: "jsonParsed" },
  ]);
  const accounts = Array.isArray(result?.value) ? result.value : [];
  const tokenAccount = accounts.find((item) => typeof item?.pubkey === "string" && item?.account?.data?.parsed?.info?.owner === walletAddress)
    || accounts[0]
    || null;
  if (!tokenAccount) {
    return { ready: false, address: null, raw: "0", ui: formatUnits(0n, decimals), method: "helius-getTokenAccountsByOwner" };
  }
  const raw = BigInt(String(tokenAccount?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"));
  return {
    ready: true,
    address: tokenAccount.pubkey,
    raw: raw.toString(),
    ui: formatUnits(raw, decimals),
    method: "helius-getTokenAccountsByOwner",
  };
}

async function getUsdcTokenAccount(env, walletAddress) {
  return getOwnedTokenAccount(env, walletAddress, USDC_MINT, USDC_DECIMALS);
}

async function getWsolTokenAccount(env, walletAddress) {
  try {
    const result = await heliusRpc(env, "getTokenAccounts", {
      owner: walletAddress,
      mint: WSOL_MINT,
      options: { showZeroBalance: true },
    });
    const accounts = Array.isArray(result?.token_accounts) ? result.token_accounts : [];
    const account = accounts.find((item) => typeof item?.address === "string" && item?.owner === walletAddress)
      || accounts.find((item) => typeof item?.address === "string")
      || null;
    if (account) {
      const raw = BigInt(String(account?.amount ?? "0"));
      return { ready: true, address: account.address, raw: raw.toString(), ui: formatUnits(raw, SOL_DECIMALS), method: "helius-getTokenAccounts" };
    }
  } catch (error) {
    console.error("DAS WSOL lookup failed; using standard RPC:", error);
  }

  const result = await heliusRpc(env, "getTokenAccountsByOwner", [
    walletAddress,
    { mint: WSOL_MINT },
    { commitment: "confirmed", encoding: "jsonParsed" },
  ]);
  const accounts = Array.isArray(result?.value) ? result.value : [];
  const tokenAccount = accounts.find((item) => typeof item?.pubkey === "string" && item?.account?.data?.parsed?.info?.owner === walletAddress)
    || accounts[0]
    || null;
  if (!tokenAccount) {
    return { ready: false, address: null, raw: "0", ui: "0.000000000", method: "helius-getTokenAccountsByOwner" };
  }
  const raw = BigInt(String(tokenAccount?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"));
  return { ready: true, address: tokenAccount.pubkey, raw: raw.toString(), ui: formatUnits(raw, SOL_DECIMALS), method: "helius-getTokenAccountsByOwner" };
}

async function getSolUsdPrice(env) {
  const now = Date.now();
  if (solPriceCache.price != null && now < solPriceCache.expiresAt) return solPriceCache.price;
  const result = await heliusRpc(env, "getAsset", {
    id: WSOL_MINT,
    displayOptions: { showFungible: true },
  });
  const price = Number(result?.token_info?.price_info?.price_per_token);
  if (!Number.isFinite(price) || price <= 0) throw new Error("SOL USD price unavailable.");
  solPriceCache = { price, expiresAt: now + 60_000 };
  return price;
}

async function getLatestBlockhash(env) {
  const result = await heliusRpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = result?.value?.blockhash;
  const lastValidBlockHeight = result?.value?.lastValidBlockHeight;
  if (!blockhash || !lastValidBlockHeight) throw new Error("Could not obtain a fresh Solana blockhash.");
  return { blockhash, lastValidBlockHeight };
}

async function getPrivyDelegatedWallet(privy, userId, reboundWalletAddress) {
  const privyUser = await privy.users()._get(userId);
  const linkedAccounts = Array.isArray(privyUser?.linked_accounts)
    ? privyUser.linked_accounts
    : Array.isArray(privyUser?.linkedAccounts)
      ? privyUser.linkedAccounts
      : [];
  return linkedAccounts.find((item) => item?.type === "wallet" && item?.address === reboundWalletAddress && item?.delegated === true) || null;
}

async function jupiterFetch(env, path, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(JUPITER_SWAP_BASE + path, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {}),
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const message = data?.error || data?.message || `Jupiter HTTP ${response.status}: ${text.slice(0, 240)}`;
        lastError = new Error(message);
        if (response.status === 429 && attempt < 2) {
          await sleep(2200 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(700 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError || new Error("Jupiter request failed.");
}

async function getJupiterSolPriceMicroUsdc(env) {
  const url = new URL(JUPITER_PRICE_URL);
  url.searchParams.set("ids", WSOL_MINT);
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      ...(env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Jupiter Price HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  const usdPrice = Number(data?.[WSOL_MINT]?.usdPrice);
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) throw new Error("Jupiter Price API did not return a valid SOL price.");
  const micro = BigInt(Math.round(usdPrice * 1_000_000));
  return {
    micro,
    usdPrice,
    blockId: data?.[WSOL_MINT]?.blockId ?? null,
    priceChange24h: data?.[WSOL_MINT]?.priceChange24h ?? null,
  };
}

function instructionProgramIds(plan) {
  const ids = [];
  for (const item of plan?.computeBudgetInstructions || []) if (item?.programId) ids.push(item.programId);
  for (const item of plan?.setupInstructions || []) if (item?.programId) ids.push(item.programId);
  if (plan?.tokenLedgerInstruction?.programId) ids.push(plan.tokenLedgerInstruction.programId);
  if (plan?.swapInstruction?.programId) ids.push(plan.swapInstruction.programId);
  if (plan?.cleanupInstruction?.programId) ids.push(plan.cleanupInstruction.programId);
  for (const item of plan?.otherInstructions || []) if (item?.programId) ids.push(item.programId);
  if (plan?.tipInstruction?.programId) ids.push(plan.tipInstruction.programId);
  return [...new Set(ids)];
}

async function getJupiterV2Build(env, {
  walletAddress,
  destinationTokenAccount,
  amountRaw,
}) {
  if (!env.JUPITER_API_KEY) {
    throw new Error("JUPITER_API_KEY is not configured.");
  }

  const url = new URL(JUPITER_SWAP_V2_BUILD_URL);
  url.searchParams.set("inputMint", USDC_MINT);
  url.searchParams.set("outputMint", WSOL_MINT);
  url.searchParams.set("amount", String(amountRaw));
  url.searchParams.set("taker", walletAddress);
  url.searchParams.set("payer", walletAddress);
  url.searchParams.set("slippageBps", String(EXECUTION_SLIPPAGE_BPS));
  url.searchParams.set("computeUnitPricePercentile", "medium");
  url.searchParams.set("wrapAndUnwrapSol", "false");
  url.searchParams.set("destinationTokenAccount", destinationTokenAccount);
  url.searchParams.set("maxAccounts", "64");
  url.searchParams.set("blockhashSlotsToExpiry", "150");

  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-api-key": env.JUPITER_API_KEY,
        },
      });

      const bodyText = await response.text();
      let data = null;
      try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = null; }

      if (!response.ok) {
        const message = data?.error || data?.message || `Jupiter V2 /build HTTP ${response.status}: ${bodyText.slice(0, 300)}`;
        lastError = new Error(message);
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(900 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      if (!data?.swapInstruction?.programId) {
        throw new Error("Jupiter V2 /build did not return a valid swap instruction.");
      }

      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error("Jupiter V2 /build request failed.");
}

async function getJupiterV2SellBuild(env, {
  walletAddress,
  destinationTokenAccount,
  amountRaw,
}) {
  if (!env.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY is not configured.");

  const url = new URL(JUPITER_SWAP_V2_BUILD_URL);
  url.searchParams.set("inputMint", WSOL_MINT);
  url.searchParams.set("outputMint", USDC_MINT);
  url.searchParams.set("amount", String(amountRaw));
  url.searchParams.set("taker", walletAddress);
  url.searchParams.set("payer", walletAddress);
  url.searchParams.set("slippageBps", String(EXECUTION_SLIPPAGE_BPS));
  url.searchParams.set("computeUnitPricePercentile", "medium");
  url.searchParams.set("wrapAndUnwrapSol", "false");
  if (destinationTokenAccount) url.searchParams.set("destinationTokenAccount", destinationTokenAccount);
  url.searchParams.set("maxAccounts", "64");
  url.searchParams.set("blockhashSlotsToExpiry", "150");

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", "x-api-key": env.JUPITER_API_KEY },
      });
      const bodyText = await response.text();
      let data = null;
      try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = null; }
      if (!response.ok) {
        const message = data?.error || data?.message || `Jupiter V2 /build HTTP ${response.status}: ${bodyText.slice(0, 300)}`;
        lastError = new Error(message);
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(900 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      if (!data?.swapInstruction?.programId) throw new Error("Jupiter V2 /build did not return a valid SELL swap instruction.");
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError || new Error("Jupiter V2 SELL /build request failed.");
}


function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, Math.min(i + CHUNK, view.length)));
  }
  return btoa(binary);
}

function apiInstructionToWeb3(ix) {
  if (!ix?.programId || !Array.isArray(ix?.accounts) || typeof ix?.data !== "string") {
    throw new Error("Jupiter V2 returned an invalid instruction.");
  }

  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: Boolean(account.isSigner),
      isWritable: Boolean(account.isWritable),
    })),
    data: base64ToBytes(ix.data),
  });
}

function transformV2LookupTables(raw) {
  if (!raw || typeof raw !== "object") return [];

  return Object.entries(raw).map(([key, addresses]) => {
    if (!Array.isArray(addresses)) {
      throw new Error("Jupiter V2 returned an invalid address lookup table.");
    }

    return new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: addresses.map((address) => new PublicKey(address)),
      },
    });
  });
}

function getV2RecentBlockhash(build) {
  const raw = build?.blockhashWithMetadata?.blockhash;

  if (typeof raw === "string" && raw.length >= 32) {
    return raw;
  }

  if (Array.isArray(raw) && raw.length === 32) {
    // A Solana blockhash is 32 bytes and uses the same base58 encoding as a PublicKey.
    return new PublicKey(Uint8Array.from(raw)).toBase58();
  }

  throw new Error("Jupiter V2 did not return a valid recent blockhash.");
}

function getV2CoreInstructions(build) {
  const instructions = [];

  for (const ix of build?.setupInstructions || []) {
    instructions.push(apiInstructionToWeb3(ix));
  }

  if (!build?.swapInstruction) {
    throw new Error("Jupiter V2 swap instruction is missing.");
  }
  instructions.push(apiInstructionToWeb3(build.swapInstruction));

  if (build?.cleanupInstruction) {
    instructions.push(apiInstructionToWeb3(build.cleanupInstruction));
  }

  for (const ix of build?.otherInstructions || []) {
    instructions.push(apiInstructionToWeb3(ix));
  }

  if (build?.tipInstruction) {
    throw new Error("Jupiter V2 returned a tip instruction, but ASTY Rebound does not allow automatic tips.");
  }

  return instructions;
}

function buildUnsignedV2TransactionBase64(build, walletAddress, instructions) {
  const lookupTables = transformV2LookupTables(build?.addressesByLookupTableAddress);
  const recentBlockhash = getV2RecentBlockhash(build);

  const message = new TransactionMessage({
    payerKey: new PublicKey(walletAddress),
    recentBlockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const transaction = new VersionedTransaction(message);

  return {
    transactionBase64: bytesToBase64(transaction.serialize()),
    recentBlockhash,
    lastValidBlockHeight: Number(build?.blockhashWithMetadata?.lastValidBlockHeight || 0),
    lookupTableCount: lookupTables.length,
  };
}

async function buildJupiterV2BuyTransaction(env, {
  build,
  walletAddress,
}) {
  const coreInstructions = getV2CoreInstructions(build);

  // Jupiter /build deliberately omits the CU limit. Simulate with the Solana
  // maximum first, then rebuild at 1.2x measured usage as recommended by Jupiter.
  const simulationInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
    ...coreInstructions,
  ];

  const simulationTx = buildUnsignedV2TransactionBase64(
    build,
    walletAddress,
    simulationInstructions,
  );

  const simulation = await heliusRpc(env, "simulateTransaction", [
    simulationTx.transactionBase64,
    {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    },
  ]);

  if (simulation?.value?.err) {
    const error = new Error("Jupiter V2 BUY transaction simulation failed.");
    error.code = "V2_SIMULATION_FAILED";
    error.simulationError = simulation.value.err;
    error.logs = Array.isArray(simulation.value.logs) ? simulation.value.logs.slice(-12) : [];
    throw error;
  }

  const unitsConsumed = Number(simulation?.value?.unitsConsumed || 0);
  const estimatedComputeUnits = unitsConsumed > 0
    ? Math.min(Math.ceil(unitsConsumed * 1.2), MAX_COMPUTE_UNIT_LIMIT)
    : MAX_COMPUTE_UNIT_LIMIT;

  const finalInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedComputeUnits }),
    ...(build?.computeBudgetInstructions || []).map(apiInstructionToWeb3),
    ...coreInstructions,
  ];

  const finalTx = buildUnsignedV2TransactionBase64(
    build,
    walletAddress,
    finalInstructions,
  );

  return {
    swapTransaction: finalTx.transactionBase64,
    recentBlockhash: finalTx.recentBlockhash,
    lastValidBlockHeight: finalTx.lastValidBlockHeight,
    lookupTableCount: finalTx.lookupTableCount,
    unitsConsumed: unitsConsumed || null,
    computeUnitLimit: estimatedComputeUnits,
    instructionCount: finalInstructions.length,
  };
}

function extractPrivyTxHash(result) {
  return result?.hash || result?.data?.hash || result?.signature || result?.result?.signature || null;
}

function normalizeStrategyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    assetSymbol: row.asset_symbol,
    status: row.status,
    preset: row.preset,
    dipBps: Number(row.dip_bps),
    takeProfitBps: Number(row.take_profit_bps),
    stopLossEnabled: Boolean(row.stop_loss_enabled),
    stopLossBps: row.stop_loss_bps == null ? null : Number(row.stop_loss_bps),
    autoRepeat: Boolean(row.auto_repeat),
    compound: Boolean(row.compound),
    initialCapitalUsdcRaw: String(row.initial_capital_usdc_raw),
    reservedCapitalUsdcRaw: String(row.reserved_capital_usdc_raw),
    currentCycleCapitalUsdcRaw: String(row.current_cycle_capital_usdc_raw),
    freeProfitUsdcRaw: String(row.free_profit_usdc_raw ?? 0),
    initialCapitalUsdc: formatUnits(BigInt(row.initial_capital_usdc_raw), USDC_DECIMALS),
    reservedCapitalUsdc: formatUnits(BigInt(row.reserved_capital_usdc_raw), USDC_DECIMALS),
    currentCycleCapitalUsdc: formatUnits(BigInt(row.current_cycle_capital_usdc_raw), USDC_DECIMALS),
    freeProfitUsdc: formatUnits(BigInt(row.free_profit_usdc_raw ?? 0), USDC_DECIMALS),
    hwmPriceMicroUsdc: row.hwm_price_micro_usdc == null ? null : String(row.hwm_price_micro_usdc),
    currentPriceMicroUsdc: row.current_price_micro_usdc == null ? null : String(row.current_price_micro_usdc),
    buyTriggerPriceMicroUsdc: row.buy_trigger_price_micro_usdc == null ? null : String(row.buy_trigger_price_micro_usdc),
    hwmPriceUsd: formatMicroUsd(row.hwm_price_micro_usdc),
    currentPriceUsd: formatMicroUsd(row.current_price_micro_usdc),
    buyTriggerPriceUsd: formatMicroUsd(row.buy_trigger_price_micro_usdc),
    buyFillPriceMicroUsdc: row.buy_fill_price_micro_usdc == null ? null : String(row.buy_fill_price_micro_usdc),
    takeProfitPriceMicroUsdc: row.take_profit_price_micro_usdc == null ? null : String(row.take_profit_price_micro_usdc),
    stopLossPriceMicroUsdc: row.stop_loss_price_micro_usdc == null ? null : String(row.stop_loss_price_micro_usdc),
    entryWsolRaw: row.entry_wsol_raw == null ? null : String(row.entry_wsol_raw),
    cycleNumber: Number(row.cycle_number ?? 1),
    astyGateCheckedAt: row.asty_gate_checked_at ?? null,
    astyBalanceRawAtCreation: row.asty_balance_raw_at_creation ?? null,
    buyTriggeredAt: row.buy_triggered_at ?? null,
    boughtAt: row.bought_at ?? null,
    sellTriggeredAt: row.sell_triggered_at ?? null,
    soldAt: row.sold_at ?? null,
    pausedAt: row.paused_at ?? null,
    stoppedAt: row.stopped_at ?? null,
    lastPriceAt: row.last_price_at ?? null,
    pendingAction: row.pending_action ?? null,
    pendingSignature: row.pending_signature ?? null,
    pendingActionStartedAt: row.pending_action_started_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getReservedCapitalRaw(env, privyUserId) {
  const row = await env.DB.prepare(`
    SELECT CAST(COALESCE(SUM(reserved_capital_usdc_raw), 0) AS TEXT) AS reserved_raw
    FROM rebound_strategies
    WHERE privy_user_id = ?
      AND status IN (${activeStatusSqlPlaceholders()})
  `).bind(privyUserId, ...ACTIVE_STRATEGY_STATUSES).first();
  return BigInt(String(row?.reserved_raw ?? 0));
}

async function getUsdcHeldReservedCapitalRaw(env, privyUserId) {
  const row = await env.DB.prepare(`
    SELECT CAST(COALESCE(SUM(reserved_capital_usdc_raw), 0) AS TEXT) AS reserved_raw
    FROM rebound_strategies
    WHERE privy_user_id = ?
      AND (
        status IN ('WATCHING', 'BUY_TRIGGERED')
        OR (status = 'PAUSED' AND COALESCE(entry_wsol_raw, 0) = 0)
      )
  `).bind(privyUserId).first();
  return BigInt(String(row?.reserved_raw ?? 0));
}

function resolveStrategyConfiguration(body) {
  const preset = String(body?.preset || "balanced").trim().toLowerCase();
  let dipBps;
  let takeProfitBps;
  if (PRESETS[preset]) {
    dipBps = PRESETS[preset].dipBps;
    takeProfitBps = PRESETS[preset].takeProfitBps;
  } else if (preset === "custom") {
    dipBps = normalizeBps(body?.dipBps, "dipBps", { min: 50, max: 5000 });
    takeProfitBps = normalizeBps(body?.takeProfitBps, "takeProfitBps", { min: 50, max: 10000 });
  } else {
    throw new Error("Unsupported strategy preset.");
  }

  const stopLossEnabled = normalizeBoolean(body?.stopLossEnabled, false);
  const stopLossBps = stopLossEnabled
    ? normalizeBps(body?.stopLossBps, "stopLossBps", { min: 50, max: 5000 })
    : null;

  return {
    preset,
    dipBps,
    takeProfitBps,
    stopLossEnabled,
    stopLossBps,
    autoRepeat: normalizeBoolean(body?.autoRepeat, false),
    compound: normalizeBoolean(body?.compound, false),
  };
}

async function loadWatchingStrategies(env, privyUserId = null) {
  const sql = privyUserId
    ? `SELECT * FROM rebound_strategies WHERE status = 'WATCHING' AND asset_symbol = 'SOL' AND privy_user_id = ? ORDER BY created_at ASC`
    : `SELECT * FROM rebound_strategies WHERE status = 'WATCHING' AND asset_symbol = 'SOL' ORDER BY created_at ASC`;
  const result = privyUserId
    ? await env.DB.prepare(sql).bind(privyUserId).all()
    : await env.DB.prepare(sql).all();
  return Array.isArray(result?.results) ? result.results : [];
}

function priceMoveFraction(previousRaw, nextRaw) {
  const previous = Number(previousRaw);
  const next = Number(nextRaw);
  if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(next) || next <= 0) return 0;
  return Math.abs(next - previous) / previous;
}

async function runPriceWatcher(env, { source = "cron", privyUserId = null } = {}) {
  const strategies = await loadWatchingStrategies(env, privyUserId);
  if (strategies.length === 0) {
    return {
      ok: true,
      mode: "watch-only",
      executionEnabled: false,
      source,
      checked: 0,
      updated: 0,
      triggered: 0,
      message: "No WATCHING SOL strategies found.",
    };
  }

  let priceInfo = await getJupiterSolPriceMicroUsdc(env);
  let needsConfirmation = false;

  for (const strategy of strategies) {
    if (strategy.current_price_micro_usdc != null && priceMoveFraction(strategy.current_price_micro_usdc, priceInfo.micro) > 0.20) {
      needsConfirmation = true;
      break;
    }
  }

  let safetyConfirmation = null;
  if (needsConfirmation) {
    await sleep(1200);
    const second = await getJupiterSolPriceMicroUsdc(env);
    const betweenChecks = priceMoveFraction(priceInfo.micro, second.micro);
    if (betweenChecks > 0.02) {
      throw new Error("Watcher safety check rejected an unstable >20% price move. No strategy state was changed.");
    }
    priceInfo = second;
    safetyConfirmation = "confirmed";
  }

  let updated = 0;
  let triggered = 0;
  const current = priceInfo.micro;

  for (const strategy of strategies) {
    const oldHwm = strategy.hwm_price_micro_usdc == null ? null : BigInt(String(strategy.hwm_price_micro_usdc));
    const hwm = oldHwm == null || current > oldHwm ? current : oldHwm;
    const dipBps = BigInt(Number(strategy.dip_bps));
    const trigger = hwm * (10_000n - dipBps) / 10_000n;
    const shouldTrigger = current <= trigger;

    let result;
    if (shouldTrigger) {
      result = await env.DB.prepare(`
        UPDATE rebound_strategies
        SET
          status = 'BUY_TRIGGERED',
          current_price_micro_usdc = ?,
          hwm_price_micro_usdc = ?,
          buy_trigger_price_micro_usdc = ?,
          buy_triggered_at = COALESCE(buy_triggered_at, CURRENT_TIMESTAMP),
          last_price_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'WATCHING'
      `).bind(current.toString(), hwm.toString(), trigger.toString(), strategy.id).run();
    } else {
      result = await env.DB.prepare(`
        UPDATE rebound_strategies
        SET
          current_price_micro_usdc = ?,
          hwm_price_micro_usdc = ?,
          buy_trigger_price_micro_usdc = ?,
          last_price_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'WATCHING'
      `).bind(current.toString(), hwm.toString(), trigger.toString(), strategy.id).run();
    }

    const changed = Number(result?.meta?.changes ?? 0);
    if (changed > 0) {
      updated += changed;
      if (shouldTrigger) triggered += changed;
    }
  }

  return {
    ok: true,
    mode: "watch-only",
    executionEnabled: false,
    source,
    checked: strategies.length,
    updated,
    triggered,
    currentPriceMicroUsdc: current.toString(),
    currentPriceUsd: formatMicroUsd(current),
    priceSource: "Jupiter Price API V3",
    priceBlockId: priceInfo.blockId,
    priceChange24h: priceInfo.priceChange24h,
    safetyConfirmation,
    checkedAt: new Date().toISOString(),
  };
}

async function getExecutionCheckStrategy(env, privyUserId, strategyId = null) {
  if (strategyId) {
    return env.DB.prepare(`
      SELECT *
      FROM rebound_strategies
      WHERE id = ?
        AND privy_user_id = ?
        AND asset_symbol = 'SOL'
        AND status IN ('WATCHING', 'BUY_TRIGGERED')
      LIMIT 1
    `).bind(strategyId, privyUserId).first();
  }

  return env.DB.prepare(`
    SELECT *
    FROM rebound_strategies
    WHERE privy_user_id = ?
      AND asset_symbol = 'SOL'
      AND status IN ('WATCHING', 'BUY_TRIGGERED')
    ORDER BY
      CASE WHEN status = 'BUY_TRIGGERED' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `).bind(privyUserId).first();
}

async function handleExecutionCheck(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);

    let body = {};
    try { body = await request.json(); } catch {}

    const strategyId = body?.strategyId ? String(body.strategyId).trim() : null;
    const strategy = await getExecutionCheckStrategy(env, auth.userId, strategyId);

    if (!strategy) {
      return json(request, {
        status: "error",
        code: "NO_ELIGIBLE_STRATEGY",
        message: "No WATCHING or BUY_TRIGGERED SOL strategy was found for this account.",
      }, 404);
    }

    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) {
      return json(request, { status: "error", message: "Rebound account not found." }, 404);
    }

    const walletAddress = account.rebound_wallet_address;
    const cycleCapitalRaw = BigInt(String(strategy.current_cycle_capital_usdc_raw || 0));
    const strategyReservedRaw = BigInt(String(strategy.reserved_capital_usdc_raw || 0));

    if (cycleCapitalRaw <= 0n) {
      return json(request, {
        status: "error",
        code: "INVALID_STRATEGY_CAPITAL",
        message: "The strategy does not have valid cycle capital.",
      }, 409);
    }

    const [usdc, nativeSol, tradingSol, totalReservedRaw, reservedInUsdcRaw] = await Promise.all([
      getUsdcBalance(env, walletAddress),
      getSolBalance(env, walletAddress),
      getWsolTokenAccount(env, walletAddress),
      getReservedCapitalRaw(env, auth.userId),
      getUsdcHeldReservedCapitalRaw(env, auth.userId),
    ]);

    const walletUsdcRaw = BigInt(usdc.raw);
    const gasRaw = BigInt(nativeSol.raw);

    const capitalReconciled =
      strategyReservedRaw >= cycleCapitalRaw &&
      walletUsdcRaw >= cycleCapitalRaw &&
      walletUsdcRaw >= reservedInUsdcRaw;

    const gasOk = gasRaw >= MIN_GAS_LAMPORTS;
    const wsolReady = Boolean(tradingSol.ready && tradingSol.address);

    if (!capitalReconciled) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "CAPITAL_RECONCILIATION_FAILED",
        message: "Strategy capital does not reconcile with the on-chain Rebound Wallet balance. No trade was attempted.",
        checks: {
          capital: {
            ok: false,
            strategyCapitalUsdc: formatUnits(cycleCapitalRaw, USDC_DECIMALS),
            strategyReservedUsdc: formatUnits(strategyReservedRaw, USDC_DECIMALS),
            totalReservedUsdc: formatUnits(totalReservedRaw, USDC_DECIMALS),
            reservedInUsdc: formatUnits(reservedInUsdcRaw, USDC_DECIMALS),
            walletUsdc: formatUnits(walletUsdcRaw, USDC_DECIMALS),
          },
        },
      }, 409);
    }

    if (!gasOk) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "GAS_RESERVE_LOW",
        message: "The Rebound Wallet has less than 0.005 SOL available for network fees.",
        checks: {
          gas: {
            ok: false,
            currentSol: formatUnits(gasRaw, SOL_DECIMALS),
            minimumSol: formatUnits(MIN_GAS_LAMPORTS, SOL_DECIMALS),
            recommendedSol: formatUnits(RECOMMENDED_GAS_LAMPORTS, SOL_DECIMALS),
          },
        },
      }, 409);
    }

    if (!wsolReady) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "WSOL_ACCOUNT_NOT_READY",
        message: "The Rebound Wallet SOL trading account is not ready.",
      }, 409);
    }

    if (!env.PRIVY_AUTH_KEY_ID || !env.PRIVY_AUTH_PRIVATE_KEY || !env.PRIVY_POLICY_ID) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "AUTOMATION_NOT_CONFIGURED",
        message: "Automated trading authorization is not fully configured.",
      }, 503);
    }

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, auth.userId, walletAddress);
    if (!delegatedWallet) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "AUTOMATION_NOT_ENABLED",
        message: "Automated Trading is not enabled for this Rebound Wallet.",
      }, 409);
    }

    const [build, referencePrice] = await Promise.all([
      getJupiterV2Build(env, {
        walletAddress,
        destinationTokenAccount: tradingSol.address,
        amountRaw: cycleCapitalRaw.toString(),
      }),
      getJupiterSolPriceMicroUsdc(env),
    ]);

    if (build.inputMint !== USDC_MINT || build.outputMint !== WSOL_MINT || String(build.inAmount) !== cycleCapitalRaw.toString()) {
      return json(request, {
        status: "error",
        ready: false,
        noTradeExecuted: true,
        code: "JUPITER_ROUTE_MISMATCH",
        message: "Jupiter returned a route that does not match the requested strategy trade.",
      }, 502);
    }

    const programs = instructionProgramIds(build);
    const allowedPrograms = new Set([
      COMPUTE_BUDGET_PROGRAM_ID,
      JUPITER_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ]);
    const unexpectedPrograms = programs.filter((programId) => !allowedPrograms.has(programId));
    const hasJupiterSwap = programs.includes(JUPITER_PROGRAM_ID);
    const hasTipInstruction = Boolean(build?.tipInstruction);
    const policyCompatible = hasJupiterSwap && unexpectedPrograms.length === 0 && !hasTipInstruction;

    const outRaw = BigInt(String(build.outAmount || 0));
    const referencePriceRaw = referencePrice.micro;
    const expectedOutRaw = referencePriceRaw > 0n
      ? cycleCapitalRaw * (10n ** BigInt(SOL_DECIMALS)) / referencePriceRaw
      : 0n;

    let referenceShortfallBps = 0;
    if (expectedOutRaw > 0n && outRaw < expectedOutRaw) {
      referenceShortfallBps = Number((expectedOutRaw - outRaw) * 10_000n / expectedOutRaw);
    }
    const routeSanityOk = outRaw > 0n && referenceShortfallBps <= MAX_ROUTE_REFERENCE_SHORTFALL_BPS;

    let transactionBuild = {
      ok: false,
      computeUnitLimit: null,
      unitsConsumed: null,
      lookupTableCount: null,
      instructionCount: null,
      error: null,
    };

    if (policyCompatible && routeSanityOk) {
      try {
        const builtTransaction = await buildJupiterV2BuyTransaction(env, {
          build,
          walletAddress,
        });

        transactionBuild = {
          ok: true,
          computeUnitLimit: builtTransaction.computeUnitLimit,
          unitsConsumed: builtTransaction.unitsConsumed,
          lookupTableCount: builtTransaction.lookupTableCount,
          instructionCount: builtTransaction.instructionCount,
          error: null,
        };
      } catch (error) {
        transactionBuild = {
          ok: false,
          computeUnitLimit: null,
          unitsConsumed: null,
          lookupTableCount: null,
          instructionCount: null,
          error: error?.message || "V2 transaction build failed.",
        };
      }
    }

    const ready =
      capitalReconciled &&
      gasOk &&
      wsolReady &&
      policyCompatible &&
      routeSanityOk &&
      transactionBuild.ok;

    return json(request, {
      status: ready ? "ok" : "error",
      ready,
      mode: "preflight-only",
      noTradeExecuted: true,
      liveExecutionImplemented: true,
      autoExecutionRequested: autoExecutionRequested(env),
      autoSellRequested: autoSellRequested(env),
      message: ready
        ? "Execution check passed. The BUY executor is installed, but this check never signs or sends a trade."
        : "Execution check found a safety condition that must be resolved before live BUY execution.",
      strategy: {
        id: strategy.id,
        status: strategy.status,
        asset: strategy.asset_symbol,
        capitalUsdc: formatUnits(cycleCapitalRaw, USDC_DECIMALS),
        slippageBps: EXECUTION_SLIPPAGE_BPS,
      },
      checks: {
        capital: {
          ok: capitalReconciled,
          strategyCapitalUsdc: formatUnits(cycleCapitalRaw, USDC_DECIMALS),
          totalReservedUsdc: formatUnits(totalReservedRaw, USDC_DECIMALS),
          walletUsdc: formatUnits(walletUsdcRaw, USDC_DECIMALS),
        },
        gas: {
          ok: gasOk,
          currentSol: formatUnits(gasRaw, SOL_DECIMALS),
          minimumSol: formatUnits(MIN_GAS_LAMPORTS, SOL_DECIMALS),
          recommendedSol: formatUnits(RECOMMENDED_GAS_LAMPORTS, SOL_DECIMALS),
        },
        automatedTrading: {
          ok: true,
          delegated: true,
          policyConfigured: true,
        },
        tradingSol: {
          ok: wsolReady,
          tokenAccount: tradingSol.address,
        },
        jupiterV2: {
          ok: Boolean(build?.swapInstruction),
          endpoint: "/swap/v2/build",
          inputMint: build.inputMint,
          outputMint: build.outputMint,
          inAmountRaw: String(build.inAmount),
          outAmountRaw: String(build.outAmount),
          minimumOutRaw: String(build.otherAmountThreshold || "0"),
          slippageBps: Number(build.slippageBps ?? EXECUTION_SLIPPAGE_BPS),
          routeCount: Array.isArray(build.routePlan) ? build.routePlan.length : 0,
        },
        policyCompatibility: {
          ok: policyCompatible,
          expectedPrograms: [
            COMPUTE_BUDGET_PROGRAM_ID,
            JUPITER_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ],
          returnedPrograms: programs,
          unexpectedPrograms,
          hasTipInstruction,
        },
        routeSanity: {
          ok: routeSanityOk,
          referencePriceUsd: referencePrice.usdPrice,
          referenceShortfallBps,
          maxReferenceShortfallBps: MAX_ROUTE_REFERENCE_SHORTFALL_BPS,
        },
        transactionBuild: {
          ok: transactionBuild.ok,
          version: 0,
          simulation: "Helius",
          unitsConsumed: transactionBuild.unitsConsumed,
          computeUnitLimit: transactionBuild.computeUnitLimit,
          lookupTableCount: transactionBuild.lookupTableCount,
          instructionCount: transactionBuild.instructionCount,
          error: transactionBuild.error,
        },
      },
      checkedAt: new Date().toISOString(),
    }, ready ? 200 : 409);
  } catch (error) {
    console.error("Execution check error:", error);
    return json(request, {
      status: "error",
      ready: false,
      noTradeExecuted: true,
      message: error?.message || "Execution check could not be completed.",
    }, 503);
  }
}


async function getSignatureState(env, signature) {
  const result = await heliusRpc(env, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const value = result?.value?.[0] || null;
  if (!value) return { found: false, confirmed: false, failed: false, status: null, err: null };
  const status = value.confirmationStatus || null;
  const failed = value.err != null;
  const confirmed = !failed && (status === "confirmed" || status === "finalized");
  return { found: true, confirmed, failed, status, err: value.err ?? null };
}

function sumOwnerTokenBalanceRaw(balances, mint, owner) {
  let total = 0n;
  let matches = 0;
  for (const item of balances || []) {
    if (item?.mint !== mint || item?.owner !== owner) continue;
    const amount = item?.uiTokenAmount?.amount;
    if (typeof amount !== "string") continue;
    total += BigInt(amount);
    matches += 1;
  }
  return { total, matches };
}

async function getConfirmedSwapFill(env, signature, walletAddress) {
  const tx = await heliusRpc(env, "getTransaction", [
    signature,
    {
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    },
  ]);

  if (!tx?.meta) return null;
  if (tx.meta.err) return { failed: true, error: tx.meta.err };

  const preUsdc = sumOwnerTokenBalanceRaw(tx.meta.preTokenBalances, USDC_MINT, walletAddress);
  const postUsdc = sumOwnerTokenBalanceRaw(tx.meta.postTokenBalances, USDC_MINT, walletAddress);
  const preWsol = sumOwnerTokenBalanceRaw(tx.meta.preTokenBalances, WSOL_MINT, walletAddress);
  const postWsol = sumOwnerTokenBalanceRaw(tx.meta.postTokenBalances, WSOL_MINT, walletAddress);

  if ((preUsdc.matches + postUsdc.matches) === 0 || (preWsol.matches + postWsol.matches) === 0) {
    return null;
  }

  const spentUsdcRaw = preUsdc.total > postUsdc.total ? preUsdc.total - postUsdc.total : 0n;
  const receivedWsolRaw = postWsol.total > preWsol.total ? postWsol.total - preWsol.total : 0n;
  if (spentUsdcRaw <= 0n || receivedWsolRaw <= 0n) return null;

  // micro-USDC per 1 SOL: spentRaw(1e6) * 1e9 / receivedRaw(1e9)
  const fillPriceMicroUsdc = spentUsdcRaw * 1_000_000_000n / receivedWsolRaw;
  return {
    failed: false,
    spentUsdcRaw,
    receivedWsolRaw,
    fillPriceMicroUsdc,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ?? null,
  };
}

async function finalizeConfirmedBuy(env, strategy, signature) {
  const fill = await getConfirmedSwapFill(env, signature, strategy.rebound_wallet_address);
  if (!fill) {
    return { ok: false, pending: true, strategyId: strategy.id, signature, message: "Confirmed transaction is not fully indexed yet." };
  }
  if (fill.failed) {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'BUY_TRIGGERED' AND pending_signature = ?
    `).bind(strategy.id, signature).run();
    return { ok: false, failed: true, strategyId: strategy.id, signature, message: "BUY transaction failed on-chain and was released for a fresh retry." };
  }

  const takeProfitBps = BigInt(Number(strategy.take_profit_bps));
  const takeProfitPrice = fill.fillPriceMicroUsdc * (10_000n + takeProfitBps) / 10_000n;
  const stopLossPrice = Number(strategy.stop_loss_enabled) === 1 && strategy.stop_loss_bps != null
    ? fill.fillPriceMicroUsdc * (10_000n - BigInt(Number(strategy.stop_loss_bps))) / 10_000n
    : null;

  await ensureCycleHistoryTable(env);
  const cycleId = `${strategy.id}:${Number(strategy.cycle_number || 1)}`;
  await env.DB.prepare(`
    INSERT INTO rebound_cycles (
      id, strategy_id, privy_user_id, rebound_wallet_address, asset_symbol,
      cycle_number, status, capital_usdc_raw, spent_usdc_raw, entry_asset_raw,
      buy_fill_price_micro_usdc, buy_signature, buy_triggered_at, bought_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SOL', ?, 'OPEN', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      spent_usdc_raw = excluded.spent_usdc_raw,
      entry_asset_raw = excluded.entry_asset_raw,
      buy_fill_price_micro_usdc = excluded.buy_fill_price_micro_usdc,
      buy_signature = COALESCE(rebound_cycles.buy_signature, excluded.buy_signature),
      bought_at = COALESCE(rebound_cycles.bought_at, excluded.bought_at),
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    cycleId,
    strategy.id,
    strategy.privy_user_id,
    strategy.rebound_wallet_address,
    Number(strategy.cycle_number || 1),
    String(strategy.current_cycle_capital_usdc_raw || fill.spentUsdcRaw),
    fill.spentUsdcRaw.toString(),
    fill.receivedWsolRaw.toString(),
    fill.fillPriceMicroUsdc.toString(),
    signature,
    strategy.buy_triggered_at || null,
  ).run();

  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'BOUGHT',
        buy_fill_price_micro_usdc = ?,
        take_profit_price_micro_usdc = ?,
        stop_loss_price_micro_usdc = ?,
        entry_wsol_raw = ?,
        bought_at = COALESCE(bought_at, CURRENT_TIMESTAMP),
        pending_action = NULL,
        pending_signature = NULL,
        pending_action_started_at = NULL,
        execution_lock = NULL,
        execution_lock_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'BUY_TRIGGERED'
      AND pending_signature = ?
  `).bind(
    fill.fillPriceMicroUsdc.toString(),
    takeProfitPrice.toString(),
    stopLossPrice == null ? null : stopLossPrice.toString(),
    fill.receivedWsolRaw.toString(),
    strategy.id,
    signature,
  ).run();

  const changed = Number(result?.meta?.changes ?? 0);
  return {
    ok: changed > 0,
    finalized: changed > 0,
    strategyId: strategy.id,
    signature,
    spentUsdcRaw: fill.spentUsdcRaw.toString(),
    receivedWsolRaw: fill.receivedWsolRaw.toString(),
    fillPriceUsd: formatMicroUsd(fill.fillPriceMicroUsdc),
    takeProfitPriceUsd: formatMicroUsd(takeProfitPrice),
    stopLossPriceUsd: stopLossPrice == null ? null : formatMicroUsd(stopLossPrice),
  };
}

async function reconcilePendingBuys(env) {
  const query = await env.DB.prepare(`
    SELECT *
    FROM rebound_strategies
    WHERE status = 'BUY_TRIGGERED'
      AND pending_signature IS NOT NULL
    ORDER BY pending_action_started_at ASC
    LIMIT 20
  `).all();

  const rows = Array.isArray(query?.results) ? query.results : [];
  const results = [];
  for (const strategy of rows) {
    const signature = String(strategy.pending_signature || "");
    if (!isTransactionSignature(signature)) continue;
    const state = await getSignatureState(env, signature);
    if (state.confirmed) {
      results.push(await finalizeConfirmedBuy(env, strategy, signature));
    } else if (state.failed) {
      await env.DB.prepare(`
        UPDATE rebound_strategies
        SET pending_action = NULL,
            pending_signature = NULL,
            pending_action_started_at = NULL,
            execution_lock = NULL,
            execution_lock_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'BUY_TRIGGERED' AND pending_signature = ?
      `).bind(strategy.id, signature).run();
      results.push({ ok: false, failed: true, strategyId: strategy.id, signature, error: state.err });
    } else {
      results.push({ ok: true, pending: true, strategyId: strategy.id, signature, confirmationStatus: state.status });
    }
  }
  return results;
}

async function acquireBuyExecutionLock(env, strategyId) {
  const lock = crypto.randomUUID();
  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET execution_lock = ?,
        execution_lock_at = CURRENT_TIMESTAMP,
        pending_action = 'BUY_PREPARING',
        pending_action_started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'BUY_TRIGGERED'
      AND pending_signature IS NULL
      AND (
        execution_lock IS NULL
        OR execution_lock_at IS NULL
        OR execution_lock_at < datetime('now', '-' || ? || ' minutes')
      )
  `).bind(lock, strategyId, EXECUTION_LOCK_STALE_MINUTES).run();
  return Number(result?.meta?.changes ?? 0) > 0 ? lock : null;
}

async function releaseBuyExecutionLock(env, strategyId, lock, { rearm = false } = {}) {
  if (rearm) {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'WATCHING',
          buy_triggered_at = NULL,
          pending_action = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
    `).bind(strategyId, lock).run();
  } else {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
    `).bind(strategyId, lock).run();
  }
}

async function pauseAmbiguousBuy(env, strategyId, lock, reason) {
  await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'PAUSED',
        pending_action = ?,
        paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP),
        execution_lock = NULL,
        execution_lock_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
  `).bind(reason, strategyId, lock).run();
}

async function executeTriggeredBuy(env, strategy) {
  const lock = await acquireBuyExecutionLock(env, strategy.id);
  if (!lock) return { ok: true, skipped: true, strategyId: strategy.id, reason: "locked-or-pending" };

  try {
    const fresh = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategy.id).first();
    if (!fresh || fresh.status !== "BUY_TRIGGERED" || fresh.pending_signature) {
      await releaseBuyExecutionLock(env, strategy.id, lock);
      return { ok: true, skipped: true, strategyId: strategy.id, reason: "state-changed" };
    }

    const account = await getReboundAccount(env, fresh.privy_user_id);
    if (!account?.rebound_wallet_address) throw new Error("Rebound account not found for BUY execution.");
    const walletAddress = account.rebound_wallet_address;
    const cycleCapitalRaw = BigInt(String(fresh.current_cycle_capital_usdc_raw || 0));
    const triggerRaw = BigInt(String(fresh.buy_trigger_price_micro_usdc || 0));
    if (cycleCapitalRaw <= 0n || triggerRaw <= 0n) throw new Error("Strategy BUY capital or trigger is invalid.");

    const [referencePrice, usdc, nativeSol, tradingSol, reservedInUsdcRaw] = await Promise.all([
      getJupiterSolPriceMicroUsdc(env),
      getUsdcBalance(env, walletAddress),
      getSolBalance(env, walletAddress),
      getWsolTokenAccount(env, walletAddress),
      getUsdcHeldReservedCapitalRaw(env, fresh.privy_user_id),
    ]);

    // Never chase a price that has already rebounded above the trigger before the BUY is sent.
    if (referencePrice.micro > triggerRaw) {
      await releaseBuyExecutionLock(env, strategy.id, lock, { rearm: true });
      return {
        ok: true,
        rearmed: true,
        strategyId: strategy.id,
        currentPriceUsd: formatMicroUsd(referencePrice.micro),
        triggerPriceUsd: formatMicroUsd(triggerRaw),
        reason: "price-rebounded-before-execution",
      };
    }

    const walletUsdcRaw = BigInt(usdc.raw);
    const gasRaw = BigInt(nativeSol.raw);
    if (walletUsdcRaw < cycleCapitalRaw || walletUsdcRaw < reservedInUsdcRaw) {
      throw new Error("On-chain USDC no longer reconciles with reserved strategy capital.");
    }
    if (gasRaw < MIN_GAS_LAMPORTS) throw new Error("Gas reserve dropped below 0.005 SOL before BUY execution.");
    if (!tradingSol.ready || !tradingSol.address) throw new Error("WSOL trading account is not ready.");

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, fresh.privy_user_id, walletAddress);
    if (!delegatedWallet) throw new Error("Automated Trading is not enabled for this Rebound Wallet.");
    const walletId = account.rebound_wallet_id || delegatedWallet?.id || null;
    if (!walletId) throw new Error("Rebound Wallet ID is unavailable.");

    // Build the actual executable v0 transaction directly from Jupiter Swap API V2.
    const build = await getJupiterV2Build(env, {
      walletAddress,
      destinationTokenAccount: tradingSol.address,
      amountRaw: cycleCapitalRaw.toString(),
    });

    if (
      build.inputMint !== USDC_MINT ||
      build.outputMint !== WSOL_MINT ||
      String(build.inAmount) !== cycleCapitalRaw.toString()
    ) {
      throw new Error("Jupiter V2 returned a BUY route that does not match the requested strategy trade.");
    }

    const buildPrograms = instructionProgramIds(build);
    const allowedPrograms = new Set([
      COMPUTE_BUDGET_PROGRAM_ID,
      JUPITER_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ]);
    const unexpectedBuildPrograms = buildPrograms.filter((id) => !allowedPrograms.has(id));
    if (!buildPrograms.includes(JUPITER_PROGRAM_ID) || unexpectedBuildPrograms.length > 0 || build?.tipInstruction) {
      const error = new Error(`V2 safety gate rejected BUY route. Unexpected programs: ${unexpectedBuildPrograms.join(", ") || "none"}`);
      error.code = "POLICY_ROUTE_MISMATCH";
      error.programs = buildPrograms;
      error.unexpectedPrograms = unexpectedBuildPrograms;
      throw error;
    }

    const builtOutRaw = BigInt(String(build.outAmount || 0));
    const expectedOutRaw = referencePrice.micro > 0n
      ? cycleCapitalRaw * (10n ** BigInt(SOL_DECIMALS)) / referencePrice.micro
      : 0n;
    const buildShortfallBps = expectedOutRaw > 0n && builtOutRaw < expectedOutRaw
      ? Number((expectedOutRaw - builtOutRaw) * 10_000n / expectedOutRaw)
      : 0;
    if (builtOutRaw <= 0n || buildShortfallBps > MAX_ROUTE_REFERENCE_SHORTFALL_BPS) {
      throw new Error("V2 BUY route failed the reference-price sanity check.");
    }

    const quotePriceMicro = builtOutRaw > 0n
      ? cycleCapitalRaw * 1_000_000_000n / builtOutRaw
      : 0n;
    const maxAllowedQuotePrice = triggerRaw * BigInt(10_000 + MAX_BUY_TRIGGER_OVERAGE_BPS) / 10_000n;
    if (quotePriceMicro <= 0n || quotePriceMicro > maxAllowedQuotePrice) {
      await releaseBuyExecutionLock(env, strategy.id, lock);
      return {
        ok: false,
        skipped: true,
        strategyId: strategy.id,
        reason: "quote-price-above-trigger-safety-limit",
        triggerPriceUsd: formatMicroUsd(triggerRaw),
        quotePriceUsd: formatMicroUsd(quotePriceMicro),
      };
    }

    const executable = await buildJupiterV2BuyTransaction(env, {
      build,
      walletAddress,
    });

    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = 'BUY_SENDING',
          pending_action_started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND status = 'BUY_TRIGGERED' AND pending_signature IS NULL
    `).bind(strategy.id, lock).run();

    let sendResult;
    try {
      sendResult = await privy.wallets().solana().signAndSendTransaction(walletId, {
        caip2: SOLANA_MAINNET_CAIP2,
        transaction: executable.swapTransaction,
        authorization_context: createAuthorizationContext(env),
      });
    } catch (error) {
      const info = getSafePrivyError(error);
      if (looksLikePolicyDenial(info)) {
        await releaseBuyExecutionLock(env, strategy.id, lock);
        return { ok: false, strategyId: strategy.id, policyDenied: true, error: info };
      }

      // A transport/provider error can be ambiguous: the transaction may have been broadcast
      // even if the response was lost. Pause instead of risking a second BUY.
      await pauseAmbiguousBuy(env, strategy.id, lock, "BUY_SEND_UNKNOWN");
      return { ok: false, paused: true, ambiguous: true, strategyId: strategy.id, error: info };
    }

    const signature = extractPrivyTxHash(sendResult);
    if (!signature || !isTransactionSignature(signature)) {
      await pauseAmbiguousBuy(env, strategy.id, lock, "BUY_SIGNATURE_UNKNOWN");
      return { ok: false, paused: true, ambiguous: true, strategyId: strategy.id, message: "Privy did not return a valid Solana signature." };
    }

    const stored = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = 'BUY_SUBMITTED',
          pending_signature = ?,
          pending_action_started_at = CURRENT_TIMESTAMP,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND status = 'BUY_TRIGGERED' AND pending_signature IS NULL
    `).bind(signature, strategy.id, lock).run();

    if (Number(stored?.meta?.changes ?? 0) === 0) {
      console.error("BUY signature was returned but D1 signature persistence did not update the strategy", strategy.id, signature);
      return { ok: false, ambiguous: true, strategyId: strategy.id, signature, message: "BUY was submitted but D1 persistence needs reconciliation." };
    }

    // Fast-path confirmation. If indexing is not ready yet, the next cron safely reconciles it.
    await sleep(1500);
    const state = await getSignatureState(env, signature);
    if (state.confirmed) {
      const currentStrategy = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategy.id).first();
      return await finalizeConfirmedBuy(env, currentStrategy, signature);
    }

    return { ok: true, submitted: true, pending: true, strategyId: strategy.id, signature, confirmationStatus: state.status };
  } catch (error) {
    console.error("BUY executor error:", strategy.id, error);
    await releaseBuyExecutionLock(env, strategy.id, lock);
    return {
      ok: false,
      strategyId: strategy.id,
      code: error?.code || null,
      message: error?.message || "BUY execution failed before submission.",
      programs: error?.programs || undefined,
      unexpectedPrograms: error?.unexpectedPrograms || undefined,
    };
  }
}

async function quarantineStaleAmbiguousBuys(env) {
  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'PAUSED',
        pending_action = 'BUY_SEND_UNKNOWN',
        paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP),
        execution_lock = NULL,
        execution_lock_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'BUY_TRIGGERED'
      AND pending_signature IS NULL
      AND pending_action = 'BUY_SENDING'
      AND pending_action_started_at IS NOT NULL
      AND pending_action_started_at < datetime('now', '-' || ? || ' minutes')
  `).bind(EXECUTION_LOCK_STALE_MINUTES).run();
  return Number(result?.meta?.changes ?? 0);
}

async function runBuyExecutor(env, { source = "cron" } = {}) {
  const quarantined = await quarantineStaleAmbiguousBuys(env);
  const reconciled = await reconcilePendingBuys(env);

  if (!autoExecutionRequested(env)) {
    return {
      ok: true,
      source,
      liveExecutionImplemented: true,
      autoExecutionEnabled: false,
      newBuysAttempted: 0,
      quarantinedAmbiguousBuys: quarantined,
      reconciled,
      message: "BUY executor is installed but AUTO_EXECUTION_ENABLED is not true. No new BUY was sent.",
    };
  }

  const query = await env.DB.prepare(`
    SELECT *
    FROM rebound_strategies
    WHERE status = 'BUY_TRIGGERED'
      AND pending_signature IS NULL
      AND (pending_action IS NULL OR pending_action = 'BUY_PREPARING')
    ORDER BY buy_triggered_at ASC, created_at ASC
    LIMIT ?
  `).bind(MAX_BUY_EXECUTIONS_PER_CRON).all();
  const rows = Array.isArray(query?.results) ? query.results : [];

  const executions = [];
  for (const strategy of rows) {
    executions.push(await executeTriggeredBuy(env, strategy));
  }

  return {
    ok: true,
    source,
    liveExecutionImplemented: true,
    autoExecutionEnabled: true,
    newBuysAttempted: rows.length,
    quarantinedAmbiguousBuys: quarantined,
    reconciled,
    executions,
  };
}


let cycleHistoryTableReady = false;

async function ensureCycleHistoryTable(env) {
  if (cycleHistoryTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rebound_cycles (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      privy_user_id TEXT NOT NULL,
      rebound_wallet_address TEXT NOT NULL,
      asset_symbol TEXT NOT NULL DEFAULT 'SOL',
      cycle_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      exit_reason TEXT,
      capital_usdc_raw INTEGER NOT NULL,
      spent_usdc_raw INTEGER,
      received_usdc_raw INTEGER,
      entry_asset_raw INTEGER,
      buy_fill_price_micro_usdc INTEGER,
      sell_fill_price_micro_usdc INTEGER,
      realized_pnl_usdc_raw INTEGER,
      realized_pnl_bps INTEGER,
      buy_signature TEXT,
      sell_signature TEXT,
      buy_triggered_at TEXT,
      bought_at TEXT,
      sell_triggered_at TEXT,
      sold_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rebound_cycles_strategy_cycle ON rebound_cycles (strategy_id, cycle_number)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_rebound_cycles_user ON rebound_cycles (privy_user_id)`).run();
  cycleHistoryTableReady = true;
}

function normalizeCycleRow(row) {
  if (!row) return null;
  const raw = (value) => value == null ? null : String(value);
  const usdc = (value) => value == null ? null : formatUnits(BigInt(String(value)), USDC_DECIMALS);
  return {
    id: row.id,
    strategyId: row.strategy_id,
    cycleNumber: Number(row.cycle_number || 1),
    status: row.status,
    exitReason: row.exit_reason || null,
    capitalUsdcRaw: raw(row.capital_usdc_raw),
    capitalUsdc: usdc(row.capital_usdc_raw),
    spentUsdcRaw: raw(row.spent_usdc_raw),
    spentUsdc: usdc(row.spent_usdc_raw),
    receivedUsdcRaw: raw(row.received_usdc_raw),
    receivedUsdc: usdc(row.received_usdc_raw),
    entryAssetRaw: raw(row.entry_asset_raw),
    buyFillPriceUsd: formatMicroUsd(row.buy_fill_price_micro_usdc),
    sellFillPriceUsd: formatMicroUsd(row.sell_fill_price_micro_usdc),
    realizedPnlUsdcRaw: raw(row.realized_pnl_usdc_raw),
    realizedPnlUsdc: usdc(row.realized_pnl_usdc_raw),
    realizedPnlBps: row.realized_pnl_bps == null ? null : Number(row.realized_pnl_bps),
    buySignature: row.buy_signature || null,
    sellSignature: row.sell_signature || null,
    buyTriggeredAt: row.buy_triggered_at || null,
    boughtAt: row.bought_at || null,
    sellTriggeredAt: row.sell_triggered_at || null,
    soldAt: row.sold_at || null,
  };
}

async function ensureOpenCycleFromBoughtStrategy(env, strategy) {
  await ensureCycleHistoryTable(env);
  const cycleNumber = Number(strategy.cycle_number || 1);
  const cycleId = `${strategy.id}:${cycleNumber}`;
  const existing = await env.DB.prepare(`SELECT * FROM rebound_cycles WHERE id = ? LIMIT 1`).bind(cycleId).first();
  if (existing) return existing;

  const legacyBuySignature = strategy.status === 'BOUGHT' && isTransactionSignature(String(strategy.pending_signature || ""))
    ? String(strategy.pending_signature)
    : null;

  await env.DB.prepare(`
    INSERT OR IGNORE INTO rebound_cycles (
      id, strategy_id, privy_user_id, rebound_wallet_address, asset_symbol,
      cycle_number, status, capital_usdc_raw, spent_usdc_raw, entry_asset_raw,
      buy_fill_price_micro_usdc, buy_signature, buy_triggered_at, bought_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SOL', ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    cycleId,
    strategy.id,
    strategy.privy_user_id,
    strategy.rebound_wallet_address,
    cycleNumber,
    String(strategy.current_cycle_capital_usdc_raw || 0),
    String(strategy.current_cycle_capital_usdc_raw || 0),
    String(strategy.entry_wsol_raw || 0),
    strategy.buy_fill_price_micro_usdc == null ? null : String(strategy.buy_fill_price_micro_usdc),
    legacyBuySignature,
    strategy.buy_triggered_at || null,
    strategy.bought_at || null,
  ).run();

  if (legacyBuySignature && strategy.status === 'BOUGHT' && !strategy.pending_action) {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_signature = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'BOUGHT' AND pending_signature = ?
    `).bind(strategy.id, legacyBuySignature).run();
  }

  return env.DB.prepare(`SELECT * FROM rebound_cycles WHERE id = ? LIMIT 1`).bind(cycleId).first();
}

async function loadBoughtStrategies(env) {
  const result = await env.DB.prepare(`
    SELECT *
    FROM rebound_strategies
    WHERE status = 'BOUGHT'
      AND asset_symbol = 'SOL'
      AND entry_wsol_raw IS NOT NULL
      AND entry_wsol_raw > 0
    ORDER BY bought_at ASC, created_at ASC
  `).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function runPositionWatcher(env, { source = "cron" } = {}) {
  const strategies = await loadBoughtStrategies(env);
  if (strategies.length === 0) {
    return { ok: true, source, checked: 0, updated: 0, takeProfitTriggered: 0, stopLossTriggered: 0, message: "No open SOL positions found." };
  }

  let priceInfo = await getJupiterSolPriceMicroUsdc(env);
  let needsConfirmation = false;
  for (const strategy of strategies) {
    if (strategy.current_price_micro_usdc != null && priceMoveFraction(strategy.current_price_micro_usdc, priceInfo.micro) > 0.20) {
      needsConfirmation = true;
      break;
    }
  }
  if (needsConfirmation) {
    await sleep(1200);
    const second = await getJupiterSolPriceMicroUsdc(env);
    if (priceMoveFraction(priceInfo.micro, second.micro) > 0.02) {
      throw new Error("Position watcher rejected an unstable >20% price move. No sell trigger was changed.");
    }
    priceInfo = second;
  }

  const current = priceInfo.micro;
  let updated = 0;
  let takeProfitTriggered = 0;
  let stopLossTriggered = 0;

  for (const strategy of strategies) {
    await ensureOpenCycleFromBoughtStrategy(env, strategy);
    const tp = strategy.take_profit_price_micro_usdc == null ? null : BigInt(String(strategy.take_profit_price_micro_usdc));
    const sl = Number(strategy.stop_loss_enabled) === 1 && strategy.stop_loss_price_micro_usdc != null
      ? BigInt(String(strategy.stop_loss_price_micro_usdc))
      : null;

    let reason = null;
    if (tp != null && current >= tp) reason = "TP";
    else if (sl != null && current <= sl) reason = "SL";

    let result;
    if (reason) {
      result = await env.DB.prepare(`
        UPDATE rebound_strategies
        SET status = 'SELL_TRIGGERED',
            current_price_micro_usdc = ?,
            sell_triggered_at = COALESCE(sell_triggered_at, CURRENT_TIMESTAMP),
            last_price_at = CURRENT_TIMESTAMP,
            pending_action = ?,
            pending_action_started_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'BOUGHT'
      `).bind(
        current.toString(),
        reason === "TP" ? "SELL_TRIGGERED_TP" : "SELL_TRIGGERED_SL",
        strategy.id,
      ).run();
    } else {
      result = await env.DB.prepare(`
        UPDATE rebound_strategies
        SET current_price_micro_usdc = ?,
            last_price_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'BOUGHT'
      `).bind(current.toString(), strategy.id).run();
    }

    const changed = Number(result?.meta?.changes ?? 0);
    updated += changed;
    if (changed > 0 && reason === "TP") takeProfitTriggered += changed;
    if (changed > 0 && reason === "SL") stopLossTriggered += changed;
  }

  return {
    ok: true,
    source,
    checked: strategies.length,
    updated,
    takeProfitTriggered,
    stopLossTriggered,
    currentPriceUsd: formatMicroUsd(current),
    checkedAt: new Date().toISOString(),
  };
}

function getSellReason(strategy) {
  const action = String(strategy?.pending_action || "").toUpperCase();
  if (action.includes("_STOP")) return "MANUAL_STOP";
  return action.includes("_SL") ? "STOP_LOSS" : "TAKE_PROFIT";
}

async function getDeployedWsolRaw(env, privyUserId) {
  const row = await env.DB.prepare(`
    SELECT CAST(COALESCE(SUM(entry_wsol_raw), 0) AS TEXT) AS deployed_raw
    FROM rebound_strategies
    WHERE privy_user_id = ?
      AND entry_wsol_raw IS NOT NULL
      AND entry_wsol_raw > 0
      AND status IN ('BOUGHT', 'SELL_TRIGGERED', 'PAUSED')
  `).bind(privyUserId).first();
  return BigInt(String(row?.deployed_raw ?? 0));
}

async function getConfirmedSellFill(env, signature, walletAddress) {
  const tx = await heliusRpc(env, "getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx?.meta) return null;
  if (tx.meta.err) return { failed: true, error: tx.meta.err };

  const preUsdc = sumOwnerTokenBalanceRaw(tx.meta.preTokenBalances, USDC_MINT, walletAddress);
  const postUsdc = sumOwnerTokenBalanceRaw(tx.meta.postTokenBalances, USDC_MINT, walletAddress);
  const preWsol = sumOwnerTokenBalanceRaw(tx.meta.preTokenBalances, WSOL_MINT, walletAddress);
  const postWsol = sumOwnerTokenBalanceRaw(tx.meta.postTokenBalances, WSOL_MINT, walletAddress);
  if ((preUsdc.matches + postUsdc.matches) === 0 || (preWsol.matches + postWsol.matches) === 0) return null;

  const soldWsolRaw = preWsol.total > postWsol.total ? preWsol.total - postWsol.total : 0n;
  const receivedUsdcRaw = postUsdc.total > preUsdc.total ? postUsdc.total - preUsdc.total : 0n;
  if (soldWsolRaw <= 0n || receivedUsdcRaw <= 0n) return null;

  const fillPriceMicroUsdc = receivedUsdcRaw * 1_000_000_000n / soldWsolRaw;
  return {
    failed: false,
    soldWsolRaw,
    receivedUsdcRaw,
    fillPriceMicroUsdc,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ?? null,
  };
}

async function finalizeConfirmedSell(env, strategy, signature) {
  const fill = await getConfirmedSellFill(env, signature, strategy.rebound_wallet_address);
  if (!fill) {
    return { ok: false, pending: true, strategyId: strategy.id, signature, message: "Confirmed SELL is not fully indexed yet." };
  }
  if (fill.failed) {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_signature = NULL,
          pending_action = CASE
            WHEN pending_action LIKE '%_STOP_%' OR pending_action LIKE '%_STOP' THEN 'SELL_TRIGGERED_STOP'
            WHEN pending_action LIKE '%_SL_%' OR pending_action LIKE '%_SL' THEN 'SELL_TRIGGERED_SL'
            ELSE 'SELL_TRIGGERED_TP'
          END,
          pending_action_started_at = CURRENT_TIMESTAMP,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
    `).bind(strategy.id, signature).run();
    return { ok: false, failed: true, strategyId: strategy.id, signature, message: "SELL failed on-chain and was released for a fresh retry." };
  }

  await ensureCycleHistoryTable(env);
  const cycle = await ensureOpenCycleFromBoughtStrategy(env, strategy);
  const reason = getSellReason(strategy);
  const spentUsdcRaw = BigInt(String(cycle?.spent_usdc_raw ?? strategy.current_cycle_capital_usdc_raw ?? 0));
  const pnlRaw = fill.receivedUsdcRaw - spentUsdcRaw;
  const pnlBps = spentUsdcRaw > 0n ? Number(pnlRaw * 10_000n / spentUsdcRaw) : 0;
  const cycleId = `${strategy.id}:${Number(strategy.cycle_number || 1)}`;

  await env.DB.prepare(`
    UPDATE rebound_cycles
    SET status = 'COMPLETED',
        exit_reason = ?,
        received_usdc_raw = ?,
        sell_fill_price_micro_usdc = ?,
        realized_pnl_usdc_raw = ?,
        realized_pnl_bps = ?,
        sell_signature = ?,
        sell_triggered_at = ?,
        sold_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    reason,
    fill.receivedUsdcRaw.toString(),
    fill.fillPriceMicroUsdc.toString(),
    pnlRaw.toString(),
    pnlBps,
    signature,
    strategy.sell_triggered_at || null,
    cycleId,
  ).run();

  const existingFreeProfit = BigInt(String(strategy.free_profit_usdc_raw || 0));

  if (reason === "MANUAL_STOP") {
    const releasedProfit = pnlRaw > 0n ? pnlRaw : 0n;
    const result = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'STOPPED',
          reserved_capital_usdc_raw = 0,
          current_cycle_capital_usdc_raw = 0,
          free_profit_usdc_raw = ?,
          entry_wsol_raw = NULL,
          current_price_micro_usdc = ?,
          hwm_price_micro_usdc = NULL,
          buy_trigger_price_micro_usdc = NULL,
          pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          sold_at = CURRENT_TIMESTAMP,
          stopped_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
    `).bind(
      (existingFreeProfit + releasedProfit).toString(),
      fill.fillPriceMicroUsdc.toString(),
      strategy.id,
      signature,
    ).run();
    return {
      ok: Number(result?.meta?.changes ?? 0) > 0,
      finalized: true,
      strategyId: strategy.id,
      signature,
      exitReason: reason,
      sellFillPriceUsd: formatMicroUsd(fill.fillPriceMicroUsdc),
      receivedUsdc: formatUnits(fill.receivedUsdcRaw, USDC_DECIMALS),
      realizedPnlUsdc: formatUnits(pnlRaw, USDC_DECIMALS),
      nextStatus: "STOPPED",
    };
  }

  if (reason === "STOP_LOSS") {
    const result = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'PAUSED',
          reserved_capital_usdc_raw = ?,
          current_cycle_capital_usdc_raw = ?,
          entry_wsol_raw = NULL,
          current_price_micro_usdc = ?,
          hwm_price_micro_usdc = NULL,
          buy_trigger_price_micro_usdc = NULL,
          pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          paused_at = CURRENT_TIMESTAMP,
          sold_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
    `).bind(
      fill.receivedUsdcRaw.toString(),
      fill.receivedUsdcRaw.toString(),
      fill.fillPriceMicroUsdc.toString(),
      strategy.id,
      signature,
    ).run();
    return {
      ok: Number(result?.meta?.changes ?? 0) > 0,
      finalized: true,
      strategyId: strategy.id,
      signature,
      exitReason: reason,
      sellFillPriceUsd: formatMicroUsd(fill.fillPriceMicroUsdc),
      receivedUsdc: formatUnits(fill.receivedUsdcRaw, USDC_DECIMALS),
      realizedPnlUsdc: formatUnits(pnlRaw, USDC_DECIMALS),
      nextStatus: "PAUSED",
    };
  }

  const autoRepeat = Number(strategy.auto_repeat) === 1;
  const compound = Number(strategy.compound) === 1;

  if (!autoRepeat) {
    const releasedProfit = pnlRaw > 0n ? pnlRaw : 0n;
    const result = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'COMPLETED',
          reserved_capital_usdc_raw = 0,
          current_cycle_capital_usdc_raw = 0,
          free_profit_usdc_raw = ?,
          entry_wsol_raw = NULL,
          current_price_micro_usdc = ?,
          hwm_price_micro_usdc = ?,
          buy_trigger_price_micro_usdc = NULL,
          pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          sold_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
    `).bind(
      (existingFreeProfit + releasedProfit).toString(),
      fill.fillPriceMicroUsdc.toString(),
      fill.fillPriceMicroUsdc.toString(),
      strategy.id,
      signature,
    ).run();
    return {
      ok: Number(result?.meta?.changes ?? 0) > 0,
      finalized: true,
      strategyId: strategy.id,
      signature,
      exitReason: reason,
      sellFillPriceUsd: formatMicroUsd(fill.fillPriceMicroUsdc),
      receivedUsdc: formatUnits(fill.receivedUsdcRaw, USDC_DECIMALS),
      realizedPnlUsdc: formatUnits(pnlRaw, USDC_DECIMALS),
      nextStatus: "COMPLETED",
    };
  }

  let nextCapitalRaw;
  let releasedProfitRaw = 0n;
  if (compound) {
    nextCapitalRaw = fill.receivedUsdcRaw;
  } else {
    const initialRaw = BigInt(String(strategy.initial_capital_usdc_raw || 0));
    nextCapitalRaw = fill.receivedUsdcRaw < initialRaw ? fill.receivedUsdcRaw : initialRaw;
    releasedProfitRaw = fill.receivedUsdcRaw > initialRaw ? fill.receivedUsdcRaw - initialRaw : 0n;
  }

  const nextHwm = fill.fillPriceMicroUsdc;
  const nextBuyTrigger = nextHwm * (10_000n - BigInt(Number(strategy.dip_bps))) / 10_000n;
  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'WATCHING',
        reserved_capital_usdc_raw = ?,
        current_cycle_capital_usdc_raw = ?,
        free_profit_usdc_raw = ?,
        hwm_price_micro_usdc = ?,
        current_price_micro_usdc = ?,
        buy_trigger_price_micro_usdc = ?,
        buy_fill_price_micro_usdc = NULL,
        take_profit_price_micro_usdc = NULL,
        stop_loss_price_micro_usdc = NULL,
        entry_wsol_raw = NULL,
        cycle_number = cycle_number + 1,
        buy_triggered_at = NULL,
        bought_at = NULL,
        sell_triggered_at = NULL,
        sold_at = NULL,
        paused_at = NULL,
        pending_action = NULL,
        pending_signature = NULL,
        pending_action_started_at = NULL,
        execution_lock = NULL,
        execution_lock_at = NULL,
        last_price_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
  `).bind(
    nextCapitalRaw.toString(),
    nextCapitalRaw.toString(),
    (existingFreeProfit + releasedProfitRaw).toString(),
    nextHwm.toString(),
    nextHwm.toString(),
    nextBuyTrigger.toString(),
    strategy.id,
    signature,
  ).run();

  return {
    ok: Number(result?.meta?.changes ?? 0) > 0,
    finalized: true,
    strategyId: strategy.id,
    signature,
    exitReason: reason,
    sellFillPriceUsd: formatMicroUsd(fill.fillPriceMicroUsdc),
    receivedUsdc: formatUnits(fill.receivedUsdcRaw, USDC_DECIMALS),
    realizedPnlUsdc: formatUnits(pnlRaw, USDC_DECIMALS),
    nextStatus: "WATCHING",
    nextCycleCapitalUsdc: formatUnits(nextCapitalRaw, USDC_DECIMALS),
    releasedProfitUsdc: formatUnits(releasedProfitRaw, USDC_DECIMALS),
  };
}

async function reconcilePendingSells(env) {
  const query = await env.DB.prepare(`
    SELECT * FROM rebound_strategies
    WHERE status = 'SELL_TRIGGERED'
      AND pending_signature IS NOT NULL
    ORDER BY pending_action_started_at ASC
    LIMIT 20
  `).all();
  const rows = Array.isArray(query?.results) ? query.results : [];
  const results = [];
  for (const strategy of rows) {
    const signature = String(strategy.pending_signature || "");
    if (!isTransactionSignature(signature)) continue;
    const state = await getSignatureState(env, signature);
    if (state.confirmed) results.push(await finalizeConfirmedSell(env, strategy, signature));
    else if (state.failed) {
      await env.DB.prepare(`
        UPDATE rebound_strategies
        SET pending_signature = NULL,
            pending_action = CASE
            WHEN pending_action LIKE '%_STOP_%' OR pending_action LIKE '%_STOP' THEN 'SELL_TRIGGERED_STOP'
            WHEN pending_action LIKE '%_SL_%' OR pending_action LIKE '%_SL' THEN 'SELL_TRIGGERED_SL'
            ELSE 'SELL_TRIGGERED_TP'
          END,
            pending_action_started_at = CURRENT_TIMESTAMP,
            execution_lock = NULL,
            execution_lock_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'SELL_TRIGGERED' AND pending_signature = ?
      `).bind(strategy.id, signature).run();
      results.push({ ok: false, failed: true, strategyId: strategy.id, signature, error: state.err });
    } else {
      results.push({ ok: true, pending: true, strategyId: strategy.id, signature, confirmationStatus: state.status });
    }
  }
  return results;
}

async function acquireSellExecutionLock(env, strategy) {
  const lock = crypto.randomUUID();
  const sellReason = getSellReason(strategy);
  const reason = sellReason === "STOP_LOSS" ? "SL" : sellReason === "MANUAL_STOP" ? "STOP" : "TP";
  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET execution_lock = ?,
        execution_lock_at = CURRENT_TIMESTAMP,
        pending_action = ?,
        pending_action_started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'SELL_TRIGGERED'
      AND pending_signature IS NULL
      AND pending_action IN ('SELL_TRIGGERED_TP', 'SELL_TRIGGERED_SL', 'SELL_TRIGGERED_STOP')
      AND (execution_lock IS NULL OR execution_lock_at IS NULL OR execution_lock_at < datetime('now', '-' || ? || ' minutes'))
  `).bind(lock, `SELL_${reason}_PREPARING`, strategy.id, EXECUTION_LOCK_STALE_MINUTES).run();
  return Number(result?.meta?.changes ?? 0) > 0 ? { lock, reason } : null;
}

async function releaseSellExecutionLock(env, strategyId, lock, reason, { rearm = false } = {}) {
  if (rearm) {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'BOUGHT',
          sell_triggered_at = NULL,
          pending_action = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
    `).bind(strategyId, lock).run();
  } else {
    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = ?,
          pending_action_started_at = CURRENT_TIMESTAMP,
          execution_lock = NULL,
          execution_lock_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
    `).bind(reason === "SL" ? "SELL_TRIGGERED_SL" : reason === "STOP" ? "SELL_TRIGGERED_STOP" : "SELL_TRIGGERED_TP", strategyId, lock).run();
  }
}

async function pauseAmbiguousSell(env, strategyId, lock, reason, failureCode) {
  await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'PAUSED',
        pending_action = ?,
        paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP),
        execution_lock = NULL,
        execution_lock_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND execution_lock = ? AND pending_signature IS NULL
  `).bind(`SELL_${reason}_${failureCode}`, strategyId, lock).run();
}

async function executeTriggeredSell(env, strategy) {
  const acquired = await acquireSellExecutionLock(env, strategy);
  if (!acquired) return { ok: true, skipped: true, strategyId: strategy.id, reason: "execution-lock-not-acquired" };
  const { lock, reason } = acquired;

  try {
    const fresh = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategy.id).first();
    if (!fresh || fresh.status !== "SELL_TRIGGERED" || fresh.pending_signature) {
      await releaseSellExecutionLock(env, strategy.id, lock, reason);
      return { ok: true, skipped: true, strategyId: strategy.id, reason: "strategy-no-longer-eligible" };
    }

    const amountRaw = BigInt(String(fresh.entry_wsol_raw || 0));
    if (amountRaw <= 0n) throw new Error("SELL strategy does not contain a valid deployed SOL amount.");

    const walletAddress = fresh.rebound_wallet_address;
    const account = await getReboundAccount(env, fresh.privy_user_id);
    if (!account?.rebound_wallet_address || account.rebound_wallet_address !== walletAddress) throw new Error("Rebound account mapping changed before SELL execution.");

    const [nativeSol, tradingSol, usdcToken, deployedWsolRaw, referencePrice] = await Promise.all([
      getSolBalance(env, walletAddress),
      getWsolTokenAccount(env, walletAddress),
      getUsdcTokenAccount(env, walletAddress),
      getDeployedWsolRaw(env, fresh.privy_user_id),
      getJupiterSolPriceMicroUsdc(env),
    ]);

    if (BigInt(nativeSol.raw) < MIN_GAS_LAMPORTS) throw new Error("Gas reserve dropped below 0.005 SOL before SELL execution.");
    if (!tradingSol.ready || !tradingSol.address) throw new Error("WSOL trading account is not ready for SELL execution.");
    if (!usdcToken.ready || !usdcToken.address) throw new Error("USDC token account is not ready for SELL execution.");
    const walletWsolRaw = BigInt(String(tradingSol.raw || 0));
    if (walletWsolRaw < amountRaw || walletWsolRaw < deployedWsolRaw) throw new Error("On-chain WSOL no longer reconciles with deployed strategy positions.");

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, fresh.privy_user_id, walletAddress);
    if (!delegatedWallet) throw new Error("Automated Trading is not enabled for this Rebound Wallet.");
    const walletId = account.rebound_wallet_id || delegatedWallet?.id || null;
    if (!walletId) throw new Error("Rebound Wallet ID is unavailable.");

    const build = await getJupiterV2SellBuild(env, {
      walletAddress,
      destinationTokenAccount: usdcToken.address,
      amountRaw: amountRaw.toString(),
    });
    if (build.inputMint !== WSOL_MINT || build.outputMint !== USDC_MINT || String(build.inAmount) !== amountRaw.toString()) {
      throw new Error("Jupiter V2 returned a SELL route that does not match the open strategy position.");
    }

    const programs = instructionProgramIds(build);
    const allowedPrograms = new Set([COMPUTE_BUDGET_PROGRAM_ID, JUPITER_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]);
    const unexpectedPrograms = programs.filter((id) => !allowedPrograms.has(id));
    if (!programs.includes(JUPITER_PROGRAM_ID) || unexpectedPrograms.length > 0 || build?.tipInstruction) {
      const error = new Error(`V2 safety gate rejected SELL route. Unexpected programs: ${unexpectedPrograms.join(", ") || "none"}`);
      error.code = "POLICY_ROUTE_MISMATCH";
      error.programs = programs;
      error.unexpectedPrograms = unexpectedPrograms;
      throw error;
    }

    const outRaw = BigInt(String(build.outAmount || 0));
    const expectedUsdcRaw = amountRaw * referencePrice.micro / 1_000_000_000n;
    const shortfallBps = expectedUsdcRaw > 0n && outRaw < expectedUsdcRaw
      ? Number((expectedUsdcRaw - outRaw) * 10_000n / expectedUsdcRaw)
      : 0;
    if (outRaw <= 0n || shortfallBps > MAX_ROUTE_REFERENCE_SHORTFALL_BPS) throw new Error("V2 SELL route failed the reference-price sanity check.");

    const quotePriceMicro = outRaw * 1_000_000_000n / amountRaw;
    if (reason === "TP") {
      const tpRaw = BigInt(String(fresh.take_profit_price_micro_usdc || 0));
      const minAllowed = tpRaw * BigInt(10_000 - MAX_TP_QUOTE_UNDERAGE_BPS) / 10_000n;
      if (tpRaw <= 0n || quotePriceMicro < minAllowed) {
        await releaseSellExecutionLock(env, strategy.id, lock, reason, { rearm: true });
        return {
          ok: false,
          skipped: true,
          strategyId: strategy.id,
          reason: "take-profit-quote-no-longer-good-enough",
          targetPriceUsd: formatMicroUsd(tpRaw),
          quotePriceUsd: formatMicroUsd(quotePriceMicro),
        };
      }
    }

    const executable = await buildJupiterV2BuyTransaction(env, { build, walletAddress });

    await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = ?, pending_action_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND status = 'SELL_TRIGGERED' AND pending_signature IS NULL
    `).bind(`SELL_${reason}_SENDING`, strategy.id, lock).run();

    let sendResult;
    try {
      sendResult = await privy.wallets().solana().signAndSendTransaction(walletId, {
        caip2: SOLANA_MAINNET_CAIP2,
        transaction: executable.swapTransaction,
        authorization_context: createAuthorizationContext(env),
      });
    } catch (error) {
      const info = getSafePrivyError(error);
      if (looksLikePolicyDenial(info)) {
        await releaseSellExecutionLock(env, strategy.id, lock, reason);
        return { ok: false, strategyId: strategy.id, policyDenied: true, error: info };
      }
      await pauseAmbiguousSell(env, strategy.id, lock, reason, "SEND_UNKNOWN");
      return { ok: false, paused: true, ambiguous: true, strategyId: strategy.id, error: info };
    }

    const signature = extractPrivyTxHash(sendResult);
    if (!signature || !isTransactionSignature(signature)) {
      await pauseAmbiguousSell(env, strategy.id, lock, reason, "SIGNATURE_UNKNOWN");
      return { ok: false, paused: true, ambiguous: true, strategyId: strategy.id, message: "Privy did not return a valid Solana SELL signature." };
    }

    const stored = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET pending_action = ?, pending_signature = ?, pending_action_started_at = CURRENT_TIMESTAMP,
          execution_lock = NULL, execution_lock_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND execution_lock = ? AND status = 'SELL_TRIGGERED' AND pending_signature IS NULL
    `).bind(`SELL_${reason}_SUBMITTED`, signature, strategy.id, lock).run();
    if (Number(stored?.meta?.changes ?? 0) === 0) {
      console.error("SELL signature returned but D1 persistence did not update strategy", strategy.id, signature);
      return { ok: false, ambiguous: true, strategyId: strategy.id, signature, message: "SELL was submitted but D1 persistence needs reconciliation." };
    }

    await sleep(1500);
    const state = await getSignatureState(env, signature);
    if (state.confirmed) {
      const currentStrategy = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategy.id).first();
      return finalizeConfirmedSell(env, currentStrategy, signature);
    }
    return { ok: true, submitted: true, pending: true, strategyId: strategy.id, signature, confirmationStatus: state.status };
  } catch (error) {
    console.error("SELL executor error:", strategy.id, error);
    await releaseSellExecutionLock(env, strategy.id, lock, reason);
    return {
      ok: false,
      strategyId: strategy.id,
      code: error?.code || null,
      message: error?.message || "SELL execution failed before submission.",
      programs: error?.programs || undefined,
      unexpectedPrograms: error?.unexpectedPrograms || undefined,
    };
  }
}

async function quarantineStaleAmbiguousSells(env) {
  const result = await env.DB.prepare(`
    UPDATE rebound_strategies
    SET status = 'PAUSED',
        pending_action = CASE
          WHEN pending_action LIKE '%_STOP_%' THEN 'SELL_STOP_SEND_UNKNOWN'
          WHEN pending_action LIKE '%_SL_%' THEN 'SELL_SL_SEND_UNKNOWN'
          ELSE 'SELL_TP_SEND_UNKNOWN'
        END,
        paused_at = COALESCE(paused_at, CURRENT_TIMESTAMP),
        execution_lock = NULL,
        execution_lock_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'SELL_TRIGGERED'
      AND pending_signature IS NULL
      AND pending_action IN ('SELL_TP_SENDING', 'SELL_SL_SENDING')
      AND pending_action_started_at IS NOT NULL
      AND pending_action_started_at < datetime('now', '-' || ? || ' minutes')
  `).bind(EXECUTION_LOCK_STALE_MINUTES).run();
  return Number(result?.meta?.changes ?? 0);
}

async function runSellExecutor(env, { source = "cron" } = {}) {
  const quarantined = await quarantineStaleAmbiguousSells(env);
  const reconciled = await reconcilePendingSells(env);
  if (!autoSellRequested(env)) {
    return {
      ok: true,
      source,
      liveExecutionImplemented: true,
      autoSellEnabled: false,
      newSellsAttempted: 0,
      quarantinedAmbiguousSells: quarantined,
      reconciled,
      message: "SELL executor is installed but AUTO_SELL_ENABLED is not true. No new SELL was sent.",
    };
  }

  const query = await env.DB.prepare(`
    SELECT * FROM rebound_strategies
    WHERE status = 'SELL_TRIGGERED'
      AND pending_signature IS NULL
      AND pending_action IN ('SELL_TRIGGERED_TP', 'SELL_TRIGGERED_SL', 'SELL_TRIGGERED_STOP')
    ORDER BY sell_triggered_at ASC, created_at ASC
    LIMIT ?
  `).bind(MAX_SELL_EXECUTIONS_PER_CRON).all();
  const rows = Array.isArray(query?.results) ? query.results : [];
  const executions = [];
  for (const strategy of rows) executions.push(await executeTriggeredSell(env, strategy));
  return {
    ok: true,
    source,
    liveExecutionImplemented: true,
    autoSellEnabled: true,
    newSellsAttempted: rows.length,
    quarantinedAmbiguousSells: quarantined,
    reconciled,
    executions,
  };
}

async function handleSellExecutionCheck(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    const walletAddress = account.rebound_wallet_address;
    const [nativeSol, tradingSol, usdcToken, referencePrice] = await Promise.all([
      getSolBalance(env, walletAddress),
      getWsolTokenAccount(env, walletAddress),
      getUsdcTokenAccount(env, walletAddress),
      getJupiterSolPriceMicroUsdc(env),
    ]);
    const wsolRaw = BigInt(String(tradingSol.raw || 0));
    const testRaw = wsolRaw > 500_000n ? 500_000n : wsolRaw;
    if (testRaw < 100_000n) {
      return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "SELL_CHECK_WSOL_LOW", message: "At least 0.0001 Trading SOL is needed for the SELL readiness check." }, 409);
    }
    if (BigInt(nativeSol.raw) < MIN_GAS_LAMPORTS) return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "GAS_RESERVE_LOW", message: "Gas reserve is below 0.005 SOL." }, 409);
    if (!usdcToken.ready || !usdcToken.address) return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "USDC_ACCOUNT_NOT_READY", message: "USDC token account is not ready." }, 409);

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, auth.userId, walletAddress);
    if (!delegatedWallet) return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "AUTOMATION_NOT_ENABLED", message: "Automated Trading is not enabled." }, 409);

    const build = await getJupiterV2SellBuild(env, {
      walletAddress,
      destinationTokenAccount: usdcToken.address,
      amountRaw: testRaw.toString(),
    });
    const programs = instructionProgramIds(build);
    const allowedPrograms = new Set([COMPUTE_BUDGET_PROGRAM_ID, JUPITER_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]);
    const unexpectedPrograms = programs.filter((id) => !allowedPrograms.has(id));
    const policyCompatible = programs.includes(JUPITER_PROGRAM_ID) && unexpectedPrograms.length === 0 && !build?.tipInstruction;
    if (!policyCompatible) {
      return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "POLICY_ROUTE_MISMATCH", message: `SELL route is not compatible with the current policy. Unexpected programs: ${unexpectedPrograms.join(", ") || "none"}`, programs, unexpectedPrograms }, 409);
    }

    const outRaw = BigInt(String(build.outAmount || 0));
    const expectedUsdcRaw = testRaw * referencePrice.micro / 1_000_000_000n;
    const shortfallBps = expectedUsdcRaw > 0n && outRaw < expectedUsdcRaw ? Number((expectedUsdcRaw - outRaw) * 10_000n / expectedUsdcRaw) : 0;
    if (outRaw <= 0n || shortfallBps > MAX_ROUTE_REFERENCE_SHORTFALL_BPS) {
      return json(request, { status: "error", ready: false, noTradeExecuted: true, code: "SELL_ROUTE_SANITY_FAILED", message: "SELL route failed the reference-price sanity check." }, 409);
    }

    const tx = await buildJupiterV2BuyTransaction(env, { build, walletAddress });
    return json(request, {
      status: "ok",
      ready: true,
      noTradeExecuted: true,
      autoSellRequested: autoSellRequested(env),
      message: "SELL readiness check passed. No transaction was signed or sent.",
      checks: {
        gas: { ok: true, currentSol: formatUnits(BigInt(nativeSol.raw), SOL_DECIMALS) },
        automatedTrading: { ok: true },
        tradingSol: { ok: true, testAmountSol: formatUnits(testRaw, SOL_DECIMALS) },
        usdcAccount: { ok: true },
        jupiterV2: { ok: true, inAmountRaw: testRaw.toString(), outAmountRaw: outRaw.toString() },
        policyCompatibility: { ok: true, returnedPrograms: programs },
        routeSanity: { ok: true, referenceShortfallBps: shortfallBps },
        transactionBuild: { ok: true, computeUnitLimit: tx.computeUnitLimit, unitsConsumed: tx.unitsConsumed, lookupTableCount: tx.lookupTableCount, instructionCount: tx.instructionCount },
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("SELL execution check error:", error);
    return json(request, { status: "error", ready: false, noTradeExecuted: true, message: error?.message || "SELL execution check could not be completed." }, 503);
  }
}

async function handleExecutionStatus(request, env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT status, pending_action, COUNT(*) AS count
      FROM rebound_strategies
      WHERE status IN ('BUY_TRIGGERED', 'BOUGHT', 'SELL_TRIGGERED', 'PAUSED')
      GROUP BY status, pending_action
    `).all();
    return json(request, {
      status: "ok",
      liveExecutionImplemented: true,
      autoBuyEnabled: autoExecutionRequested(env),
      autoSellEnabled: autoSellRequested(env),
      executionPath: "Jupiter Swap API V2 /build → simulated v0 transaction → Privy signAndSendTransaction",
      slippageBps: EXECUTION_SLIPPAGE_BPS,
      maxBuyTriggerOverageBps: MAX_BUY_TRIGGER_OVERAGE_BPS,
      maxTakeProfitQuoteUnderageBps: MAX_TP_QUOTE_UNDERAGE_BPS,
      states: Array.isArray(rows?.results) ? rows.results : [],
    });
  } catch (error) {
    console.error("Execution status error:", error);
    return json(request, { status: "error", message: "Execution status is temporarily unavailable." }, 503);
  }
}

async function handleRoot(request, env) {
  return json(request, {
    service: "ASTY Rebound API",
    buildVersion: "2026-09-19-cycle-v2-controls",
    status: "online",
    balanceSource: "Helius",
    displayPriceSource: "Helius DAS",
    watcher: {
      mode: "market-watch",
      executionEnabled: false,
      priceSource: "Jupiter Price API V3",
    },
    execution: {
      mode: autoExecutionRequested(env) ? (autoSellRequested(env) ? "live-cycle" : "live-buy") : "installed-disabled",
      liveExecutionImplemented: true,
      autoExecutionRequested: autoExecutionRequested(env),
      autoSellRequested: autoSellRequested(env),
      routeSafetySource: "Jupiter Swap API V2 /build",
      transactionPath: "Jupiter Swap API V2 /build (v0) for BUY + SELL",
      slippageBps: EXECUTION_SLIPPAGE_BPS,
      maxTriggerOverageBps: MAX_BUY_TRIGGER_OVERAGE_BPS,
    },
    endpoints: {
      health: "/health",
      privyTest: "/privy-test",
      accountSync: "POST /account/sync",
      accountBalance: "GET /account/balance",
      depositContext: "POST /deposit/context",
      transactionStatus: "GET /transaction/status?signature=...",
      strategyList: "GET /strategies",
      strategyCreate: "POST /strategies",
      strategyStop: "POST /strategies/stop",
      strategyResume: "POST /strategies/resume",
      watcherStatus: "GET /watcher/status",
      watcherRun: "POST /watcher/run",
      executionCheck: "POST /execution/check",
      sellExecutionCheck: "POST /execution/sell-check",
      executionStatus: "GET /execution/status",
      tradingAuthorization: "GET /trading/authorization-config",
      prepareSolTrading: "POST /trading/prepare-sol-context",
      serverSignerTest: "POST /trading/server-signer-test",
      testSwap: "POST /trading/test-swap",
    },
  });
}

async function handleHealth(request, env) {
  try {
    const dbTest = await env.DB.prepare("SELECT 1 AS ok").first();
    return json(request, {
      status: "ok",
      service: "ASTY Rebound API",
      database: dbTest?.ok === 1 ? "connected" : "error",
      watcherMode: "watch-only",
      executionMode: autoExecutionRequested(env) ? "live-buy" : "installed-disabled",
      executionEnabled: autoExecutionRequested(env),
      liveExecutionImplemented: true,
      config: {
        privyAppId: Boolean(env.PRIVY_APP_ID),
        privyAppSecret: Boolean(env.PRIVY_APP_SECRET),
        privyAuthorizationKeyId: Boolean(env.PRIVY_AUTH_KEY_ID),
        privyAuthorizationPrivateKey: Boolean(env.PRIVY_AUTH_PRIVATE_KEY),
        privyPolicyId: Boolean(env.PRIVY_POLICY_ID),
        heliusApiKey: Boolean(env.HELIUS_API_KEY),
        jupiterApiKey: Boolean(env.JUPITER_API_KEY),
        autoExecutionRequested: autoExecutionRequested(env),
      },
    });
  } catch (error) {
    console.error("Health error:", error);
    return json(request, { status: "error", message: "Backend health check failed." }, 500);
  }
}

async function handlePrivyTest(request, env) {
  try {
    const privy = createPrivyClient(env);
    return json(request, { status: "ok", service: "ASTY Rebound API", privy: { sdkLoaded: true, clientInitialized: Boolean(privy) } });
  } catch (error) {
    console.error("Privy test error:", error);
    return json(request, { status: "error", message: "Privy SDK initialization failed." }, 500);
  }
}

async function handleAccountSync(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);

    const body = await request.json();
    const phantomAddress = body?.phantomAddress;
    const reboundWalletAddress = body?.reboundWalletAddress;
    const reboundWalletId = body?.reboundWalletId || null;

    if (!isSolanaAddress(phantomAddress)) return json(request, { status: "error", message: "Invalid Phantom wallet address." }, 400);
    if (!isSolanaAddress(reboundWalletAddress)) return json(request, { status: "error", message: "Invalid Rebound wallet address." }, 400);
    if (phantomAddress === reboundWalletAddress) return json(request, { status: "error", message: "Phantom and Rebound wallet cannot be identical." }, 400);

    const existing = await getReboundAccount(env, auth.userId);
    if (existing) {
      if (existing.phantom_address !== phantomAddress) {
        return json(request, { status: "error", message: "This Rebound account is already linked to another Phantom wallet." }, 409);
      }
      if (existing.rebound_wallet_address !== reboundWalletAddress) {
        return json(request, { status: "error", message: "A different Rebound wallet is already registered for this account." }, 409);
      }
      if (!existing.rebound_wallet_id && reboundWalletId) {
        await env.DB.prepare(`UPDATE rebound_users SET rebound_wallet_id = ?, updated_at = CURRENT_TIMESTAMP WHERE privy_user_id = ?`)
          .bind(reboundWalletId, auth.userId).run();
      } else {
        await env.DB.prepare(`UPDATE rebound_users SET updated_at = CURRENT_TIMESTAMP WHERE privy_user_id = ?`)
          .bind(auth.userId).run();
      }
      return json(request, {
        status: "ok",
        synced: true,
        existing: true,
        account: {
          phantomAddress: existing.phantom_address,
          privyUserId: existing.privy_user_id,
          reboundWalletId: existing.rebound_wallet_id || reboundWalletId,
          reboundWalletAddress: existing.rebound_wallet_address,
        },
      });
    }

    const existingPhantom = await env.DB.prepare(`SELECT privy_user_id FROM rebound_users WHERE phantom_address = ? LIMIT 1`)
      .bind(phantomAddress).first();
    if (existingPhantom) {
      return json(request, { status: "error", message: "This Phantom wallet is already registered with ASTY Rebound." }, 409);
    }

    await env.DB.prepare(`
      INSERT INTO rebound_users (
        phantom_address, privy_user_id, rebound_wallet_id, rebound_wallet_address, created_at, updated_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(phantomAddress, auth.userId, reboundWalletId, reboundWalletAddress).run();

    return json(request, {
      status: "ok",
      synced: true,
      existing: false,
      account: { phantomAddress, privyUserId: auth.userId, reboundWalletId, reboundWalletAddress },
    }, 201);
  } catch (error) {
    console.error("Account sync error:", error);
    return json(request, { status: "error", message: "Account synchronization failed." }, 500);
  }
}

async function handleBalance(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    const wallet = account.rebound_wallet_address;
    const [sol, usdc, tradingSol, reservedRaw, reservedInUsdcRaw] = await Promise.all([
      getSolBalance(env, wallet),
      getUsdcBalance(env, wallet),
      getWsolTokenAccount(env, wallet),
      getReservedCapitalRaw(env, auth.userId),
      getUsdcHeldReservedCapitalRaw(env, auth.userId),
    ]);

    let solUsd = null;
    try { solUsd = await getSolUsdPrice(env); } catch (error) { console.error("SOL display price unavailable:", error); }

    const solAmount = Number(sol.ui);
    const usdcAmount = Number(usdc.ui);
    const usdcRaw = BigInt(usdc.raw);
    const freeUsdcRaw = usdcRaw > reservedInUsdcRaw ? usdcRaw - reservedInUsdcRaw : 0n;

    return json(request, {
      status: "ok",
      wallet,
      source: "helius",
      balances: {
        usdc: {
          mint: USDC_MINT,
          decimals: USDC_DECIMALS,
          raw: usdc.raw,
          ui: usdc.ui,
          usdValue: Number.isFinite(usdcAmount) ? usdcAmount : null,
          reservedRaw: reservedRaw.toString(),
          reservedUi: formatUnits(reservedRaw, USDC_DECIMALS),
          reservedInUsdcRaw: reservedInUsdcRaw.toString(),
          reservedInUsdcUi: formatUnits(reservedInUsdcRaw, USDC_DECIMALS),
          freeRaw: freeUsdcRaw.toString(),
          freeUi: formatUnits(freeUsdcRaw, USDC_DECIMALS),
        },
        sol: {
          decimals: SOL_DECIMALS,
          lamports: sol.raw,
          ui: sol.ui,
          usdValue: Number.isFinite(solAmount) && Number.isFinite(solUsd) ? solAmount * solUsd : null,
        },
        tradingSol: {
          internalAsset: "WSOL",
          mint: WSOL_MINT,
          decimals: SOL_DECIMALS,
          ready: tradingSol.ready,
          tokenAccount: tradingSol.address,
          raw: tradingSol.raw,
          ui: tradingSol.ui,
        },
      },
      prices: { solUsd, usdcUsd: 1 },
      priceUse: "display-only",
      commitment: "confirmed",
    });
  } catch (error) {
    console.error("Balance error:", error);
    return json(request, { status: "error", message: "Your Rebound Balance is temporarily unavailable." }, 503);
  }
}

async function handleDepositContext(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.phantom_address || !account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    const body = await request.json();
    const asset = String(body?.asset || "").toUpperCase();
    const amount = String(body?.amount || "").trim();
    if (asset !== "SOL" && asset !== "USDC") return json(request, { status: "error", message: "Unsupported deposit asset." }, 400);
    if (!isPositiveAmount(amount)) return json(request, { status: "error", message: "Enter a valid deposit amount." }, 400);
    const maxDecimals = asset === "USDC" ? USDC_DECIMALS : SOL_DECIMALS;
    const decimalPart = amount.split(".")[1] || "";
    if (decimalPart.length > maxDecimals) return json(request, { status: "error", message: `${asset} supports a maximum of ${maxDecimals} decimal places.` }, 400);

    const latest = await getLatestBlockhash(env);
    return json(request, {
      status: "ok",
      chain: "solana:mainnet",
      asset,
      amount,
      decimals: maxDecimals,
      from: account.phantom_address,
      to: account.rebound_wallet_address,
      usdcMint: USDC_MINT,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
  } catch (error) {
    console.error("Deposit context error:", error);
    return json(request, { status: "error", message: "Deposit preparation is temporarily unavailable." }, 503);
  }
}

async function handleTransactionStatus(request, env, url) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const signature = url.searchParams.get("signature");
    if (!isTransactionSignature(signature)) return json(request, { status: "error", message: "Invalid transaction signature." }, 400);

    const result = await heliusRpc(env, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = result?.value?.[0] || null;
    if (!status) return json(request, { status: "ok", found: false, confirmed: false, finalized: false, confirmationStatus: null, transactionError: null });

    const confirmationStatus = status.confirmationStatus || null;
    const transactionError = status.err || null;
    const confirmed = !transactionError && (confirmationStatus === "confirmed" || confirmationStatus === "finalized");
    const finalized = !transactionError && confirmationStatus === "finalized";
    return json(request, { status: "ok", found: true, confirmed, finalized, confirmationStatus, transactionError, slot: status.slot ?? null });
  } catch (error) {
    console.error("Transaction status error:", error);
    return json(request, { status: "error", message: "Transaction status is temporarily unavailable." }, 503);
  }
}

async function handleStrategyList(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    await ensureCycleHistoryTable(env);
    const [queryResult, cycleResult, usdc, reservedRaw, reservedInUsdcRaw] = await Promise.all([
      env.DB.prepare(`SELECT * FROM rebound_strategies WHERE privy_user_id = ? ORDER BY created_at DESC`).bind(auth.userId).all(),
      env.DB.prepare(`SELECT * FROM rebound_cycles WHERE privy_user_id = ? ORDER BY sold_at DESC, bought_at DESC, created_at DESC`).bind(auth.userId).all(),
      getUsdcBalance(env, account.rebound_wallet_address),
      getReservedCapitalRaw(env, auth.userId),
      getUsdcHeldReservedCapitalRaw(env, auth.userId),
    ]);

    const walletUsdcRaw = BigInt(usdc.raw);
    const freeUsdcRaw = walletUsdcRaw > reservedInUsdcRaw ? walletUsdcRaw - reservedInUsdcRaw : 0n;
    const rows = Array.isArray(queryResult?.results) ? queryResult.results : [];
    const cycleRows = Array.isArray(cycleResult?.results) ? cycleResult.results : [];
    const lastCycleByStrategy = new Map();
    for (const cycle of cycleRows) {
      if (!lastCycleByStrategy.has(cycle.strategy_id)) lastCycleByStrategy.set(cycle.strategy_id, normalizeCycleRow(cycle));
    }

    return json(request, {
      status: "ok",
      strategies: rows.map((row) => ({ ...normalizeStrategyRow(row), lastCycle: lastCycleByStrategy.get(row.id) || null })),
      capital: {
        walletUsdcRaw: walletUsdcRaw.toString(),
        walletUsdc: formatUnits(walletUsdcRaw, USDC_DECIMALS),
        reservedUsdcRaw: reservedRaw.toString(),
        reservedUsdc: formatUnits(reservedRaw, USDC_DECIMALS),
        reservedInUsdcRaw: reservedInUsdcRaw.toString(),
        reservedInUsdc: formatUnits(reservedInUsdcRaw, USDC_DECIMALS),
        freeUsdcRaw: freeUsdcRaw.toString(),
        freeUsdc: formatUnits(freeUsdcRaw, USDC_DECIMALS),
      },
    });
  } catch (error) {
    console.error("Strategy list error:", error);
    return json(request, { status: "error", message: "Strategies are temporarily unavailable." }, 503);
  }
}

async function handleStrategyCreate(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.phantom_address || !account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    let body = {};
    try { body = await request.json(); } catch {}
    let capitalRaw;
    let config;
    try {
      capitalRaw = parseDecimalToRaw(body?.capitalUsdc, USDC_DECIMALS);
      config = resolveStrategyConfiguration(body);
    } catch (error) {
      return json(request, { status: "error", message: error.message }, 400);
    }

    if (capitalRaw < MIN_STRATEGY_USDC_RAW) return json(request, { status: "error", message: "A new strategy requires at least 25 USDC." }, 400);

    const [usdc, asty, reservedRaw, reservedInUsdcRaw, activeCountRow] = await Promise.all([
      getUsdcBalance(env, account.rebound_wallet_address),
      getAstyBalance(env, account.phantom_address),
      getReservedCapitalRaw(env, auth.userId),
      getUsdcHeldReservedCapitalRaw(env, auth.userId),
      env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM rebound_strategies
        WHERE privy_user_id = ?
          AND status IN (${activeStatusSqlPlaceholders()})
      `).bind(auth.userId, ...ACTIVE_STRATEGY_STATUSES).first(),
    ]);

    const walletUsdcRaw = BigInt(usdc.raw);
    const astyRaw = BigInt(asty.raw);
    const freeUsdcRaw = walletUsdcRaw > reservedInUsdcRaw ? walletUsdcRaw - reservedInUsdcRaw : 0n;
    const activeStrategyCount = Number(activeCountRow?.count || 0);
    const requiredAstyRaw = ASTY_GATE_RAW * BigInt(activeStrategyCount + 1);

    if (astyRaw < requiredAstyRaw) {
      return json(request, {
        status: "error",
        code: "ASTY_GATE_NOT_MET",
        message: `Creating this strategy requires ${formatUnits(requiredAstyRaw, ASTY_DECIMALS)} ASTY in the linked Phantom wallet (${activeStrategyCount + 1} active ${activeStrategyCount + 1 === 1 ? "strategy" : "strategies"} × 2,500 ASTY).`,
        gate: {
          perStrategyAstyRaw: ASTY_GATE_RAW.toString(),
          perStrategyAsty: formatUnits(ASTY_GATE_RAW, ASTY_DECIMALS),
          activeStrategiesAfterCreation: activeStrategyCount + 1,
          requiredAstyRaw: requiredAstyRaw.toString(),
          requiredAsty: formatUnits(requiredAstyRaw, ASTY_DECIMALS),
          currentAstyRaw: astyRaw.toString(),
          currentAsty: formatUnits(astyRaw, ASTY_DECIMALS),
        },
      }, 409);
    }

    if (freeUsdcRaw < capitalRaw) {
      return json(request, {
        status: "error",
        code: "INSUFFICIENT_FREE_USDC",
        message: "Not enough free USDC is available for this strategy.",
        capital: {
          requestedUsdcRaw: capitalRaw.toString(),
          requestedUsdc: formatUnits(capitalRaw, USDC_DECIMALS),
          walletUsdcRaw: walletUsdcRaw.toString(),
          walletUsdc: formatUnits(walletUsdcRaw, USDC_DECIMALS),
          reservedUsdcRaw: reservedRaw.toString(),
          reservedUsdc: formatUnits(reservedRaw, USDC_DECIMALS),
          reservedInUsdcRaw: reservedInUsdcRaw.toString(),
          reservedInUsdc: formatUnits(reservedInUsdcRaw, USDC_DECIMALS),
          freeUsdcRaw: freeUsdcRaw.toString(),
          freeUsdc: formatUnits(freeUsdcRaw, USDC_DECIMALS),
        },
      }, 409);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO rebound_strategies (
        id, privy_user_id, phantom_address, rebound_wallet_address,
        asset_symbol, status, preset, dip_bps, take_profit_bps,
        stop_loss_enabled, stop_loss_bps, auto_repeat, compound,
        initial_capital_usdc_raw, reserved_capital_usdc_raw, current_cycle_capital_usdc_raw,
        free_profit_usdc_raw, cycle_number, asty_gate_checked_at, asty_balance_raw_at_creation,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'SOL', 'WATCHING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1,
        CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).bind(
      id,
      auth.userId,
      account.phantom_address,
      account.rebound_wallet_address,
      config.preset,
      config.dipBps,
      config.takeProfitBps,
      config.stopLossEnabled ? 1 : 0,
      config.stopLossBps,
      config.autoRepeat ? 1 : 0,
      config.compound ? 1 : 0,
      capitalRaw.toString(),
      capitalRaw.toString(),
      capitalRaw.toString(),
      astyRaw.toString()
    ).run();

    const row = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? AND privy_user_id = ? LIMIT 1`)
      .bind(id, auth.userId).first();

    return json(request, {
      status: "ok",
      created: true,
      tradingActive: autoExecutionRequested(env),
      message: autoExecutionRequested(env)
        ? "Strategy created. Rebound is watching for the configured dip and can execute the BUY automatically."
        : "Strategy created in WATCHING mode. Automatic BUY execution is currently disabled.",
      strategy: normalizeStrategyRow(row),
      gate: {
        checked: true,
        perStrategyAstyRaw: ASTY_GATE_RAW.toString(),
        activeStrategiesAfterCreation: activeStrategyCount + 1,
        requiredAstyRaw: requiredAstyRaw.toString(),
        currentAstyRaw: astyRaw.toString(),
      },
    }, 201);
  } catch (error) {
    console.error("Strategy create error:", error);
    return json(request, { status: "error", message: "The strategy could not be created." }, 503);
  }
}

async function handleStrategyStop(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);

    let body = {};
    try { body = await request.json(); } catch {}
    const strategyId = String(body?.strategyId || "").trim();
    if (!strategyId) return json(request, { status: "error", message: "Strategy ID is required." }, 400);

    const strategy = await env.DB.prepare(`
      SELECT * FROM rebound_strategies
      WHERE id = ? AND privy_user_id = ?
      LIMIT 1
    `).bind(strategyId, auth.userId).first();
    if (!strategy) return json(request, { status: "error", message: "Strategy not found." }, 404);

    const status = String(strategy.status || "").toUpperCase();
    if (status === "STOPPED") {
      return json(request, { status: "ok", stopped: true, strategy: normalizeStrategyRow(strategy), message: "Strategy is already stopped." });
    }
    if (status === "COMPLETED") {
      return json(request, { status: "ok", stopped: true, strategy: normalizeStrategyRow(strategy), message: "This strategy has already completed and no capital is reserved." });
    }
    if (status === "SELL_TRIGGERED") {
      return json(request, { status: "error", code: "TRADE_IN_PROGRESS", message: "This strategy is already closing its position. Wait for the SELL to finish." }, 409);
    }

    if (status === "BOUGHT") {
      if (!autoSellRequested(env)) {
        return json(request, { status: "error", code: "AUTO_SELL_DISABLED", message: "The open position cannot be stopped while automatic SELL execution is disabled." }, 409);
      }
      const result = await env.DB.prepare(`
        UPDATE rebound_strategies
        SET status = 'SELL_TRIGGERED',
            pending_action = 'SELL_TRIGGERED_STOP',
            pending_action_started_at = CURRENT_TIMESTAMP,
            sell_triggered_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND privy_user_id = ?
          AND status = 'BOUGHT'
          AND pending_signature IS NULL
          AND execution_lock IS NULL
      `).bind(strategyId, auth.userId).run();

      if (Number(result?.meta?.changes ?? 0) === 0) {
        return json(request, { status: "error", code: "TRADE_IN_PROGRESS", message: "The strategy changed state while the stop was requested. Refresh and try again after the current action finishes." }, 409);
      }

      const updated = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategyId).first();
      return json(request, {
        status: "ok",
        stopping: true,
        closePosition: true,
        strategy: normalizeStrategyRow(updated),
        message: "Stop requested. Rebound will sell the open SOL position back to USDC and then stop the strategy.",
      });
    }

    if (status === "PAUSED") {
      const unresolvedWsol = BigInt(String(strategy.entry_wsol_raw || 0));
      if (unresolvedWsol > 0n || strategy.pending_signature || strategy.pending_action || strategy.execution_lock) {
        return json(request, {
          status: "error",
          code: "UNRESOLVED_POSITION",
          message: "This paused strategy still has an unresolved trading state and cannot be released safely yet.",
        }, 409);
      }
    }

    if (!["WATCHING", "BUY_TRIGGERED", "PAUSED"].includes(status)) {
      return json(request, { status: "error", message: `Strategy cannot be stopped from status ${status || "UNKNOWN"}.` }, 409);
    }

    const result = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'STOPPED',
          reserved_capital_usdc_raw = 0,
          current_cycle_capital_usdc_raw = 0,
          pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          stopped_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND privy_user_id = ?
        AND status IN ('WATCHING', 'BUY_TRIGGERED', 'PAUSED')
        AND pending_signature IS NULL
        AND execution_lock IS NULL
    `).bind(strategyId, auth.userId).run();

    if (Number(result?.meta?.changes ?? 0) === 0) {
      return json(request, {
        status: "error",
        code: "TRADE_IN_PROGRESS",
        message: "A trade is already being prepared or the strategy state changed. Rebound blocked the stop to avoid a conflicting transaction.",
      }, 409);
    }

    const updated = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategyId).first();
    return json(request, {
      status: "ok",
      stopped: true,
      releasedToAvailable: true,
      strategy: normalizeStrategyRow(updated),
      message: "Strategy stopped. Its reserved USDC is now available again.",
    });
  } catch (error) {
    console.error("Strategy stop error:", error);
    return json(request, { status: "error", message: error?.message || "The strategy could not be stopped." }, 503);
  }
}

async function handleStrategyResume(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);

    let body = {};
    try { body = await request.json(); } catch {}
    const strategyId = String(body?.strategyId || "").trim();
    if (!strategyId) return json(request, { status: "error", message: "Strategy ID is required." }, 400);

    const strategy = await env.DB.prepare(`
      SELECT * FROM rebound_strategies
      WHERE id = ? AND privy_user_id = ?
      LIMIT 1
    `).bind(strategyId, auth.userId).first();
    if (!strategy) return json(request, { status: "error", message: "Strategy not found." }, 404);
    if (String(strategy.status || "").toUpperCase() !== "PAUSED") {
      return json(request, { status: "error", message: "Only a paused strategy can be resumed." }, 409);
    }

    const unresolvedWsol = BigInt(String(strategy.entry_wsol_raw || 0));
    if (unresolvedWsol > 0n || strategy.pending_signature || strategy.pending_action || strategy.execution_lock) {
      return json(request, {
        status: "error",
        code: "UNRESOLVED_POSITION",
        message: "This paused strategy still has an unresolved trading state and cannot be resumed safely yet.",
      }, 409);
    }

    const priceInfo = await getJupiterSolPriceMicroUsdc(env);
    const current = priceInfo.micro;
    const trigger = current * (10_000n - BigInt(Number(strategy.dip_bps))) / 10_000n;

    const result = await env.DB.prepare(`
      UPDATE rebound_strategies
      SET status = 'WATCHING',
          hwm_price_micro_usdc = ?,
          current_price_micro_usdc = ?,
          buy_trigger_price_micro_usdc = ?,
          buy_fill_price_micro_usdc = NULL,
          take_profit_price_micro_usdc = NULL,
          stop_loss_price_micro_usdc = NULL,
          entry_wsol_raw = NULL,
          cycle_number = cycle_number + 1,
          buy_triggered_at = NULL,
          bought_at = NULL,
          sell_triggered_at = NULL,
          sold_at = NULL,
          paused_at = NULL,
          stopped_at = NULL,
          pending_action = NULL,
          pending_signature = NULL,
          pending_action_started_at = NULL,
          execution_lock = NULL,
          execution_lock_at = NULL,
          last_price_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND privy_user_id = ?
        AND status = 'PAUSED'
        AND pending_signature IS NULL
        AND pending_action IS NULL
        AND execution_lock IS NULL
        AND (entry_wsol_raw IS NULL OR entry_wsol_raw = 0)
    `).bind(
      current.toString(),
      current.toString(),
      trigger.toString(),
      strategyId,
      auth.userId,
    ).run();

    if (Number(result?.meta?.changes ?? 0) === 0) {
      return json(request, { status: "error", message: "The paused strategy could not be resumed safely." }, 409);
    }

    const updated = await env.DB.prepare(`SELECT * FROM rebound_strategies WHERE id = ? LIMIT 1`).bind(strategyId).first();
    return json(request, {
      status: "ok",
      resumed: true,
      astyGateRechecked: false,
      strategy: normalizeStrategyRow(updated),
      message: "Strategy resumed with a fresh reference high from the current Jupiter price.",
    });
  } catch (error) {
    console.error("Strategy resume error:", error);
    return json(request, { status: "error", message: error?.message || "The strategy could not be resumed." }, 503);
  }
}

async function handleWatcherStatus(request, env) {
  try {
    const counts = await env.DB.prepare(`
      SELECT status, COUNT(*) AS count
      FROM rebound_strategies
      WHERE asset_symbol = 'SOL'
      GROUP BY status
    `).all();
    const latest = await env.DB.prepare(`
      SELECT current_price_micro_usdc, hwm_price_micro_usdc, buy_trigger_price_micro_usdc, last_price_at
      FROM rebound_strategies
      WHERE asset_symbol = 'SOL' AND last_price_at IS NOT NULL
      ORDER BY last_price_at DESC
      LIMIT 1
    `).first();

    const byStatus = {};
    for (const row of counts?.results || []) byStatus[row.status] = Number(row.count || 0);

    return json(request, {
      status: "ok",
      mode: "watch-only",
      executionEnabled: false,
      priceSource: "Jupiter Price API V3",
      strategies: {
        watching: byStatus.WATCHING || 0,
        buyTriggered: byStatus.BUY_TRIGGERED || 0,
        bought: byStatus.BOUGHT || 0,
        sellTriggered: byStatus.SELL_TRIGGERED || 0,
        paused: byStatus.PAUSED || 0,
        stopped: byStatus.STOPPED || 0,
      },
      latest: latest ? {
        currentPriceMicroUsdc: latest.current_price_micro_usdc == null ? null : String(latest.current_price_micro_usdc),
        currentPriceUsd: formatMicroUsd(latest.current_price_micro_usdc),
        hwmPriceUsd: formatMicroUsd(latest.hwm_price_micro_usdc),
        buyTriggerPriceUsd: formatMicroUsd(latest.buy_trigger_price_micro_usdc),
        lastPriceAt: latest.last_price_at,
      } : null,
    });
  } catch (error) {
    console.error("Watcher status error:", error);
    return json(request, { status: "error", message: "Watcher status is temporarily unavailable." }, 503);
  }
}

async function handleWatcherRun(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const result = await runPriceWatcher(env, { source: "manual", privyUserId: auth.userId });
    return json(request, { status: "ok", ...result });
  } catch (error) {
    console.error("Manual watcher run error:", error);
    return json(request, { status: "error", message: error?.message || "Watcher run failed." }, 503);
  }
}

async function handleAuthorizationConfig(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);
    if (!env.PRIVY_AUTH_KEY_ID || !env.PRIVY_AUTH_PRIVATE_KEY || !env.PRIVY_POLICY_ID) {
      return json(request, { status: "error", message: "Automated trading is not configured yet." }, 503);
    }
    return json(request, {
      status: "ok",
      wallet: account.rebound_wallet_address,
      signerId: env.PRIVY_AUTH_KEY_ID,
      policyId: env.PRIVY_POLICY_ID,
      policyProtected: true,
    });
  } catch (error) {
    console.error("Trading authorization config error:", error);
    return json(request, { status: "error", message: "Automated trading authorization is temporarily unavailable." }, 503);
  }
}

async function handlePrepareSolContext(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.phantom_address || !account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    const wsol = await getWsolTokenAccount(env, account.rebound_wallet_address);
    if (wsol.ready) {
      return json(request, {
        status: "ok",
        alreadyReady: true,
        from: account.phantom_address,
        owner: account.rebound_wallet_address,
        wsolMint: WSOL_MINT,
        tokenAccount: wsol.address,
      });
    }

    const latest = await getLatestBlockhash(env);
    return json(request, {
      status: "ok",
      alreadyReady: false,
      from: account.phantom_address,
      owner: account.rebound_wallet_address,
      wsolMint: WSOL_MINT,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
  } catch (error) {
    console.error("Prepare SOL trading context error:", error);
    return json(request, { status: "error", message: "SOL trading preparation is temporarily unavailable." }, 503);
  }
}

async function handleServerSignerTest(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);
    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, auth.userId, account.rebound_wallet_address);
    if (!delegatedWallet) {
      return json(request, { status: "error", serverReady: false, delegated: false, message: "Privy does not report the Rebound Wallet as delegated yet." }, 409);
    }

    const walletId = account.rebound_wallet_id || delegatedWallet?.id || null;
    if (!walletId) return json(request, { status: "error", serverReady: false, delegated: true, message: "Rebound Wallet ID is unavailable." }, 409);

    const message = utf8ToBase64([
      "ASTY Rebound server signer security test",
      account.rebound_wallet_address,
      new Date().toISOString(),
    ].join(" | "));

    try {
      await privy.wallets().solana().signMessage(walletId, {
        message,
        authorization_context: createAuthorizationContext(env),
      });
      return json(request, {
        status: "warning",
        serverReady: true,
        delegated: true,
        policyProtected: false,
        result: "unexpectedly_allowed",
        message: "Server signing works, but signMessage was unexpectedly allowed. Review the trading policy before real trading.",
      }, 409);
    } catch (error) {
      const info = getSafePrivyError(error);
      if (looksLikePolicyDenial(info)) {
        return json(request, {
          status: "ok",
          serverReady: true,
          delegated: true,
          authorizationRequestReachedPrivy: true,
          policyProtected: true,
          result: "blocked_as_expected",
          message: "Server signer reached Privy and the Trading Policy blocked the non-trading signMessage request as expected.",
          privy: info,
        });
      }
      return json(request, {
        status: "error",
        serverReady: false,
        delegated: true,
        authorizationRequestReachedPrivy: true,
        policyProtected: null,
        result: "blocked_unclassified",
        message: "Privy rejected the server signing test, but the response was not clearly identified as a policy denial.",
        privy: info,
      }, 502);
    }
  } catch (error) {
    console.error("Server signer test error:", error);
    return json(request, { status: "error", serverReady: false, message: "Server signer test could not be completed.", privy: getSafePrivyError(error) }, 503);
  }
}

async function handleTestSwap(request, env) {
  try {
    const auth = await verifyPrivyRequest(request, env);
    if (!auth.ok) return json(request, { status: "error", message: auth.message }, auth.status);

    let body = {};
    try { body = await request.json(); } catch {}
    if (body?.confirm !== "TEST_SWAP_0_10_USDC_TO_SOL") {
      return json(request, { status: "error", message: "Explicit test swap confirmation is required." }, 400);
    }

    const account = await getReboundAccount(env, auth.userId);
    if (!account?.rebound_wallet_address) return json(request, { status: "error", message: "Rebound account not found." }, 404);
    const walletAddress = account.rebound_wallet_address;

    const [usdc, nativeSol, tradingSol, reservedInUsdcRaw] = await Promise.all([
      getUsdcBalance(env, walletAddress),
      getSolBalance(env, walletAddress),
      getWsolTokenAccount(env, walletAddress),
      getUsdcHeldReservedCapitalRaw(env, auth.userId),
    ]);

    const walletUsdcRaw = BigInt(usdc.raw);
    const freeUsdcRaw = walletUsdcRaw > reservedInUsdcRaw ? walletUsdcRaw - reservedInUsdcRaw : 0n;
    if (freeUsdcRaw < TEST_SWAP_USDC_RAW) {
      return json(request, { status: "error", message: "At least 0.10 free USDC is required for the test swap." }, 409);
    }
    if (BigInt(nativeSol.raw) < 100_000n) {
      return json(request, { status: "error", message: "The Rebound Wallet needs a small native SOL balance for network fees before the test swap." }, 409);
    }
    if (!tradingSol.ready || !tradingSol.address) {
      return json(request, {
        status: "error",
        stage: "sol-trading-preparation",
        needsPreparation: true,
        message: "SOL trading is not prepared yet. Create the Rebound Wallet's SOL trading account first.",
      }, 409);
    }

    const privy = createPrivyClient(env);
    const delegatedWallet = await getPrivyDelegatedWallet(privy, auth.userId, walletAddress);
    if (!delegatedWallet) return json(request, { status: "error", message: "Automated Trading is not enabled for this Rebound Wallet." }, 409);
    const walletId = account.rebound_wallet_id || delegatedWallet?.id || null;
    if (!walletId) return json(request, { status: "error", message: "Rebound Wallet ID is unavailable." }, 409);

    const quoteParams = new URLSearchParams({
      inputMint: USDC_MINT,
      outputMint: WSOL_MINT,
      amount: TEST_SWAP_USDC_RAW.toString(),
      slippageBps: String(TEST_SWAP_SLIPPAGE_BPS),
      swapMode: "ExactIn",
      restrictIntermediateTokens: "true",
      instructionVersion: "V2",
    });

    const quote = await jupiterFetch(env, `/quote?${quoteParams.toString()}`);
    if (!quote || quote.inputMint !== USDC_MINT || quote.outputMint !== WSOL_MINT || String(quote.inAmount) !== TEST_SWAP_USDC_RAW.toString() || !Array.isArray(quote.routePlan) || quote.routePlan.length === 0) {
      return json(request, { status: "error", stage: "jupiter-quote", message: "Jupiter did not return a valid test-swap route." }, 502);
    }

    const priceImpactPct = Number(quote.priceImpactPct);
    if (Number.isFinite(priceImpactPct) && priceImpactPct > 0.01) {
      return json(request, { status: "error", stage: "jupiter-quote", message: "Test swap rejected because Jupiter reported more than 1% price impact.", priceImpactPct }, 409);
    }

    const swapBuildBody = {
      quoteResponse: quote,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: false,
      destinationTokenAccount: tradingSol.address,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 10000, priorityLevel: "medium" },
      },
    };

    if (!env.JUPITER_API_KEY) await sleep(2100);
    const plan = await jupiterFetch(env, "/swap-instructions", { method: "POST", body: JSON.stringify(swapBuildBody) });
    const programs = instructionProgramIds(plan);
    const allowed = new Set([COMPUTE_BUDGET_PROGRAM_ID, JUPITER_PROGRAM_ID]);
    const unexpectedPrograms = programs.filter((id) => !allowed.has(id));
    const hasSetup = Array.isArray(plan?.setupInstructions) && plan.setupInstructions.length > 0;
    const hasCleanup = Boolean(plan?.cleanupInstruction);
    const hasOther = Array.isArray(plan?.otherInstructions) && plan.otherInstructions.length > 0;
    const hasTokenLedger = Boolean(plan?.tokenLedgerInstruction);

    if (unexpectedPrograms.length || hasSetup || hasCleanup || hasOther || hasTokenLedger || !programs.includes(JUPITER_PROGRAM_ID)) {
      return json(request, {
        status: "error",
        stage: "policy-preflight",
        message: "Jupiter still requires instructions outside the restricted ASTY Rebound trading policy. Nothing was signed or sent.",
        programs,
        unexpectedPrograms,
        hasSetupInstructions: hasSetup,
        hasCleanupInstruction: hasCleanup,
        hasOtherInstructions: hasOther,
        hasTokenLedgerInstruction: hasTokenLedger,
      }, 409);
    }

    if (!env.JUPITER_API_KEY) await sleep(2100);
    const swapResponse = await jupiterFetch(env, "/swap", { method: "POST", body: JSON.stringify(swapBuildBody) });
    const swapTransaction = swapResponse?.swapTransaction;
    if (typeof swapTransaction !== "string" || swapTransaction.length < 100) {
      return json(request, { status: "error", stage: "jupiter-build", message: "Jupiter did not return a valid swap transaction." }, 502);
    }

    let sendResult;
    try {
      sendResult = await privy.wallets().solana().signAndSendTransaction(walletId, {
        caip2: SOLANA_MAINNET_CAIP2,
        transaction: swapTransaction,
        authorization_context: createAuthorizationContext(env),
      });
    } catch (error) {
      const info = getSafePrivyError(error);
      return json(request, {
        status: "error",
        stage: "privy-sign-and-send",
        policyDenied: looksLikePolicyDenial(info),
        message: `Privy rejected the test swap: ${info.message}`,
        privy: info,
      }, 409);
    }

    const signature = extractPrivyTxHash(sendResult);
    if (!signature || !isTransactionSignature(signature)) {
      return json(request, { status: "error", stage: "privy-response", message: "Privy accepted the test swap but did not return a valid Solana transaction signature." }, 502);
    }

    return json(request, {
      status: "ok",
      result: "submitted",
      assetIn: "USDC",
      amountIn: "0.10",
      assetOut: "SOL",
      internalAssetOut: "WSOL",
      quotedOutRaw: String(quote.outAmount || ""),
      slippageBps: TEST_SWAP_SLIPPAGE_BPS,
      priceImpactPct: quote.priceImpactPct ?? null,
      signature,
    });
  } catch (error) {
    console.error("Test swap error:", error);
    return json(request, { status: "error", message: error?.message || "The test swap could not be completed." }, 503);
  }
}

async function routeFetch(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;

  switch (key) {
    case "GET /": return handleRoot(request, env);
    case "GET /health": return handleHealth(request, env);
    case "GET /privy-test": return handlePrivyTest(request, env);
    case "POST /account/sync": return handleAccountSync(request, env);
    case "GET /account/balance": return handleBalance(request, env);
    case "POST /deposit/context": return handleDepositContext(request, env);
    case "GET /transaction/status": return handleTransactionStatus(request, env, url);
    case "GET /strategies": return handleStrategyList(request, env);
    case "POST /strategies": return handleStrategyCreate(request, env);
    case "POST /strategies/stop": return handleStrategyStop(request, env);
    case "POST /strategies/resume": return handleStrategyResume(request, env);
    case "GET /watcher/status": return handleWatcherStatus(request, env);
    case "POST /watcher/run": return handleWatcherRun(request, env);
    case "POST /execution/check": return handleExecutionCheck(request, env);
    case "POST /execution/sell-check": return handleSellExecutionCheck(request, env);
    case "GET /execution/status": return handleExecutionStatus(request, env);
    case "GET /trading/authorization-config": return handleAuthorizationConfig(request, env);
    case "POST /trading/prepare-sol-context": return handlePrepareSolContext(request, env);
    case "POST /trading/server-signer-test": return handleServerSignerTest(request, env);
    case "POST /trading/test-swap": return handleTestSwap(request, env);
    default: return json(request, { status: "error", message: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    return routeFetch(request, env);
  },

  async scheduled(controller, env) {
    const source = `cron:${controller.cron || "scheduled"}`;
    const watcherResult = await runPriceWatcher(env, { source });
    console.log("ASTY Rebound watcher result:", JSON.stringify(watcherResult));

    // Reconcile submitted BUYs and execute newly-triggered BUYs when enabled.
    const executionResult = await runBuyExecutor(env, { source });
    console.log("ASTY Rebound BUY executor result:", JSON.stringify(executionResult));

    // Open positions are monitored separately so the user-facing lifecycle stays clear:
    // BOUGHT → SELL_TRIGGERED → confirmed SELL.
    const positionResult = await runPositionWatcher(env, { source });
    console.log("ASTY Rebound position watcher result:", JSON.stringify(positionResult));

    // Submitted SELLs are always reconciled. New SELLs require AUTO_SELL_ENABLED=true.
    const sellResult = await runSellExecutor(env, { source });
    console.log("ASTY Rebound SELL executor result:", JSON.stringify(sellResult));
  },
};
