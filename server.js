const path = require('path');
const express = require('express');
const { pool, init } = require('./db');
const { setupAdminAuth } = require('./auth');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy: needed for req.ip and req.secure
// Photos arrive as base64 inside JSON, so allow a few MB.
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin login, logout and "set a new password" by email code. See auth.js.
const { requireAdmin } = setupAdminAuth(app, pool);

const NAME_MAX = 50;
const COMMENT_MAX = 500;
const PHONE_MAX = 20;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Accepts "+972 50-123-4567", "(050) 123 4567", etc. 7–15 digits, optional leading +.
function isValidPhone(phone) {
  const compact = phone.replace(/[\s\-().]/g, '');
  return /^\+?\d{7,15}$/.test(compact);
}

// Parses "data:image/jpeg;base64,...". Returns { buffer, type } or { error }.
function parsePhoto(dataUrl) {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !PHOTO_TYPES.includes(match[1])) {
    return { error: 'Photo must be a JPG, PNG or WebP image.' };
  }
  if (Buffer.byteLength(match[2], 'base64') > PHOTO_MAX_BYTES) {
    return { error: 'Photo is too large (max 2 MB).' };
  }
  return { base64: match[2], type: match[1] };
}

// Validate and clean the request body. Returns { data } or { error }.
function validateFeedback(body) {
  const rating = Number(body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: 'Rating is required and must be a whole number from 1 to 5.' };
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > NAME_MAX) {
    return { error: `Name can be at most ${NAME_MAX} characters.` };
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!phone) {
    return { error: 'Phone number is required.' };
  }
  if (phone.length > PHONE_MAX || !isValidPhone(phone)) {
    return { error: 'Please enter a valid phone number.' };
  }

  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > COMMENT_MAX) {
    return { error: `Comment can be at most ${COMMENT_MAX} characters.` };
  }

  let photo = null;
  if (body.photo) {
    if (typeof body.photo !== 'string') return { error: 'Invalid photo.' };
    const parsed = parsePhoto(body.photo);
    if (parsed.error) return { error: parsed.error };
    photo = parsed;
  }

  return { data: { name: name || null, phone, rating, comment: comment || null, photo } };
}

// Admin sees everything; the public never sees phone numbers (or ratings, per the owner's request).
const LIST_COLUMNS = 'id, name, phone, rating, comment, created_at, (photo IS NOT NULL) AS has_photo';
const PUBLIC_COLUMNS = 'id, name, comment, created_at, (photo IS NOT NULL) AS has_photo';
const PUBLIC_LIMIT = 100;

// Create feedback
async function createFeedback(req, res) {
  const { data, error } = validateFeedback(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { rows } = await pool.query(
      `INSERT INTO feedback (name, phone, rating, comment, photo, photo_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PUBLIC_COLUMNS}`,
      [data.name, data.phone, data.rating, data.comment, data.photo?.base64 ?? null, data.photo?.type ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /feedback failed:', err);
    res.status(500).json({ error: 'Could not save feedback.' });
  }
}
app.post('/api/feedback', createFeedback);
app.post('/feedback', createFeedback); // old address, for pages opened before the move to /api

// Public list for the customer page: name, comment, date, photo. No phone numbers.
app.get('/api/feedback/public', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM feedback
       ORDER BY created_at DESC, id DESC LIMIT ${PUBLIC_LIMIT}`
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('GET /feedback/public failed:', err);
    res.status(500).json({ error: 'Could not load feedback.' });
  }
});

// Admin list, newest first. Optional ?rating=1..5 filters the list.
// Stats (average + count) always cover ALL feedback, not just the filtered list.
app.get('/api/feedback', requireAdmin, async (req, res) => {
  let ratingFilter = null;
  if (req.query.rating !== undefined && req.query.rating !== '') {
    ratingFilter = Number(req.query.rating);
    if (!Number.isInteger(ratingFilter) || ratingFilter < 1 || ratingFilter > 5) {
      return res.status(400).json({ error: 'rating filter must be 1 to 5.' });
    }
  }

  try {
    const list = ratingFilter
      ? await pool.query(
          `SELECT ${LIST_COLUMNS} FROM feedback
           WHERE rating = $1 ORDER BY created_at DESC, id DESC`,
          [ratingFilter]
        )
      : await pool.query(
          `SELECT ${LIST_COLUMNS} FROM feedback
           ORDER BY created_at DESC, id DESC`
        );

    const stats = await pool.query('SELECT COUNT(*) AS count, AVG(rating) AS average FROM feedback');
    const count = Number(stats.rows[0].count);
    const average = count ? Math.round(Number(stats.rows[0].average) * 10) / 10 : null;

    res.json({ items: list.rows, stats: { average, count } });
  } catch (err) {
    console.error('GET /feedback failed:', err);
    res.status(500).json({ error: 'Could not load feedback.' });
  }
});

// Serve a review's photo
app.get('/api/feedback/:id/photo', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).end();

  try {
    const { rows } = await pool.query('SELECT photo, photo_type FROM feedback WHERE id = $1', [id]);
    if (!rows[0]?.photo) return res.status(404).end();
    res.set('Content-Type', rows[0].photo_type || 'image/jpeg');
    res.set('Cache-Control', 'private, no-cache');
    res.send(Buffer.from(rows[0].photo, 'base64'));
  } catch (err) {
    console.error('GET /feedback/:id/photo failed:', err);
    res.status(500).end();
  }
});

// Delete feedback (admin only)
app.delete('/api/feedback/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id.' });
  }

  try {
    const result = await pool.query('DELETE FROM feedback WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Feedback not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /feedback failed:', err);
    res.status(500).json({ error: 'Could not delete feedback.' });
  }
});

// Pages. "/" is the landing page (public/index.html, served by express.static).
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/menu', page('menu.html'));
app.get('/feedback', page('feedback.html')); // the QR code on the tables points here
// Owner page. The page itself is public; it asks for the admin password before showing any data.
app.get('/admin', page('admin.html'));

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Clearwater Coffee feedback running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
