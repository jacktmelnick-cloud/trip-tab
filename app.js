const { computeBalances, settleUp, parseCents, formatCents } = window.TripSplit;
const { supabaseUrl, supabaseAnonKey } = window.TRIP_TAB_CONFIG;

const CODE_KEY = 'tripTab.code';
const ME_KEY = 'tripTab.me';
const MAX_IMAGE_CHARS = 1900000;

let code = null;
let state = { people: [], receipts: [], payments: [] };
let balances = {};
let currentTab = 'settle';
let confirmingId = null;
let openPhotos = new Map();
let readAttempt = 0;

const $ = (id) => document.getElementById(id);

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private browsing: the page still works, it just won't remember */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

async function rpc(name, params = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ p_code: code, ...params }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error((body && body.message) || 'request_failed');
  return body;
}

const nameOf = (id) => (state.people.find((p) => p.id === id) || {}).name || 'Someone';
const personOf = (id) => state.people.find((p) => p.id === id);
const me = () => {
  const id = recall(ME_KEY) || $('me').value;
  return personOf(id) ? id : '';
};

function showStatus(message) {
  $('status').textContent = message;
  $('status').hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function explain(error) {
  const messages = {
    wrong_passcode: 'That passcode changed. Reload and enter the new one.',
    too_many_receipts: 'The receipt limit of 500 is full. Delete any duplicates first.',
    bad_venmo: 'Venmo usernames can only use letters, numbers, dashes and underscores.',
    bad_zelle: 'That Zelle phone or email is too long.',
  };
  return messages[error.message] || "That didn't save. Check your connection and try again.";
}

function balanceLabel(cents) {
  if (cents > 0) return `Gets back ${formatCents(cents)}`;
  if (cents < 0) return `Owes ${formatCents(-cents)}`;
  return 'All square';
}

function venmoLink(handle, cents, note) {
  const query = new URLSearchParams({ txn: 'pay', amount: (cents / 100).toFixed(2), note });
  return `https://venmo.com/${encodeURIComponent(handle)}?${query}`;
}

function copyButton(text) {
  const button = el('button', { type: 'button', textContent: 'Copy Zelle' });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = text;
    }
  });
  return button;
}

async function recordPayment(transfer, button) {
  button.disabled = true;
  try {
    await rpc('trip_add_payment', { p_from_id: transfer.fromId, p_to_id: transfer.toId, p_amount_cents: transfer.cents });
    await refresh();
    showStatus(`Checked off ${formatCents(transfer.cents)} from ${nameOf(transfer.fromId)} to ${nameOf(transfer.toId)}.`);
  } catch (error) {
    showStatus(explain(error));
    button.disabled = false;
    button.checked = false;
  }
}

async function undoPayment(payment, box) {
  box.disabled = true;
  try {
    await rpc('trip_delete_payment', { p_id: payment.id });
    await refresh();
    showStatus(`Unchecked ${formatCents(payment.amountCents)} from ${nameOf(payment.fromId)} to ${nameOf(payment.toId)}. It's back on the list.`);
  } catch (error) {
    showStatus(explain(error));
    box.disabled = false;
    box.checked = true;
  }
}

function transferRow(transfer) {
  const receiver = personOf(transfer.toId);
  const actions = el('div', { class: 'actions' });
  if (receiver.venmo) {
    actions.append(el('a', {
      class: 'button',
      href: venmoLink(receiver.venmo, transfer.cents, 'Trip Tab'),
      target: '_blank',
      rel: 'noopener noreferrer',
      textContent: `Pay @${receiver.venmo} on Venmo`,
    }));
  }
  if (receiver.zelle) {
    actions.append(el('span', { class: 'handle', textContent: `Zelle: ${receiver.zelle}` }), copyButton(receiver.zelle));
  }
  if (!receiver.venmo && !receiver.zelle) {
    actions.append(el('span', { class: 'hint', textContent: `${receiver.name} hasn't added payment info yet.` }));
  }
  const paid = el('input', { type: 'checkbox' });
  paid.addEventListener('change', () => recordPayment(transfer, paid));
  actions.append(el('label', { class: 'check' }, paid, 'Paid'));

  return el('div', { class: 'row' },
    el('div', { class: 'row-head' },
      el('span', { class: 'row-title', textContent: `${nameOf(transfer.fromId)} pays ${receiver.name}` }),
      el('span', { class: 'amount', textContent: formatCents(transfer.cents) })),
    actions);
}

function renderSettle(transfers) {
  const myId = me();
  const mine = transfers.filter((t) => t.fromId === myId || t.toId === myId);
  const myBox = $('my-transfers');
  myBox.replaceChildren();
  if (myId) {
    const list = el('div', { class: 'list mine' });
    if (mine.length) mine.forEach((t) => list.append(transferRow(t)));
    else list.append(el('p', { class: 'empty', textContent: state.receipts.length ? "You're all square right now." : 'Nothing to settle until receipts are added.' }));
    myBox.append(el('h2', { textContent: 'What you need to do' }), list);
  } else {
    myBox.append(el('p', { class: 'notice', textContent: 'Pick your name at the top to see what you owe or get back.' }));
  }

  $('handles-form').hidden = !myId;
  const person = personOf(myId);
  if (person && document.activeElement !== $('venmo') && document.activeElement !== $('zelle')) {
    $('venmo').value = person.venmo ? `@${person.venmo}` : '';
    $('zelle').value = person.zelle;
  }

  const all = $('all-transfers');
  all.replaceChildren();
  if (transfers.length) transfers.forEach((t) => all.append(transferRow(t)));
  else all.append(el('p', { class: 'empty', textContent: 'No payments needed right now.' }));

  const paidList = $('payments');
  paidList.replaceChildren();
  if (!state.payments.length) paidList.append(el('p', { class: 'empty', textContent: 'No payments checked off yet.' }));
  for (const payment of state.payments) {
    const box = el('input', { type: 'checkbox', checked: true });
    box.addEventListener('change', () => undoPayment(payment, box));
    paidList.append(el('div', { class: 'row' },
      el('div', { class: 'row-head' },
        el('span', { class: 'row-title', textContent: `${nameOf(payment.fromId)} paid ${nameOf(payment.toId)}` }),
        el('span', { class: 'amount', textContent: formatCents(payment.amountCents) })),
      el('div', { class: 'actions' }, el('label', { class: 'check' }, box, 'Paid'))));
  }
  $('paid-count').textContent = `${state.payments.length} checked off, ${transfers.length} still to pay`;
}

// Two-step delete, so one stray tap can't remove someone's receipt.
function confirmDelete(id, label, question, action) {
  const box = el('div', { class: 'actions' });
  if (confirmingId !== id) {
    box.append(el('button', { type: 'button', textContent: label, onclick: () => { confirmingId = id; render(); } }));
    return box;
  }
  box.append(
    el('span', { textContent: question }),
    el('button', {
      type: 'button',
      textContent: 'Yes',
      onclick: async () => {
        try {
          await action();
          confirmingId = null;
          await refresh();
        } catch (error) {
          showStatus(explain(error));
        }
      },
    }),
    el('button', { type: 'button', textContent: 'Keep it', onclick: () => { confirmingId = null; render(); } }));
  return box;
}

function renderReceipts() {
  const list = $('receipts');
  list.replaceChildren();
  if (!state.receipts.length) {
    list.append(el('p', { class: 'empty', textContent: 'No receipts yet. Add the first one from the Add receipt tab.' }));
    return;
  }
  for (const receipt of state.receipts) {
    const photo = openPhotos.get(receipt.id);
    const toggle = el('button', {
      type: 'button',
      textContent: photo ? 'Hide photo' : 'View photo',
      onclick: async () => {
        if (openPhotos.has(receipt.id)) {
          openPhotos.delete(receipt.id);
        } else {
          try {
            const image = await rpc('trip_get_image', { p_id: receipt.id });
            if (image && image.startsWith('data:image/jpeg;base64,')) openPhotos.set(receipt.id, image);
          } catch (error) {
            showStatus(explain(error));
          }
        }
        render();
      },
    });
    const details = [nameOf(receipt.personId), new Date(receipt.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })];
    if (receipt.note) details.push(receipt.note);
    list.append(el('div', { class: 'row' },
      el('div', { class: 'row-head' },
        el('span', { class: 'row-title', textContent: receipt.store }),
        el('span', { class: 'amount', textContent: formatCents(receipt.amountCents) })),
      el('span', { class: 'hint', textContent: details.join(' · ') }),
      photo ? el('img', { class: 'receipt-photo', src: photo, alt: `Receipt from ${receipt.store}` }) : null,
      el('div', { class: 'actions' }, toggle,
        confirmDelete(receipt.id, 'Delete', 'Delete this receipt?', () => rpc('trip_delete_receipt', { p_id: receipt.id })))));
  }
}

function renderPeople() {
  const rows = $('people');
  rows.replaceChildren();
  for (const person of state.people) {
    const own = state.receipts.filter((r) => r.personId === person.id);
    const spent = own.reduce((sum, r) => sum + r.amountCents, 0);
    const balance = balances[person.id] || 0;
    const balanceClass = balance > 0 ? 'num pos' : balance < 0 ? 'num neg' : 'num';
    const status = balance < 0 ? 'Still owes' : balance > 0 ? 'Waiting on money' : 'Paid up';
    rows.append(el('tr', {},
      el('td', { textContent: person.name }),
      el('td', { textContent: state.receipts.length ? status : '' }),
      el('td', { class: 'num', textContent: formatCents(spent) }),
      el('td', { class: balanceClass, textContent: formatCents(balance) }),
      el('td', { textContent: String(own.length) }),
      el('td', { class: 'handle', textContent: person.venmo ? `@${person.venmo}` : '' }),
      el('td', { class: 'handle', textContent: person.zelle })));
  }
}

function fillSelect(select, placeholder, selected) {
  if (select.dataset.count !== String(state.people.length)) {
    select.replaceChildren(el('option', { value: '', textContent: placeholder }),
      ...state.people.map((p) => el('option', { value: p.id, textContent: p.name })));
    select.dataset.count = String(state.people.length);
  }
  if (selected !== undefined && document.activeElement !== select) select.value = selected;
}

function render() {
  const computed = computeBalances(state.people, state.receipts, state.payments);
  balances = computed.balances;
  const transfers = settleUp(state.people, balances);
  const myId = me();
  fillSelect($('me'), 'Pick your name', myId);
  fillSelect($('receipt-person'), 'Pick a name', $('receipt-person').value || myId);

  $('stat-total').textContent = formatCents(computed.totalCents);
  $('stat-share').textContent = formatCents(state.people.length ? Math.round(computed.totalCents / state.people.length) : 0);
  $('stat-me').textContent = myId ? balanceLabel(balances[myId] || 0) : 'Pick your name';

  renderSettle(transfers);
  renderReceipts();
  renderPeople();
}

function showTab(name) {
  currentTab = name;
  for (const button of document.querySelectorAll('.tabs button')) {
    if (button.dataset.tab === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== `tab-${name}`;
}

async function refresh() {
  state = await rpc('trip_get_state');
  render();
}

// Shrinks the photo and re-encodes it, which also drops location and other metadata.
async function photoToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    let longest = 1800;
    let quality = 0.75;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= MAX_IMAGE_CHARS) return dataUrl;
      longest = Math.round(longest * 0.8);
      quality = Math.max(0.5, quality - 0.05);
    }
    throw new Error('photo_too_large');
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  code = $('gate-code').value.trim();
  $('gate-error').hidden = true;
  await enter(true);
});

async function enter(showErrors) {
  try {
    await refresh();
    store(CODE_KEY, code);
    $('gate').hidden = true;
    $('app').hidden = false;
    showTab(currentTab);
    setInterval(() => {
      if (!document.hidden && !confirmingId) refresh().catch(() => {});
    }, 30000);
  } catch (error) {
    store(CODE_KEY, null);
    $('app').hidden = true;
    $('gate').hidden = false;
    if (showErrors) {
      $('gate-error').textContent = error.message === 'wrong_passcode'
        ? "That passcode isn't right. Check it and try again."
        : "Couldn't connect. Check your connection and try again.";
      $('gate-error').hidden = false;
    }
  }
}

$('me').addEventListener('change', () => {
  store(ME_KEY, $('me').value || null);
  $('receipt-person').value = $('me').value;
  render();
});

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    showStatus('');
    showTab(button.dataset.tab);
  });
}

$('handles-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await rpc('trip_set_handles', { p_person_id: me(), p_venmo: $('venmo').value, p_zelle: $('zelle').value });
    document.activeElement.blur();
    await refresh();
    showStatus('Payment info saved.');
  } catch (error) {
    showStatus(explain(error));
  }
});

$('receipt-photo').addEventListener('change', async () => {
  const file = $('receipt-photo').files[0];
  const attempt = ++readAttempt;
  $('receipt-preview').hidden = true;
  $('receipt-read').hidden = true;
  if (!file) return;
  try {
    const image = await photoToDataUrl(file);
    $('receipt-preview').src = image;
    $('receipt-preview').hidden = false;
    fillTotalFromPhoto(image, attempt);
  } catch {
    $('receipt-photo').value = '';
    showStatus("Couldn't read that photo. Take a screenshot of it, or use a JPG or PNG, and try again.");
  }
});

// A convenience only. If the reader is off or unsure, people just type the total.
async function fillTotalFromPhoto(image, attempt) {
  const note = $('receipt-read');
  note.textContent = 'Reading the total...';
  note.hidden = false;
  let cents = null;
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/read-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
      body: JSON.stringify({ code, image }),
    });
    if (response.ok) cents = (await response.json()).totalCents;
  } catch { /* handled below: the person types the total */ }
  if (attempt !== readAttempt) return;
  if (!Number.isInteger(cents)) {
    note.textContent = 'Type the total from the receipt.';
    return;
  }
  if (!$('receipt-amount').value.trim()) $('receipt-amount').value = (cents / 100).toFixed(2);
  note.textContent = `The photo looks like ${formatCents(cents)}. Check that it matches before saving.`;
}

$('receipt-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const cents = parseCents($('receipt-amount').value);
  if (!cents) {
    showStatus('Enter the total as a dollar amount, like 141.50.');
    return;
  }
  if (cents > 1000000) {
    showStatus('A single receipt can be at most $10,000. Check the amount.');
    return;
  }
  if ($('receipt-preview').hidden) {
    showStatus('Add a photo that loads before saving.');
    return;
  }
  const save = $('receipt-save');
  save.disabled = true;
  save.textContent = 'Saving...';
  try {
    await rpc('trip_add_receipt', {
      p_person_id: $('receipt-person').value,
      p_store: $('receipt-store').value,
      p_amount_cents: cents,
      p_note: $('receipt-note').value,
      p_image: $('receipt-preview').src,
    });
    const person = $('receipt-person').value;
    $('receipt-form').reset();
    $('receipt-person').value = person;
    $('receipt-preview').hidden = true;
    $('receipt-preview').removeAttribute('src');
    $('receipt-read').hidden = true;
    readAttempt++;
    await refresh();
    showStatus(`Saved ${formatCents(cents)}. Balances are updated.`);
  } catch (error) {
    showStatus(explain(error));
  } finally {
    save.disabled = false;
    save.textContent = 'Save receipt';
  }
});

code = recall(CODE_KEY);
if (code) enter(false);
else $('gate').hidden = false;
