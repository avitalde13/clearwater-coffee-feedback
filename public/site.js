// Shared bits for the website pages (landing page and menu):
// - fade sections in as they scroll into view
// - the "Owner login" dialog (email + password), which sends the owner to /admin

document.documentElement.classList.add('js');

// ----- Fade in on scroll -----
(function () {
  const items = document.querySelectorAll('.on-scroll');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('seen'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('seen');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  items.forEach((el) => io.observe(el));
})();

// ----- Owner login -----
(function () {
  const dialog = document.getElementById('owner-login');
  if (!dialog) return;
  const form = dialog.querySelector('form');
  const emailInput = dialog.querySelector('input[type="email"]');
  const input = dialog.querySelector('input[type="password"]');
  const error = dialog.querySelector('.field-error');
  const submit = dialog.querySelector('button[type="submit"]');

  function open() {
    error.hidden = true;
    input.value = '';
    emailInput.value = '';
    // Already logged in on this device? Go straight to the dashboard.
    fetch('/admin/session')
      .then((r) => r.json())
      .then((s) => {
        if (s.loggedIn) location.href = '/admin';
      })
      .catch(() => {});
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else location.href = '/admin'; // very old browsers: use the admin page's own login
    setTimeout(() => emailInput.focus(), 50);
  }

  document.querySelectorAll('[data-owner-login]').forEach((btn) => btn.addEventListener('click', open));
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // tap outside the card
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (!emailInput.value.trim() || !input.value) {
      error.textContent = 'Enter your email and password.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value, password: input.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong, please try again.');
      location.href = '/admin'; // the admin page asks for a new password if this was the temporary one
    } catch (err) {
      error.textContent = err.message === 'Failed to fetch' ? 'Something went wrong, please try again.' : err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
})();
