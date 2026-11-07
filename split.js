// Money math for Trip Tab. Everything is whole cents so totals always add up.
(function (root) {
  // Returns {totalCents, balances: {personId: cents}}. Positive means they're owed money.
  function computeBalances(people, receipts, payments) {
    const totalCents = receipts.reduce((sum, r) => sum + r.amountCents, 0);
    const balances = {};
    if (!people.length) return { totalCents, balances };

    const base = Math.floor(totalCents / people.length);
    const leftover = totalCents - base * people.length;
    people.forEach((p, i) => {
      balances[p.id] = -(base + (i < leftover ? 1 : 0));
    });
    for (const r of receipts) balances[r.personId] += r.amountCents;
    for (const y of payments) {
      balances[y.fromId] += y.amountCents;
      balances[y.toId] -= y.amountCents;
    }
    return { totalCents, balances };
  }

  // Matches the biggest debtor with the biggest creditor until everyone is square.
  function settleUp(people, balances) {
    const order = new Map(people.map((p, i) => [p.id, i]));
    const byAmount = (a, b) => b.cents - a.cents || order.get(a.id) - order.get(b.id);
    const owed = [];
    const owing = [];
    for (const p of people) {
      const cents = balances[p.id] || 0;
      if (cents > 0) owed.push({ id: p.id, cents });
      if (cents < 0) owing.push({ id: p.id, cents: -cents });
    }
    owed.sort(byAmount);
    owing.sort(byAmount);

    const transfers = [];
    let o = 0;
    let d = 0;
    while (o < owed.length && d < owing.length) {
      const cents = Math.min(owed[o].cents, owing[d].cents);
      transfers.push({ fromId: owing[d].id, toId: owed[o].id, cents });
      owed[o].cents -= cents;
      owing[d].cents -= cents;
      if (owed[o].cents === 0) o++;
      if (owing[d].cents === 0) d++;
    }
    return transfers;
  }

  // Reads "12.5", "$1,085.00" or "12" as cents. Returns null if it isn't an amount.
  function parseCents(text) {
    const clean = String(text).replace(/[$,\s]/g, '');
    if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(clean)) return null;
    const [dollars, cents = ''] = clean.split('.');
    return Number(dollars || 0) * 100 + Number((cents + '00').slice(0, 2));
  }

  function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100).toLocaleString('en-US');
    return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
  }

  const api = { computeBalances, settleUp, parseCents, formatCents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TripSplit = api;
})(this);
