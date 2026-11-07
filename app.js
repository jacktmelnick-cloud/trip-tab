const { computeBalances, settleUp, parseCents, formatCents } = window.TripSplit;
const { supabaseUrl, supabaseAnonKey } = window.TRIP_TAB_CONFIG;

const CODE_KEY = 'tripTab.code';
const TOKEN_KEY = 'tripTab.token';
const ADMIN_KEY = 'tripTab.admin';
const MAX_IMAGE_CHARS = 1900000;

let code = null;
let token = null;
let adminCode = null;
let names = [];
let state = { me: null, people: [], receipts: [], payments: [] };
let balances = {};
let assignments = null;
let announcements = [];
let currentTab = 'buy';
let confirmingId = null;
let openPhotos = new Map();
let readAttempt = 0;
let pollTimer = null;
let receiptPromptOpen = false;

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
    body: JSON.stringify(params),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error((body && body.message) || 'request_failed');
  return body;
}

const nameOf = (id) => (state.people.find((p) => p.id === id) || {}).name || 'Someone';
const personOf = (id) => state.people.find((p) => p.id === id);
const canManage = (...ids) => Boolean(adminCode) || ids.includes(state.me);

function showStatus(message) {
  $('status').textContent = message;
  $('status').hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function explain(error) {
  const messages = {
    too_many_receipts: 'The receipt limit of 500 is full. Delete any duplicates first.',
    bad_venmo: 'Venmo usernames can only use letters, numbers, dashes and underscores.',
    bad_zelle: 'That Zelle phone or email is too long.',
    not_allowed: 'Only that person or the trip admin can change this.',
    person_has_records: 'This person still has receipts or payments. Delete those first.',
    bad_name: 'Enter a name of 60 characters or fewer.',
    short_passcode: 'Use at least 8 characters for the new passcode.',
    wrong_admin: "That admin passcode isn't right.",
    bad_announcement: 'Write an announcement of 500 characters or fewer.',
    too_many_announcements: 'The limit of 50 announcements is full. Delete an old one first.',
  };
  return messages[error.message] || "That didn't save. Check your connection and try again.";
}

// Handles an expired login anywhere in the app. Returns true if it did.
function handleSignedOut(error) {
  if (error.message !== 'signed_out') return false;
  leaveApp();
  showGate('Your login expired. Sign in again.');
  return true;
}

function reportError(error) {
  if (!handleSignedOut(error)) showStatus(explain(error));
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

async function recordPayment(transfer, box) {
  box.disabled = true;
  try {
    await rpc('trip_add_payment', {
      p_token: token,
      p_from_id: transfer.fromId,
      p_to_id: transfer.toId,
      p_amount_cents: transfer.cents,
      p_admin: adminCode,
    });
    await refresh();
    showStatus(`Checked off ${formatCents(transfer.cents)} from ${nameOf(transfer.fromId)} to ${nameOf(transfer.toId)}.`);
  } catch (error) {
    box.disabled = false;
    box.checked = false;
    reportError(error);
  }
}

async function undoPayment(payment, box) {
  box.disabled = true;
  try {
    await rpc('trip_delete_payment', { p_token: token, p_id: payment.id, p_admin: adminCode });
    await refresh();
    showStatus(`Unchecked ${formatCents(payment.amountCents)} from ${nameOf(payment.fromId)} to ${nameOf(payment.toId)}. It's back on the list.`);
  } catch (error) {
    box.disabled = false;
    box.checked = true;
    reportError(error);
  }
}

function transferRow(transfer) {
  const receiver = personOf(transfer.toId);
  const actions = el('div', { class: 'actions' });
  if (transfer.fromId === state.me) {
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
  }
  if (canManage(transfer.fromId, transfer.toId)) {
    const paid = el('input', { type: 'checkbox' });
    paid.addEventListener('change', () => recordPayment(transfer, paid));
    actions.append(el('label', { class: 'check' }, paid, 'Paid'));
  }

  return el('div', { class: 'row' },
    el('div', { class: 'row-head' },
      el('span', { class: 'row-title', textContent: `${nameOf(transfer.fromId)} pays ${receiver.name}` }),
      el('span', { class: 'amount', textContent: formatCents(transfer.cents) })),
    actions.childElementCount ? actions : null);
}

// Opens the receipt form with what we already know about the item filled in.
function promptForReceipt(item) {
  if (!$('receipt-store').value.trim()) $('receipt-store').value = item.store.slice(0, 80);
  const label = `${item.item} (${item.quantity})`;
  const note = $('receipt-note').value.trim();
  $('receipt-note').value = (note ? `${note}, ${label}` : label).slice(0, 200);
  if (adminCode && item.personId) $('receipt-person').value = item.personId;
  $('receipt-prompt-text').textContent = `You checked off ${item.item}. Add its receipt so it counts toward the split.`;
  $('receipt-prompt').hidden = false;
  receiptPromptOpen = true;
  showStatus('');
  showTab('add');
  window.scrollTo({ top: 0 });
}

function closeReceiptPrompt() {
  receiptPromptOpen = false;
  $('receipt-prompt').hidden = true;
}

async function setBought(item, box) {
  const bought = box.checked;
  box.disabled = true;
  try {
    await rpc('trip_set_bought', { p_token: token, p_id: item.id, p_bought: bought, p_admin: adminCode });
    assignments = assignments.map((a) => (a.id === item.id ? { ...a, bought } : a));
    renderBuy();
    if (bought) promptForReceipt(item);
  } catch (error) {
    box.disabled = false;
    box.checked = !bought;
    reportError(error);
  }
}

function boughtControl(item) {
  if (item.bought === undefined) return null;
  if (!canManage(item.personId)) {
    return item.bought ? el('span', { class: 'bought-label', textContent: 'Bought' }) : null;
  }
  const box = el('input', { type: 'checkbox', checked: item.bought });
  box.addEventListener('change', () => setBought(item, box));
  return el('label', { class: 'check' }, box, 'Bought');
}

function buyRow(item) {
  const safeUrl = item.url.startsWith('https://') ? item.url : '';
  const backupUrl = (item.backupUrl || '').startsWith('https://') ? item.backupUrl : '';
  return el('div', { class: 'row' },
    el('div', { class: 'row-head' },
      el('span', { class: 'row-title', textContent: `${item.item} (${item.quantity})` }),
      el('span', { class: 'amount', textContent: `about ${formatCents(item.estimateCents)}` })),
    el('span', { class: 'hint', textContent: `${item.when} · ${item.store}` }),
    safeUrl ? el('a', { href: safeUrl, target: '_blank', rel: 'noopener noreferrer', textContent: `Open ${item.store}` }) : null,
    backupUrl ? el('a', { class: 'backup-link', href: backupUrl, target: '_blank', rel: 'noopener noreferrer', textContent: `Backup option: ${item.backupStore}` }) : null,
    boughtControl(item));
}

const estimateOf = (items) => items.reduce((sum, a) => sum + a.estimateCents, 0);

// Runs after the list loads, not on every refresh, so open sections stay open.
function renderBuy() {
  const mineBox = $('my-list');
  const everyone = $('everyone-lists');
  if (!assignments) {
    mineBox.replaceChildren(el('p', { class: 'notice', textContent: "Shopping lists aren't available yet. Check back soon." }));
    everyone.replaceChildren();
    return;
  }
  const openLists = new Set([...everyone.querySelectorAll('details[open]')].map((d) => d.dataset.name));
  const mine = assignments.filter((a) => a.personId === state.me);
  const boughtCount = mine.filter((a) => a.bought).length;
  const myList = el('div', { class: 'list mine' });
  if (mine.length) mine.forEach((a) => myList.append(buyRow(a)));
  else myList.append(el('p', { class: 'empty', textContent: "You don't have anything to buy." }));
  mineBox.replaceChildren(
    el('h2', { textContent: `Your list: about ${formatCents(estimateOf(mine))}${mine.length && mine[0].bought !== undefined ? `, ${boughtCount} of ${mine.length} bought` : ''}` }),
    el('p', { class: 'hint', textContent: "Use the first link if you can. If that store doesn't work out, use the backup option. Prices are estimates and may differ, and your real receipt is what counts toward the split." }),
    myList);

  const groups = state.people.map((p) => ({ name: p.name, items: assignments.filter((a) => a.personId === p.id) }));
  const known = new Set(state.people.map((p) => p.id));
  const unassigned = assignments.filter((a) => !known.has(a.personId));
  if (unassigned.length) groups.push({ name: 'Unassigned', items: unassigned });
  everyone.replaceChildren(...groups.filter((g) => g.items.length).map((g) => {
    const details = el('details', { class: 'person-list', open: openLists.has(g.name) },
      el('summary', {},
        el('span', { class: 'row-title', textContent: g.name }),
        el('span', { class: 'amount', textContent: `about ${formatCents(estimateOf(g.items))}` })),
      ...g.items.map((a) => buyRow(a)));
    details.dataset.name = g.name;
    return details;
  }));
}

async function loadAssignments() {
  try {
    assignments = await rpc('trip_get_assignments', { p_token: token });
  } catch (error) {
    if (handleSignedOut(error)) return;
    assignments = null;
  }
  renderBuy();
}

function renderSettle(transfers) {
  const mine = transfers.filter((t) => t.fromId === state.me || t.toId === state.me);
  const list = el('div', { class: 'list mine' });
  if (mine.length) mine.forEach((t) => list.append(transferRow(t)));
  else list.append(el('p', { class: 'empty', textContent: state.receipts.length ? "You're all square right now." : 'Nothing to settle until receipts are added.' }));
  $('my-transfers').replaceChildren(el('h2', { textContent: 'What you need to do' }), list);

  const person = personOf(state.me);
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
    const box = el('input', { type: 'checkbox', checked: true, disabled: !canManage(payment.fromId, payment.toId) });
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
          reportError(error);
        }
      },
    }),
    el('button', { type: 'button', textContent: 'Keep it', onclick: () => { confirmingId = null; render(); } }));
  return box;
}

function renderAnnouncements() {
  const box = $('announcements');
  box.hidden = !announcements.length;
  box.replaceChildren(...announcements.map((note) => {
    const posted = new Date(note.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return el('div', { class: 'announcement' },
      el('p', { class: 'hint', textContent: `Announcement · ${posted}` }),
      el('p', { class: 'announcement-body', textContent: note.body }),
      adminCode
        ? confirmDelete(note.id, 'Delete', 'Delete this announcement?', () => rpc('trip_admin_delete_announcement', { p_token: token, p_admin: adminCode, p_id: note.id }))
        : null);
  }));
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
            const image = await rpc('trip_get_image', { p_token: token, p_id: receipt.id });
            if (image && image.startsWith('data:image/jpeg;base64,')) openPhotos.set(receipt.id, image);
          } catch (error) {
            reportError(error);
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
        canManage(receipt.personId)
          ? confirmDelete(receipt.id, 'Delete', 'Delete this receipt?', () => rpc('trip_delete_receipt', { p_token: token, p_id: receipt.id, p_admin: adminCode }))
          : null)));
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
      el('td', { textContent: person.hasLogin ? 'Yes' : 'Not yet' }),
      el('td', { class: 'handle', textContent: person.venmo ? `@${person.venmo}` : '' }),
      el('td', { class: 'handle', textContent: person.zelle })));
  }
}

function fillSelect(select, placeholder, people, selected) {
  const signature = people.map((p) => p.id).join();
  if (select.dataset.people !== signature) {
    const keep = select.value;
    select.replaceChildren(el('option', { value: '', textContent: placeholder }),
      ...people.map((p) => el('option', { value: p.id, textContent: p.name })));
    select.dataset.people = signature;
    select.value = keep;
  }
  if (selected !== undefined && document.activeElement !== select) select.value = selected;
}

function render() {
  const computed = computeBalances(state.people, state.receipts, state.payments);
  balances = computed.balances;
  const transfers = settleUp(state.people, balances);

  $('signed-in-as').textContent = nameOf(state.me);
  $('receipt-person-field').hidden = !adminCode;
  fillSelect($('receipt-person'), 'Pick a name', state.people, $('receipt-person').value || state.me);
  fillSelect($('admin-handles-person'), 'Pick a name', state.people);
  fillSelect($('admin-remove-person'), 'Pick a name', state.people);
  fillSelect($('admin-reset-person'), 'Pick a name', state.people);
  $('admin-unlock').hidden = Boolean(adminCode);
  $('admin-tools').hidden = !adminCode;

  $('stat-total').textContent = formatCents(computed.totalCents);
  $('stat-share').textContent = formatCents(computed.shares[state.me] || 0);
  $('stat-me').textContent = balanceLabel(balances[state.me] || 0);

  renderAnnouncements();
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
  state = await rpc('trip_get_state', { p_token: token });
  // A problem loading announcements shouldn't stop the rest of the page.
  announcements = await rpc('trip_get_announcements', { p_token: token }).catch(() => announcements);
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

// --- Signing in ---

function gateError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function chosenName() {
  return names.find((n) => n.id === $('login-name').value);
}

function updateLoginForm() {
  const person = chosenName();
  const creating = Boolean(person && !person.hasLogin);
  $('login-password-field').hidden = !person;
  $('login-confirm-field').hidden = !creating;
  $('login-confirm').required = creating;
  $('login-password').required = Boolean(person);
  $('login-password').autocomplete = creating ? 'new-password' : 'current-password';
  $('login-password-label').textContent = creating ? 'Create a password (at least 6 characters)' : 'Password';
  $('login-submit').textContent = creating ? 'Create login' : 'Sign in';
  $('login-submit').hidden = !person;
  $('login-reset-hint').hidden = !person || creating;
  gateError('login-error', '');
}

function showCodeStep(message = '') {
  store(CODE_KEY, null);
  code = null;
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-form').hidden = false;
  $('login-form').hidden = true;
  gateError('gate-error', message);
}

async function showNameStep(message = '') {
  try {
    names = await rpc('trip_list_names', { p_code: code });
  } catch (error) {
    if (error.message === 'wrong_passcode') {
      showCodeStep("That passcode isn't right. Check it and try again.");
    } else {
      $('gate').hidden = false;
      $('gate-form').hidden = false;
      $('login-form').hidden = true;
      gateError('gate-error', "Couldn't connect. Check your connection and try again.");
    }
    return;
  }
  store(CODE_KEY, code);
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-form').hidden = true;
  $('login-form').hidden = false;
  fillSelect($('login-name'), 'Pick your name', names);
  updateLoginForm();
  gateError('login-error', message);
}

function showGate(message = '') {
  if (code) showNameStep(message);
  else showCodeStep(message);
}

function leaveApp() {
  clearInterval(pollTimer);
  store(TOKEN_KEY, null);
  store(ADMIN_KEY, null);
  token = null;
  adminCode = null;
  state = { me: null, people: [], receipts: [], payments: [] };
  assignments = null;
  closeReceiptPrompt();
  $('receipt-form').reset();
  $('receipt-preview').hidden = true;
  announcements = [];
  $('announcements').replaceChildren();
  $('announcements').hidden = true;
  currentTab = 'buy';
  $('my-list').replaceChildren();
  $('everyone-lists').replaceChildren();
  openPhotos = new Map();
  $('login-form').reset();
}

async function enterApp() {
  const savedAdmin = recall(ADMIN_KEY);
  if (savedAdmin && await rpc('trip_admin_check', { p_token: token, p_admin: savedAdmin })) adminCode = savedAdmin;
  else store(ADMIN_KEY, null);
  await refresh();
  $('gate').hidden = true;
  $('app').hidden = false;
  showTab(currentTab);
  loadAssignments();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden && !confirmingId) refresh().catch(handleSignedOut);
  }, 30000);
}

$('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  code = $('gate-code').value.trim();
  gateError('gate-error', '');
  await showNameStep();
});

$('login-name').addEventListener('change', updateLoginForm);

$('login-back').addEventListener('click', () => showCodeStep());

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const person = chosenName();
  if (!person) return;
  const password = $('login-password').value;
  gateError('login-error', '');
  if (!person.hasLogin && password.length < 6) {
    gateError('login-error', 'Use at least 6 characters.');
    return;
  }
  if (!person.hasLogin && password.length > 72) {
    gateError('login-error', 'Use 72 characters or fewer.');
    return;
  }
  if (!person.hasLogin && password !== $('login-confirm').value) {
    gateError('login-error', "Those passwords don't match.");
    return;
  }
  const submit = $('login-submit');
  submit.disabled = true;
  try {
    if (person.hasLogin) {
      const result = await rpc('trip_sign_in', { p_code: code, p_person_id: person.id, p_password: password });
      if (result.error) {
        const messages = {
          wrong_password: "That password isn't right.",
          locked: 'Too many wrong tries. Wait 15 minutes, or ask the trip admin to reset your login.',
          no_login: 'This login was reset. Create a new password.',
        };
        gateError('login-error', messages[result.error] || "Couldn't sign in. Try again.");
        if (result.error === 'no_login') await showNameStep(messages.no_login);
        return;
      }
      token = result.token;
    } else {
      token = await rpc('trip_create_login', { p_code: code, p_person_id: person.id, p_password: password });
    }
    store(TOKEN_KEY, token);
    $('login-form').reset();
    await enterApp();
    showStatus(person.hasLogin ? '' : "You're set up. Here's your shopping list. Add your payment info under Settle up, and tell the trip admin if this wasn't your name.");
  } catch (error) {
    if (error.message === 'wrong_passcode') {
      showCodeStep('The group passcode changed. Enter the new one.');
    } else if (error.message === 'already_claimed') {
      await showNameStep('Someone already created a login for that name. If it should be yours, ask the trip admin to reset it.');
    } else {
      gateError('login-error', "Couldn't sign in. Check your connection and try again.");
    }
  } finally {
    submit.disabled = false;
  }
});

$('sign-out').addEventListener('click', async () => {
  const old = token;
  leaveApp();
  showStatus('');
  await showNameStep();
  rpc('trip_sign_out', { p_token: old }).catch(() => {});
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
    await rpc('trip_set_handles', {
      p_token: token,
      p_person_id: state.me,
      p_venmo: $('venmo').value,
      p_zelle: $('zelle').value,
      p_admin: null,
    });
    document.activeElement.blur();
    await refresh();
    showStatus('Payment info saved.');
  } catch (error) {
    reportError(error);
  }
});

$('receipt-prompt-skip').addEventListener('click', () => {
  closeReceiptPrompt();
  $('receipt-form').reset();
  $('receipt-preview').hidden = true;
  $('receipt-read').hidden = true;
  readAttempt++;
  showTab('buy');
  showStatus("Okay. Your item stays checked off. Add the receipt from the Add receipt tab when you have it, or it won't count toward the split.");
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
      body: JSON.stringify({ token, image }),
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
  const person = adminCode ? $('receipt-person').value : state.me;
  if (!person) {
    showStatus('Pick who paid.');
    return;
  }
  const save = $('receipt-save');
  save.disabled = true;
  save.textContent = 'Saving...';
  try {
    await rpc('trip_add_receipt', {
      p_token: token,
      p_person_id: person,
      p_store: $('receipt-store').value,
      p_amount_cents: cents,
      p_note: $('receipt-note').value,
      p_image: $('receipt-preview').src,
      p_admin: adminCode,
    });
    $('receipt-form').reset();
    $('receipt-person').value = person;
    $('receipt-preview').hidden = true;
    $('receipt-preview').removeAttribute('src');
    $('receipt-read').hidden = true;
    readAttempt++;
    const fromPrompt = receiptPromptOpen;
    closeReceiptPrompt();
    await refresh();
    if (fromPrompt) showTab('buy');
    showStatus(`Saved ${formatCents(cents)}. Balances are updated.`);
  } catch (error) {
    reportError(error);
  } finally {
    save.disabled = false;
    save.textContent = 'Save receipt';
  }
});

// --- Admin ---

// Runs an admin form's action, then reports the result at the top of the page.
function adminForm(id, action) {
  $(id).addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const message = await action();
      $(id).reset();
      await refresh();
      showStatus(message);
    } catch (error) {
      reportError(error);
    }
  });
}

adminForm('admin-unlock', async () => {
  const entered = $('admin-code').value.trim();
  if (!await rpc('trip_admin_check', { p_token: token, p_admin: entered })) throw new Error('wrong_admin');
  adminCode = entered;
  store(ADMIN_KEY, entered);
  renderBuy();
  return 'Admin mode is on for this device.';
});

$('admin-leave').addEventListener('click', () => {
  adminCode = null;
  store(ADMIN_KEY, null);
  showStatus('Admin mode is off for this device.');
  render();
  renderBuy();
});

$('admin-handles-person').addEventListener('change', () => {
  const person = personOf($('admin-handles-person').value);
  $('admin-venmo').value = person && person.venmo ? `@${person.venmo}` : '';
  $('admin-zelle').value = person ? person.zelle : '';
});

adminForm('admin-announce', async () => {
  await rpc('trip_admin_post_announcement', { p_token: token, p_admin: adminCode, p_body: $('admin-announcement').value });
  return 'Announcement posted. Everyone will see it at the top of the page.';
});

adminForm('admin-handles', async () => {
  const name = nameOf($('admin-handles-person').value);
  await rpc('trip_set_handles', {
    p_token: token,
    p_person_id: $('admin-handles-person').value,
    p_venmo: $('admin-venmo').value,
    p_zelle: $('admin-zelle').value,
    p_admin: adminCode,
  });
  return `Saved payment info for ${name}.`;
});

adminForm('admin-reset', async () => {
  const id = $('admin-reset-person').value;
  const name = nameOf(id);
  await rpc('trip_admin_reset_login', { p_token: token, p_admin: adminCode, p_person_id: id });
  return `Reset the login for ${name}. They can create a new password now.`;
});

adminForm('admin-add', async () => {
  const name = $('admin-add-name').value;
  await rpc('trip_admin_add_person', { p_token: token, p_admin: adminCode, p_name: name });
  return `Added ${name.trim()}. Everyone's share is updated.`;
});

adminForm('admin-remove', async () => {
  const id = $('admin-remove-person').value;
  if (id === state.me) throw new Error('not_allowed');
  const name = nameOf(id);
  await rpc('trip_admin_remove_person', { p_token: token, p_admin: adminCode, p_person_id: id });
  return `Removed ${name}. Everyone's share is updated.`;
});

adminForm('admin-passcode', async () => {
  const next = $('admin-new-code').value.trim();
  await rpc('trip_admin_set_passcode', { p_token: token, p_admin: adminCode, p_new_code: next });
  code = next;
  store(CODE_KEY, next);
  return 'Group passcode changed. Send the new one to the group.';
});

// --- Start ---

async function start() {
  code = recall(CODE_KEY);
  token = recall(TOKEN_KEY);
  if (token) {
    try {
      await enterApp();
      return;
    } catch (error) {
      if (error.message !== 'signed_out') {
        // A dropped connection shouldn't sign anyone out.
        $('gate').hidden = false;
        $('gate-form').hidden = true;
        $('login-form').hidden = true;
        gateError('gate-error', "Couldn't connect. Check your connection and reload.");
        return;
      }
      leaveApp();
    }
  }
  showGate();
}

start();
