// Admin authentication.
//
// - The owner logs in to /admin with a password.
// - Before a password is set, the ADMIN_CODE environment variable works as the password.
// - "Set a new password": the owner enters their email, gets a 6-digit code by email,
//   and enters the code plus a new password. Only ADMIN_EMAIL can receive codes.
// - Sessions are an HttpOnly cookie derived from the current password, so changing
//   the password logs out every device.

const crypto = require('crypto');
const { sendMail } = require('./mailer');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'owner@example.com').trim().toLowerCase();
const ADMIN_CODE = process.env.ADMIN_CODE || '';
const SESSION_COOKIE = 'admin_session';
const SESSION_DAYS = 7;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_MS = 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 100;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// ----- Password hashing (scrypt, built into Node) -----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ----- Simple in-memory rate limiter: max `limit` hits per key per window -----
function makeLimiter(limit, windowMs) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    blocked(key) {
      const e = hits.get(key);
      return Boolean(e && e.resetAt > Date.now() && e.count >= limit);
    },
    hit(key) {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || e.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else e.count += 1;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setupAdminAuth(app, pool) {
  const loginLimiter = makeLimiter(5, 15 * 60 * 1000);
  const resetLimiter = makeLimiter(5, 60 * 60 * 1000);

  async function getRow() {
    const { rows } = await pool.query('SELECT * FROM admin_auth WHERE id = 1');
    if (rows[0]) return rows[0];
    await pool.query('INSERT INTO admin_auth (id, code_attempts) VALUES (1, 0)');
    return (await pool.query('SELECT * FROM admin_auth WHERE id = 1')).rows[0];
  }

  // The secret that sessions are tied to: the password hash, or ADMIN_CODE before one is set.
  function credentialKey(row) {
    if (row.password_hash) return row.password_hash;
    if (ADMIN_CODE) return `code:${sha256(ADMIN_CODE).toString('hex')}`;
    return null;
  }

  function sessionToken(key) {
    return crypto.createHmac('sha256', key).update('admin-session-v2').digest('hex');
  }

  function setSessionCookie(req, res, key) {
    res.cookie(SESSION_COOKIE, sessionToken(key), {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  async function isAdmin(req) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (!cookie) return false;
    const key = credentialKey(await getRow());
    return Boolean(key) && safeEqual(cookie, sessionToken(key));
  }

  async function requireAdmin(req, res, next) {
    try {
      if (await isAdmin(req)) return next();
      res.status(401).json({ error: 'Admin login required.' });
    } catch (err) {
      console.error('Admin check failed:', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }

  app.get('/admin/session', async (req, res) => {
    try {
      const row = await getRow();
      res.json({ loggedIn: await isAdmin(req), configured: Boolean(credentialKey(row)) });
    } catch (err) {
      console.error('GET /admin/session failed:', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  app.post('/admin/login', async (req, res) => {
    if (loginLimiter.blocked(req.ip)) {
      return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    try {
      const row = await getRow();
      const key = credentialKey(row);
      if (!key) {
        return res.status(503).json({ error: 'No admin password yet. Use "Set a new password" below.' });
      }
      const ok = row.password_hash ? verifyPassword(password, row.password_hash) : safeEqual(password, ADMIN_CODE);
      if (!ok) {
        loginLimiter.hit(req.ip);
        return res.status(401).json({ error: 'Wrong password.' });
      }
      loginLimiter.clear(req.ip);
      setSessionCookie(req, res, key);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /admin/login failed:', err);
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
  });

  app.post('/admin/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Step 1 of "Set a new password": email a 6-digit code to the admin.
  // Always answers the same way, so nobody can find out which email is the admin's.
  app.post('/admin/reset/request', async (req, res) => {
    const generic = { ok: true, message: 'If that email belongs to the admin, a code is on its way. It expires in 10 minutes.' };
    if (resetLimiter.blocked(req.ip)) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    resetLimiter.hit(req.ip);

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'Enter your email.' });
    if (email !== ADMIN_EMAIL) return res.json(generic);

    try {
      const row = await getRow();
      if (row.code_sent_at && Date.now() - Number(row.code_sent_at) < CODE_RESEND_MS) {
        return res.json(generic); // a code was just sent; don't flood the inbox
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await pool.query(
        `UPDATE admin_auth SET code_hash = $1, code_expires = $2, code_attempts = 0, code_sent_at = $3 WHERE id = 1`,
        [sha256(code).toString('hex'), Date.now() + CODE_TTL_MS, Date.now()]
      );

      await sendMail({
        to: ADMIN_EMAIL,
        subject: `Your Clearwater Coffee admin code: ${code}`,
        text:
          `Your verification code is ${code}\n\n` +
          `Enter it on the admin page to set a new password. It expires in 10 minutes.\n\n` +
          `If you didn't ask for this, you can ignore this email. Your password has not changed.`,
      });
      res.json(generic);
    } catch (err) {
      console.error('POST /admin/reset/request failed:', err);
      res.status(500).json({ error: "Couldn't send the email. Please try again later." });
    }
  });

  // Step 2: check the code and save the new password. Logs this device in.
  app.post('/admin/reset/confirm', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (newPassword.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
    }
    if (newPassword.length > PASSWORD_MAX) {
      return res.status(400).json({ error: `Password can be at most ${PASSWORD_MAX} characters.` });
    }

    const wrong = { error: 'Wrong or expired code. Request a new one.' };
    try {
      if (email !== ADMIN_EMAIL) return res.status(400).json(wrong);
      const row = await getRow();
      const valid =
        row.code_hash &&
        Number(row.code_expires) > Date.now() &&
        row.code_attempts < CODE_MAX_ATTEMPTS;
      if (!valid) return res.status(400).json(wrong);

      if (!safeEqual(sha256(code).toString('hex'), row.code_hash)) {
        await pool.query('UPDATE admin_auth SET code_attempts = code_attempts + 1 WHERE id = 1');
        return res.status(400).json(wrong);
      }

      const passwordHash = hashPassword(newPassword);
      await pool.query(
        `UPDATE admin_auth SET password_hash = $1, code_hash = NULL, code_expires = NULL,
                code_attempts = 0, code_sent_at = NULL WHERE id = 1`,
        [passwordHash]
      );
      setSessionCookie(req, res, passwordHash); // old sessions stop working automatically
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /admin/reset/confirm failed:', err);
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
  });

  return { requireAdmin };
}

module.exports = { setupAdminAuth };
