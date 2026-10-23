# Clearwater Coffee – Customer Feedback

Customers leave a rating and comment from a QR code on the table; the owner reads everything on a hidden `/admin` page.

- **Customer page:** `/`. Rating (required), name (optional), phone (required), comment (optional, 500 chars), photo (optional). Below the form, a public list of reviews showing **only name, date, comment and photo** (no phone, no rating).
- **Owner page:** `/admin`. Locked by an admin code. After unlocking: average, total, rating filter, every review with phone and photo, and **Delete**.

## Admin login

`/admin` asks for the admin password. Only **one email can be admin**: `ADMIN_EMAIL` (default `owner@example.com`).

**Set or change the password:** on `/admin`, tap **Forgot password? Set a new one** → enter the admin email → a 6-digit code is emailed → enter the code and a new password (8+ characters). That device is then logged in.

- Any other email gets the same "if that email belongs to the admin…" reply, but no email is sent, so nobody can find out the admin address.
- Codes expire after 10 minutes, allow 5 tries, and can be requested once a minute (max 5 requests per IP per hour).
- Passwords are stored hashed (scrypt) in the `admin_auth` table.
- Changing the password logs out every other device.
- Before a password is set, the `ADMIN_CODE` env variable (if present) works as the password.
- 5 wrong passwords from one IP blocks that IP for 15 minutes.
- The admin-only API (`GET /feedback`, `DELETE /feedback/:id`) returns `401` without the login cookie.

### Email (Brevo)

Codes are emailed through [Brevo](https://brevo.com)'s HTTP API, because Railway blocks outgoing SMTP on most plans. Once one sender address is verified, Brevo can send to any recipient on the free plan, so the site owner's own Gmail can send codes to the admin.

1. Sign up at brevo.com (free).
2. **Senders, domains and dedicated IPs → Senders → Add a sender**, using the address that should send the codes, then confirm it from that inbox.
3. **SMTP and API → API keys → Generate a new API key** → copy it (starts with `xkeysib-`).
4. Railway → web service → **Variables** → add `BREVO_API_KEY` (the key) and `MAIL_FROM_EMAIL` (the verified sender address).

Resend also works (`RESEND_API_KEY`, optional `MAIL_FROM`), but without a verified domain it only delivers to the Resend account owner's own email.

Locally, without a key, emails are printed to the server console instead.

## Stack

- Node.js + Express (API and static pages)
- PostgreSQL (`pg`)
- Plain HTML/CSS/JS frontend (in `public/`)
- Hosted on Railway

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Without `DATABASE_URL`, the app uses an in-memory database (pg-mem), so data resets every restart. To use a real Postgres locally, set `DATABASE_URL=postgres://...` first.

## Database

Created automatically on startup:

| Column       | Type          | Notes                     |
|--------------|---------------|---------------------------|
| `id`         | SERIAL PK     |                           |
| `name`       | VARCHAR(50)   | null = "Anonymous"        |
| `rating`     | INTEGER       | required, 1–5 (CHECK)     |
| `comment`    | VARCHAR(500)  | optional                  |
| `phone`      | VARCHAR(20)   | required by the API       |
| `photo`      | TEXT          | optional, base64 image    |
| `photo_type` | VARCHAR(30)   | e.g. `image/jpeg`         |
| `created_at` | TIMESTAMPTZ   | default `NOW()`           |

## API

| Method | Path              | Description |
|--------|-------------------|-------------|
| POST   | `/feedback`       | Body `{ name?, phone, rating, comment?, photo? }` (`photo` is a `data:image/...;base64,` URL). Returns `201` with the new row, or `400` with `{ error }`. |
| GET    | `/feedback/public` | Public list: `{ items: [{ id, name, comment, created_at, has_photo }] }`, newest 100. |
| POST   | `/admin/login`    | Body `{ password }`. Sets the admin cookie. |
| POST   | `/admin/reset/request` | Body `{ email }`. Emails a 6-digit code if it's the admin email. |
| POST   | `/admin/reset/confirm` | Body `{ email, code, newPassword }`. Saves the password and logs in. |
| POST   | `/admin/logout`   | Clears the admin cookie. |
| GET    | `/admin/session`  | `{ loggedIn, configured }`. |
| GET    | `/feedback` (admin) | Returns `{ items, stats: { average, count } }`, newest first. Optional `?rating=1..5` filters `items`. |
| GET    | `/feedback/:id/photo` | The review's photo. |
| DELETE | `/feedback/:id` (admin) | Returns `204`, or `404` if not found. |

**Filter decision:** `stats` (the average and total at the top of `/admin`) always cover **all** reviews, even when a rating filter is active. Filtering to "1 star" would otherwise always show "1.0 ★", which tells the owner nothing. The admin page shows "Showing X of Y reviews" instead.

## Deploy to Railway

1. Push this folder to a GitHub repository.
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → pick the repo.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the web service → **Variables** → add
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`, plus `BREVO_API_KEY` and `MAIL_FROM_EMAIL` (see *Email* above)
5. Web service → **Settings → Networking → Generate Domain**.
6. Open `https://<your-domain>/` on your phone, and `https://<your-domain>/admin` for the owner view. Turn the first URL into a QR code.

Railway runs `npm install` and `npm start` automatically and sets `PORT`.

## Acceptance tests (Maya's checklist)

1. Leave a 5-star review with a comment on a phone → thank-you message, form clears.
2. Submit without stars → "Please choose a rating" error, nothing sent.
3. Paste a very long comment → stops at 500, counter shows `500 / 500`.
4. `/admin` → newest review at the top, correct average.
5. Delete a review → "Are you sure?" → it disappears, average updates.
6. Filter "1 ★" → only 1-star reviews.
