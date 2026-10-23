# Bean There Café – Customer Feedback

Customers leave a rating and comment from a QR code on the table; the owner reads everything on a hidden `/admin` page.

- **Customer page:** `/`. Rating (required), name (optional), phone (required), comment (optional, 500 chars), photo (optional). Customers never see other reviews.
- **Owner page:** `/admin`. Average, total, rating filter, every review with phone and photo, and **Delete** (no login yet, hidden link only).

The reviews view (summary, filter, list) lives in `public/reviews.js`.

Photos are resized in the browser (max 1600px, JPEG) before upload and stored in Postgres as base64 (max 2 MB).

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
| GET    | `/feedback`       | Returns `{ items, stats: { average, count } }`, newest first. Optional `?rating=1..5` filters `items`. |
| GET    | `/feedback/:id/photo` | The review's photo. |
| DELETE | `/feedback/:id`   | Returns `204`, or `404` if not found. |

**Filter decision:** `stats` (the average and total at the top of `/admin`) always cover **all** reviews, even when a rating filter is active. Filtering to "1 star" would otherwise always show "1.0 ★", which tells the owner nothing. The admin page shows "Showing X of Y reviews" instead.

## Deploy to Railway

1. Push this folder to a GitHub repository.
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → pick the repo.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the web service → **Variables** → add
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
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
