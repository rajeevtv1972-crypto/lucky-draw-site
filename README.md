# Lucky Draw Site

Cloudflare Worker + static site for a paid lucky-draw entry flow.

## What is included

- `main.html` — public entry page with 7-day countdown.
- `index.html` — site root entry point.
- `worker.js` — private backend for Razorpay order creation, payment verification, and email delivery.
- `wrangler.jsonc` — Workers Static Assets configuration.

## Payment setup

This project uses Razorpay Standard Checkout. Razorpay requires the server to create an order before checkout, and the successful payment signature must be verified server-side before accepting the entry. Payment status is also checked from the backend.

Add the following in Cloudflare **Workers & Pages → lucky-draw-site → Settings → Variables and Secrets**:

### Plaintext variable

`ENTRY_FEE_PAISE`

Example: `1000` = ₹10.00. Choose the entry fee you actually want before going live.

### Secrets

`RAZORPAY_KEY_ID`

`RAZORPAY_KEY_SECRET`

`RESEND_API_KEY`

`ADMIN_EMAIL`

`RESEND_FROM`

`RESEND_FROM` should use a sender/domain that your Resend account allows.

Do not put API keys or secrets in `wrangler.jsonc` or `main.html`. Cloudflare recommends Worker Secrets for sensitive values.

After adding/updating the variables and secrets, deploy again with:

```bash
npx wrangler deploy
```

The public page calls the Worker APIs at:

- `GET /api/config`
- `POST /api/create-order`
- `POST /api/verify-payment`

After a captured payment is verified, the backend sends the entry details to `ADMIN_EMAIL`. The same entry details are also stored in the Razorpay order notes as a server-side backup.
