const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

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

function basicAuth(keyId, keySecret) {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

async function razorpayRequest(path, env, init = {}) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", basicAuth(keyId, keySecret));
  headers.set("Content-Type", "application/json");

  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendEntryEmail(entry, payment, order, env) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.RESEND_FROM) {
    return { sent: false, reason: "Email service is not configured." };
  }

  const subject = `Lucky Draw Entry — ${order.id}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111827">
      <h2>🎉 New Lucky Draw Entry</h2>
      <p>A new entry was confirmed after a captured Razorpay payment.</p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px">
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Name</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Email</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.email)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Phone</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.phone || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Amount</b></td><td style="padding:8px;border:1px solid #ddd">₹${(payment.amount / 100).toFixed(2)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment ID</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.id)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Order ID</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(order.id)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Payment status</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(payment.status)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><b>Submitted at</b></td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(entry.submittedAt)}</td></tr>
      </table>
      <p style="margin-top:18px;font-size:13px;color:#6b7280">The entry details are also attached to the Razorpay order notes as a server-side backup.</p>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `lucky-draw-entry:${payment.id}`
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
    if (request.method === "OPTIONS") {
      return responseJson({ ok: true }, 200, request);
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      const amount = Number(env.ENTRY_FEE_PAISE);
      const configured = Boolean(
        env.RAZORPAY_KEY_ID &&
        env.RAZORPAY_KEY_SECRET &&
        Number.isInteger(amount) &&
        amount >= 100
      );

      return responseJson({
        configured,
        keyId: configured ? env.RAZORPAY_KEY_ID : null,
        amount: configured ? amount : null,
        currency: "INR"
      }, 200, request);
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
      try {
        body = await request.json();
      } catch {
        return responseJson({ error: "Invalid JSON request." }, 400, request);
      }

      const name = clean(body?.name, 100);
      const email = clean(body?.email, 160).toLowerCase();
      const phone = clean(body?.phone, 25);

      if (!name || !isValidEmail(email)) {
        return responseJson({ error: "Please provide a valid name and email address." }, 400, request);
      }

      const submittedAt = new Date().toISOString();
      const receipt = `LD-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`.slice(0, 40);
      const notes = {
        entry_name: name,
        entry_email: email,
        entry_phone: phone || "Not provided",
        entry_submitted_at: submittedAt
      };

      const { response, data } = await razorpayRequest("/orders", env, {
        method: "POST",
        body: JSON.stringify({
          amount,
          currency: "INR",
          receipt,
          partial_payment: false,
          notes
        })
      });

      if (!response.ok) {
        console.error("Razorpay create-order error", response.status, data);
        return responseJson({ error: "Unable to create the payment order." }, 502, request);
      }

      return responseJson({
        id: data.id,
        amount: data.amount,
        currency: data.currency,
        receipt: data.receipt
      }, 200, request);
    }

    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
        return responseJson({ error: "Payment gateway is not configured yet." }, 503, request);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return responseJson({ error: "Invalid JSON request." }, 400, request);
      }

      const orderId = clean(body?.razorpay_order_id, 80);
      const paymentId = clean(body?.razorpay_payment_id, 80);
      const signature = clean(body?.razorpay_signature, 128);

      if (!orderId || !paymentId || !signature) {
        return responseJson({ error: "Incomplete payment response." }, 400, request);
      }

      const generated = await hmacHex(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET);
      if (!safeEqual(generated, signature)) {
        return responseJson({ error: "Payment verification failed." }, 400, request);
      }

      const orderResult = await razorpayRequest(`/orders/${encodeURIComponent(orderId)}`, env, { method: "GET" });
      if (!orderResult.response.ok) {
        console.error("Razorpay order fetch error", orderResult.response.status, orderResult.data);
        return responseJson({ error: "Could not verify the payment order." }, 502, request);
      }

      const order = orderResult.data;
      const expectedAmount = Number(env.ENTRY_FEE_PAISE);
      if (order.amount !== expectedAmount || order.currency !== "INR") {
        return responseJson({ error: "Payment amount does not match the configured entry fee." }, 400, request);
      }

      const paymentResult = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`, env, { method: "GET" });
      if (!paymentResult.response.ok) {
        console.error("Razorpay payment fetch error", paymentResult.response.status, paymentResult.data);
        return responseJson({ error: "Could not verify the payment status." }, 502, request);
      }

      const payment = paymentResult.data;
      if (payment.order_id !== order.id || payment.amount !== expectedAmount || payment.status !== "captured") {
        return responseJson({ error: "Payment has not been captured or does not match this order." }, 400, request);
      }

      const entry = entryFromOrder(order);
      if (!entry.name || !isValidEmail(entry.email)) {
        return responseJson({ error: "The entry details attached to the payment are invalid." }, 400, request);
      }

      const emailResult = await sendEntryEmail(entry, payment, order, env);
      if (!emailResult.sent) {
        console.error("Entry email was not sent", emailResult.reason);
      }

      return responseJson({
        success: true,
        orderId: order.id,
        paymentId: payment.id,
        emailSent: emailResult.sent,
        emailWarning: emailResult.sent ? null : emailResult.reason
      }, 200, request);
    }

    return env.ASSETS.fetch(request);
  }
};
