// Shared reviews view: summary (average + total), rating filter, and list.
// Used by /admin. Talks to the admin-only API; calls onUnauthorized if the session is gone
// or the password still has to be changed.
//
//   const view = mountReviews(rootElement, { canDelete: true });
//   view.load();   // fetch and render

function mountReviews(root, { canDelete = false, onUnauthorized = () => {} } = {}) {
  root.innerHTML = `
    <section class="summary" aria-label="Summary">
      <div class="stat"><div class="k">Average rating</div><div class="v" data-avg>–</div></div>
      <div class="stat"><div class="k">Total reviews</div><div class="v" data-count>–</div></div>
    </section>
    <div class="alert err" role="alert" data-load-error hidden>Couldn't load feedback. Check your connection and refresh.</div>
    <nav class="filters" aria-label="Filter by rating">
      <button class="chip active" data-rating="">All</button>
      <button class="chip" data-rating="5">5 ★</button>
      <button class="chip" data-rating="4">4 ★</button>
      <button class="chip" data-rating="3">3 ★</button>
      <button class="chip" data-rating="2">2 ★</button>
      <button class="chip" data-rating="1">1 ★</button>
    </nav>
    <p class="showing" data-showing></p>
    <ul class="list" data-list></ul>
    <div class="empty" data-empty hidden>
      <div class="big" aria-hidden="true">☕</div>
      <p data-empty-text>No feedback yet</p>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const avgEl = $('[data-avg]');
  const countEl = $('[data-count]');
  const listEl = $('[data-list]');
  const emptyEl = $('[data-empty]');
  const emptyText = $('[data-empty-text]');
  const showingEl = $('[data-showing]');
  const loadError = $('[data-load-error]');
  let currentRating = '';

  const dateFmt = new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  function starsHtml(n) {
    return '★'.repeat(n) + `<span class="off">${'★'.repeat(5 - n)}</span>`;
  }

  // Build each review with textContent so customer text can't inject HTML.
  function renderItem(item, index) {
    const li = document.createElement('li');
    li.className = 'review';
    li.style.setProperty('--i', Math.min(index, 8));

    const top = document.createElement('div');
    top.className = 'review-top';

    const left = document.createElement('div');
    left.className = 'review-who';
    const avatar = document.createElement('div');
    avatar.className = 'avatar' + (item.name ? '' : ' anon');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = item.name ? item.name.trim().charAt(0).toUpperCase() : '?';
    const meta = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'review-name' + (item.name ? '' : ' anon');
    name.textContent = item.name || 'Anonymous';
    const stars = document.createElement('div');
    stars.className = 'review-stars';
    stars.setAttribute('aria-label', `${item.rating} out of 5 stars`);
    stars.innerHTML = starsHtml(item.rating);
    const date = document.createElement('div');
    date.className = 'review-date';
    date.textContent = dateFmt.format(new Date(item.created_at));
    meta.append(name, stars, date);
    left.append(avatar, meta);

    if (item.phone) {
      const phone = document.createElement('a');
      phone.className = 'review-phone';
      phone.href = `tel:${item.phone.replace(/[^\d+]/g, '')}`;
      phone.textContent = `📞 ${item.phone}`;
      meta.append(phone);
    }
    top.append(left);

    if (canDelete) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Delete';
      del.addEventListener('click', () => removeItem(item, del));
      top.append(del);
    }

    li.append(top);

    if (item.comment) {
      const p = document.createElement('p');
      p.className = 'review-comment';
      p.textContent = item.comment;
      li.append(p);
    }

    if (item.has_photo) {
      const link = document.createElement('a');
      link.href = `/feedback/${item.id}/photo`;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'review-photo';
      img.src = `/feedback/${item.id}/photo`;
      img.alt = 'Photo from customer';
      img.loading = 'lazy';
      link.append(img);
      li.append(link);
    }
    return li;
  }

  async function load() {
    try {
      const url = currentRating ? `/feedback?rating=${currentRating}` : '/feedback';
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) return onUnauthorized();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { items, stats } = await res.json();
      loadError.hidden = true;

      avgEl.innerHTML = stats.count ? `${stats.average.toFixed(1)} <span class="s">★</span>` : '–';
      countEl.textContent = stats.count;

      listEl.replaceChildren(...items.map(renderItem));
      emptyEl.hidden = items.length > 0;
      emptyText.textContent = stats.count === 0
        ? 'No feedback yet'
        : `No ${currentRating}-star reviews`;
      showingEl.textContent = currentRating
        ? `Showing ${items.length} of ${stats.count} reviews (average above is for all reviews)`
        : '';
    } catch (err) {
      loadError.hidden = false;
    }
  }

  async function removeItem(item, btn) {
    const who = item.name || 'Anonymous';
    if (!confirm(`Are you sure you want to delete this review from ${who}?`)) return;

    btn.disabled = true;
    try {
      const res = await fetch(`/feedback/${item.id}`, { method: 'DELETE' });
      if (res.status === 401 || res.status === 403) return onUnauthorized();
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      btn.disabled = false;
      alert('Something went wrong, the review was not deleted. Please try again.');
    }
  }

  root.querySelector('.filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    currentRating = chip.dataset.rating;
    root.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    load();
  });

  return { load };
}
