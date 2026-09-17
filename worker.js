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

function basicAuth(keyId, keySecret) {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

async function razorpayRequest(path, env, init = {}) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", basicAuth(keyId, keySecret));
  headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.razorpay.com/v1${path}`, { ...init, headers });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { response, data };
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
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

async function createBnbIntent(entry, env) {
  if (!env.BNB_INTENT_SECRET) throw new Error("BNB_INTENT_SECRET is not configured.");
  const payload = {
    v: 1,
    exp: Date.now() + BNB_INTENT_TTL_MS,
    entry
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(encoded, env.BNB_INTENT_SECRET);
  return `${encoded}.${signature}`;
}

async function verifyBnbIntent(token, env) {
  if (!env.BNB_INTENT_SECRET || !token || !token.includes(".")) return null;
  const separator = token.lastIndexOf(".");
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await hmacHex(encoded, env.BNB_INTENT_SECRET);
  if (!safeEqual(expected, signature)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
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

  const isBnb = payment.kind === "bnb";
  const subject = `Lucky Draw Entry — ${isBnb ? payment.txHash : payment.id}`;
  const paymentRows = isBnb
    ? `
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment method</b></td><td style="padding:8px;border:1px solid #ddd">BNB on BNB Smart Chain</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Amount</b></td><td style="padding:8px;border:1px solid #ddd">0.0001 BNB</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>TX hash</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.txHash)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Recipient</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(BNB_RECIPIENT)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Chain</b></td><td style="padding:8px;border:1px solid #ddd">BSC Mainnet (56)</td></tr>`
    : `
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment method</b></td><td style="padding:8px;border:1px solid #ddd">Razorpay</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Amount</b></td><td style="padding:8px;border:1px solid #ddd">₹${(payment.amount / 100).toFixed(2)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment ID</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.id)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Order ID</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.orderId)}</td></tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111827">
      <h2>🎉 New Lucky Draw Entry</h2>
      <p>A new entry was confirmed after a verified payment.</p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Name</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Email</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.email)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Phone</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.phone || "Not provided")}</td></tr>
        ${paymentRows}
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Submitted at</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.submittedAt)}</td></tr>
      </table>
    </div>`;

  const idempotencyKey = `lucky-draw-entry:${isBnb ? payment.txHash : payment.id}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
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

function entryFromOrder(order) {
  const notes = order?.notes || {};
  return {
    name: clean(notes.entry_name),
    email: clean(notes.entry_email),
    phone: clean(notes.entry_phone),
    submittedAt: clean(notes.entry_submitted_at, 64)
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return responseJson({ ok: true }, 200, request);

    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      const amount = Number(env.ENTRY_FEE_PAISE);
      const razorpayConfigured = Boolean(
        env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && Number.isInteger(amount) && amount >= 100
      );
      return responseJson({
        razorpay: {
          configured: razorpayConfigured,
          keyId: razorpayConfigured ? env.RAZORPAY_KEY_ID : null,
          amount: razorpayConfigured ? amount : null,
          currency: "INR"
        },
        bnb: {
          configured: Boolean(env.BNB_INTENT_SECRET),
          amountBnb: "0.0001",
          amountWei: BNB_AMOUNT_WEI.toString(),
          recipient: BNB_RECIPIENT,
          chainId: BNB_CHAIN_ID
        }
      }, 200, request);
    }

    if (url.pathname === "/api/bnb-intent" && request.method === "POST") {
      if (!env.BNB_INTENT_SECRET) {
        return responseJson({ error: "BNB payment is not configured yet." }, 503, request);
      }

      let body;
      try { body = await request.json(); } catch { return responseJson({ error: "Invalid JSON request." }, 400, request); }

      const name = clean(body?.name, 100);
      const email = clean(body?.email, 160).toLowerCase();
      const phone = clean(body?.phone, 25);
      if (!name || !isValidEmail(email)) {
        return responseJson({ error: "Please provide a valid name and email address." }, 400, request);
      }

      const entry = { name, email, phone: phone || "Not provided", submittedAt: new Date().toISOString() };
      const intent = await createBnbIntent(entry, env);
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
      if (!env.BNB_INTENT_SECRET) {
        return responseJson({ error: "BNB payment is not configured yet." }, 503, request);
      }

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

      const entry = await verifyBnbIntent(intent, env);
      if (!entry) return responseJson({ error: "Payment intent is invalid or expired." }, 400, request);

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

        const payment = { kind: "bnb", txHash, from: tx.from, blockNumber: tx.blockNumber, chainId: BNB_CHAIN_ID };
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

    if (url.pathname === "/api/create-order" && request.method === "POST") {
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
        return responseJson({ error: "Payment gateway is not configured yet." }, 503, request);
      }
      const amount = Number(env.ENTRY_FEE_PAISE);
      if (!Number.isInteger(amount) || amount < 100) {
        return responseJson({ error: "ENTRY_FEE_PAISE must be configured to at least 100 paise." }, 503, request);
      }

      let body;
      try { body = await request.json(); } catch { return responseJson({ error: "Invalid JSON request." }, 400, request); }
      const name = clean(body?.name, 100);
      const email = clean(body?.email, 160).toLowerCase();
      const phone = clean(body?.phone, 25);
      if (!name || !isValidEmail(email)) return responseJson({ error: "Please provide a valid name and email address." }, 400, request);

      const submittedAt = new Date().toISOString();
      const receipt = `LD-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`.slice(0, 40);
      const notes = { entry_name: name, entry_email: email, entry_phone: phone || "Not provided", entry_submitted_at: submittedAt };
      const { response, data } = await razorpayRequest("/orders", env, {
        method: "POST",
        body: JSON.stringify({ amount, currency: "INR", receipt, partial_payment: false, notes })
      });
      if (!response.ok) {
        console.error("Razorpay create-order error", response.status, data);
        return responseJson({ error: "Unable to create the payment order." }, 502, request);
      }
      return responseJson({ id: data.id, amount: data.amount, currency: data.currency, receipt: data.receipt }, 200, request);
    }

    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return responseJson({ error: "Payment gateway is not configured yet." }, 503, request);
      let body;
      try { body = await request.json(); } catch { return responseJson({ error: "Invalid JSON request." }, 400, request); }
      const orderId = clean(body?.razorpay_order_id, 80);
      const paymentId = clean(body?.razorpay_payment_id, 80);
      const signature = clean(body?.razorpay_signature, 128);
      if (!orderId || !paymentId || !signature) return responseJson({ error: "Incomplete payment response." }, 400, request);

      const generated = await hmacHex(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET);
      if (!safeEqual(generated, signature)) return responseJson({ error: "Payment verification failed." }, 400, request);

      const orderResult = await razorpayRequest(`/orders/${encodeURIComponent(orderId)}`, env, { method: "GET" });
      if (!orderResult.response.ok) return responseJson({ error: "Could not verify the payment order." }, 502, request);
      const order = orderResult.data;
      const expectedAmount = Number(env.ENTRY_FEE_PAISE);
      if (order.amount !== expectedAmount || order.currency !== "INR") return responseJson({ error: "Payment amount does not match the configured entry fee." }, 400, request);

      const paymentResult = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`, env, { method: "GET" });
      if (!paymentResult.response.ok) return responseJson({ error: "Could not verify the payment status." }, 502, request);
      const razorPayment = paymentResult.data;
      if (razorPayment.order_id !== order.id || razorPayment.amount !== expectedAmount || razorPayment.status !== "captured") {
        return responseJson({ error: "Payment has not been captured or does not match this order." }, 400, request);
      }

      const entry = entryFromOrder(order);
      if (!entry.name || !isValidEmail(entry.email)) return responseJson({ error: "The entry details attached to the payment are invalid." }, 400, request);
      const emailResult = await sendEntryEmail(entry, {
        kind: "razorpay",
        id: razorPayment.id,
        amount: razorPayment.amount,
        orderId: order.id
      }, env);
      if (!emailResult.sent) console.error("Entry email was not sent", emailResult.reason);

      return responseJson({ success: true, orderId: order.id, paymentId: razorPayment.id, emailSent: emailResult.sent, emailWarning: emailResult.sent ? null : emailResult.reason }, 200, request);
    }

    return env.ASSETS.fetch(request);
  }
};
