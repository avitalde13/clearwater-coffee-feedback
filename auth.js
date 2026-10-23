// Admin authentication.
//
// - The owner logs in to /admin with a password.
// - The first password is the ADMIN_CODE environment variable (set in Railway and sent to the owner).
// - ADMIN_CODE is temporary: after logging in with it, the owner MUST choose a new password before
//   seeing any data. The new password is stored hashed in the admin_auth table and replaces ADMIN_CODE.
// - Forgotten password: set a NEW ADMIN_CODE in Railway. A changed ADMIN_CODE overrides the saved
//   password, so the owner can log in with the new code and pick a password again.
// - Sessions are an HttpOnly cookie derived from the current password, so changing the password
//   logs out every other device.

const crypto = require('crypto');

const ADMIN_CODE = process.env.ADMIN_CODE || '';
const ADMIN_NAME = (process.env.ADMIN_NAME || '').trim(); // shown as "Hello <name>" on the dashboard
const SESSION_COOKIE = 'admin_session';
const SESSION_DAYS = 7;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 100;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const ADMIN_CODE_FP = ADMIN_CODE ? sha256(ADMIN_CODE).toString('hex') : null;

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

  async function getRow() {
    const { rows } = await pool.query('SELECT * FROM admin_auth WHERE id = 1');
    if (rows[0]) return rows[0];
    await pool.query('INSERT INTO admin_auth (id, code_attempts) VALUES (1, 0)');
    return (await pool.query('SELECT * FROM admin_auth WHERE id = 1')).rows[0];
  }

  // Which credential is active right now?
  // The saved password wins, unless ADMIN_CODE was changed after it was saved (= a reset).
  function activeCredential(row) {
    const savedStillValid = row.password_hash && (!ADMIN_CODE_FP || row.admin_code_fp === ADMIN_CODE_FP);
    if (savedStillValid) return { type: 'password', key: row.password_hash };
    if (ADMIN_CODE) return { type: 'code', key: `code:${ADMIN_CODE_FP}` };
    return null;
  }

  function checkPassword(row, password) {
    const cred = activeCredential(row);
    if (!cred) return false;
    return cred.type === 'password' ? verifyPassword(password, row.password_hash) : safeEqual(password, ADMIN_CODE);
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

  // Returns the active credential if this request has a valid session cookie, else null.
  async function sessionCredential(req) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (!cookie) return null;
    const cred = activeCredential(await getRow());
    return cred && safeEqual(cookie, sessionToken(cred.key)) ? cred : null;
  }

  // Middleware. Logged in with the temporary ADMIN_CODE only counts when allowTemporary is set
  // (the change-password route); everything else needs a real password first.
  function guard(allowTemporary) {
    return async (req, res, next) => {
      try {
        const cred = await sessionCredential(req);
        if (!cred) return res.status(401).json({ error: 'Admin login required.' });
        if (cred.type === 'code' && !allowTemporary) {
          return res.status(403).json({ error: 'Please change your password to continue.', mustChangePassword: true });
        }
        next();
      } catch (err) {
        console.error('Admin check failed:', err);
        res.status(500).json({ error: 'Something went wrong.' });
      }
    };
  }
  const requireAdmin = guard(false);
  const requireLogin = guard(true);

  app.get('/admin/session', async (req, res) => {
    try {
      const row = await getRow();
      const cred = await sessionCredential(req);
      res.json({
        loggedIn: Boolean(cred),
        configured: Boolean(activeCredential(row)),
        mustChangePassword: cred?.type === 'code',
        name: cred ? ADMIN_NAME : '',
      });
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
      const cred = activeCredential(row);
      if (!cred) return res.status(503).json({ error: 'Admin access is not set up yet.' });
      if (!checkPassword(row, password)) {
        loginLimiter.hit(req.ip);
        return res.status(401).json({ error: 'Wrong password.' });
      }
      loginLimiter.clear(req.ip);
      setSessionCookie(req, res, cred.key);
      res.json({ ok: true, mustChangePassword: cred.type === 'code', name: ADMIN_NAME });
    } catch (err) {
      console.error('POST /admin/login failed:', err);
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
  });

  app.post('/admin/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Change password (logged in). Needs the current password too, in case a phone is left unlocked.
  app.post('/admin/password', requireLogin, async (req, res) => {
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (next.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters.` });
    }
    if (next.length > PASSWORD_MAX) {
      return res.status(400).json({ error: `New password can be at most ${PASSWORD_MAX} characters.` });
    }

    try {
      const row = await getRow();
      if (!checkPassword(row, current)) {
        return res.status(400).json({ error: 'Your current password is wrong.' });
      }
      if (safeEqual(next, current)) {
        return res.status(400).json({ error: 'Choose a new password that is different from the current one.' });
      }
      const passwordHash = hashPassword(next);
      await pool.query('UPDATE admin_auth SET password_hash = $1, admin_code_fp = $2 WHERE id = 1', [
        passwordHash,
        ADMIN_CODE_FP,
      ]);
      setSessionCookie(req, res, passwordHash); // other devices are logged out automatically
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /admin/password failed:', err);
      res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
  });

  return { requireAdmin };
}

module.exports = { setupAdminAuth };
