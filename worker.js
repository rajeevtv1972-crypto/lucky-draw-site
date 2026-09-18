const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const BNB_RECIPIENT = "0x3346f2dDda319640AE68DfCe6A3B79e496973cCD";
const BNB_CHAIN_ID = 56;
const BNB_AMOUNT_WEI = 100000000000000n; // 0.0001 BNB
const BNB_RPC_URL = "https://bsc-dataseed.bnbchain.org";
const BNB_INTENT_TTL_MS = 10 * 60 * 1000;

function responseJson(data, status = 200, request) {
  const origin = request?.headers.get("Origin");
  const headers = new Headers(JSON_HEADERS);
  headers.set("access-control-allow-origin", origin || "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type");
  headers.set("vary", "Origin");
  return new Response(JSON.stringify(data), { status, headers });
}

function clean(value, max = 256) {
  return String(value ?? "").trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidTxHash(hash) {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

function base64UrlEncode(text) {
  return btoa(unescape(encodeURIComponent(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function createBnbIntent(entry) {
  const payload = {
    v: 2,
    exp: Date.now() + BNB_INTENT_TTL_MS,
    nonce: crypto.randomUUID(),
    entry
  };
  return base64UrlEncode(JSON.stringify(payload));
}

function verifyBnbIntent(token) {
  if (!token) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(token));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    const entry = payload.entry || {};
    if (!entry.name || !isValidEmail(entry.email)) return null;
    return entry;
  } catch {
    return null;
  }
}

async function bscRpc(method, params = []) {
  const response = await fetch(BNB_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  if (!response.ok) throw new Error(`BSC RPC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "BSC RPC error");
  return data.result;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendEntryEmail(entry, payment, env) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.RESEND_FROM) {
    return { sent: false, reason: "Email service is not configured." };
  }

  const subject = `Lucky Draw Entry — ${payment.txHash}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111827">
      <h2>🎉 New Lucky Draw Entry</h2>
      <p>A new entry was confirmed after a verified BNB payment.</p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Name</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Email</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.email)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Phone</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.phone || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment method</b></td><td style="padding:8px;border:1px solid #ddd">BNB on BNB Smart Chain</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Amount</b></td><td style="padding:8px;border:1px solid #ddd">0.0001 BNB</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>TX hash</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.txHash)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Sender</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.from || "Unknown")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Recipient</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(BNB_RECIPIENT)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Chain</b></td><td style="padding:8px;border:1px solid #ddd">BSC Mainnet (56)</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Block</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.blockNumber || "Unknown")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Submitted at</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.submittedAt)}</td></tr>
      </table>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `lucky-draw-entry:${payment.txHash}`
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [env.ADMIN_EMAIL],
      subject,
      html
    })
  });

  const text = await response.text();
  if (!response.ok) {
    console.error("Resend error", response.status, text);
    return { sent: false, reason: "Email provider rejected the message." };
  }

  return { sent: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return responseJson({ ok: true }, 200, request);

    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return responseJson({
        bnb: {
          configured: true,
          amountBnb: "0.0001",
          amountWei: BNB_AMOUNT_WEI.toString(),
          recipient: BNB_RECIPIENT,
          chainId: BNB_CHAIN_ID
        }
      }, 200, request);
    }

    if (url.pathname === "/api/bnb-intent" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return responseJson({ error: "Invalid JSON request." }, 400, request); }

      const name = clean(body?.name, 100);
      const email = clean(body?.email, 160).toLowerCase();
      const phone = clean(body?.phone, 25);
      if (!name || !isValidEmail(email)) {
        return responseJson({ error: "Please provide a valid name and email address." }, 400, request);
      }

      const entry = { name, email, phone: phone || "Not provided", submittedAt: new Date().toISOString() };
      const intent = createBnbIntent(entry);
      return responseJson({
        intent,
        recipient: BNB_RECIPIENT,
        amountBnb: "0.0001",
        amountWei: BNB_AMOUNT_WEI.toString(),
        chainId: BNB_CHAIN_ID,
        chainName: "BNB Smart Chain"
      }, 200, request);
    }

    if (url.pathname === "/api/bnb-verify" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return responseJson({ error: "Invalid JSON request." }, 400, request); }

      const intent = clean(body?.intent, 5000);
      const txHash = clean(body?.txHash, 80);
      const walletAddress = clean(body?.walletAddress, 42);
      if (!intent || !isValidTxHash(txHash)) {
        return responseJson({ error: "A valid payment transaction hash is required." }, 400, request);
      }
      if (walletAddress && !isValidAddress(walletAddress)) {
        return responseJson({ error: "Invalid wallet address." }, 400, request);
      }

      const entry = verifyBnbIntent(intent);
      if (!entry) return responseJson({ error: "Payment session is invalid or expired." }, 400, request);

      try {
        const tx = await bscRpc("eth_getTransactionByHash", [txHash]);
        if (!tx) return responseJson({ error: "Transaction was not found on BSC yet." }, 400, request);

        const receipt = await bscRpc("eth_getTransactionReceipt", [txHash]);
        if (!receipt || !receipt.blockNumber) {
          return responseJson({ error: "Transaction is still pending. Wait for confirmation and try again." }, 202, request);
        }

        if (receipt.status !== "0x1") {
          return responseJson({ error: "The BNB transaction failed on-chain." }, 400, request);
        }

        if (!tx.to || tx.to.toLowerCase() !== BNB_RECIPIENT.toLowerCase()) {
          return responseJson({ error: "The transaction was sent to the wrong BNB address." }, 400, request);
        }

        let valueWei;
        try { valueWei = BigInt(tx.value); } catch { return responseJson({ error: "Invalid transaction value." }, 400, request); }
        if (valueWei !== BNB_AMOUNT_WEI) {
          return responseJson({ error: "The transaction amount does not equal exactly 0.0001 BNB." }, 400, request);
        }

        if (walletAddress && tx.from && tx.from.toLowerCase() !== walletAddress.toLowerCase()) {
          return responseJson({ error: "The transaction sender does not match the connected wallet." }, 400, request);
        }

        const payment = { txHash, from: tx.from, blockNumber: tx.blockNumber, chainId: BNB_CHAIN_ID };
        const emailResult = await sendEntryEmail(entry, payment, env);
        if (!emailResult.sent) console.error("BNB entry email was not sent", emailResult.reason);

        return responseJson({
          success: true,
          paymentMethod: "BNB",
          txHash,
          amountBnb: "0.0001",
          recipient: BNB_RECIPIENT,
          emailSent: emailResult.sent,
          emailWarning: emailResult.sent ? null : emailResult.reason
        }, 200, request);
      } catch (error) {
        console.error("BNB verification error", error);
        return responseJson({ error: "Could not verify the BNB transaction right now. Please try again." }, 502, request);
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const assetRequest = new Request(new URL("/main.html", request.url), request);
      const response = await env.ASSETS.fetch(assetRequest);
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      headers.set("x-frame-options", "DENY");
      headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      headers.set("cache-control", "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("x-frame-options", "DENY");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!url.pathname.startsWith("/api/")) {
      const isHtml = (headers.get("content-type") || "").includes("text/html");
      headers.set("cache-control", isHtml
        ? "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
        : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
