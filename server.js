const path = require('path');
const express = require('express');
const { pool, init } = require('./db');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const NAME_MAX = 50;
const COMMENT_MAX = 500;

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

  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > COMMENT_MAX) {
    return { error: `Comment can be at most ${COMMENT_MAX} characters.` };
  }

  return { data: { name: name || null, rating, comment: comment || null } };
}

// Create feedback
app.post('/feedback', async (req, res) => {
  const { data, error } = validateFeedback(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { rows } = await pool.query(
      `INSERT INTO feedback (name, rating, comment)
       VALUES ($1, $2, $3)
       RETURNING id, name, rating, comment, created_at`,
      [data.name, data.rating, data.comment]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /feedback failed:', err);
    res.status(500).json({ error: 'Could not save feedback.' });
  }
});

// List feedback, newest first. Optional ?rating=1..5 filters the list.
// Stats (average + count) always cover ALL feedback, not just the filtered list.
app.get('/feedback', async (req, res) => {
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
          `SELECT id, name, rating, comment, created_at FROM feedback
           WHERE rating = $1 ORDER BY created_at DESC, id DESC`,
          [ratingFilter]
        )
      : await pool.query(
          `SELECT id, name, rating, comment, created_at FROM feedback
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

// Delete feedback
app.delete('/feedback/:id', async (req, res) => {
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

// Owner page (hidden link, no login yet)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Bean There feedback running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
