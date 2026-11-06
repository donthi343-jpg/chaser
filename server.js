'use strict';
/**
 * Chaser - invoices Claude writes, your app chases.
 * Zero dependencies. No AI keys anywhere: Claude (the customer's own plan) does the
 * thinking and calls this app through MCP. This app stores, edits, serves and chases.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const BASE_URL_ENV = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''; // optional transactional email (not AI)
const MAIL_FROM = process.env.MAIL_FROM || 'Chaser <onboarding@resend.dev>';
const DEMO_USER = process.env.DEMO_USER || 'demo';
const DEMO_PASS = process.env.DEMO_PASS || 'demo1234';
const SERVER_VERSION = '1.0.0';

/* ------------------------------ tiny JSON database ------------------------------ */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {}, invoices: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) { /* first run */ }
let saveTimer = null;
function flush() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { flush(); } catch (e) { console.error('save failed', e); } }, 60);
}
process.on('SIGTERM', () => { try { flush(); } catch (_) {} process.exit(0); });
process.on('SIGINT', () => { try { flush(); } catch (_) {} process.exit(0); });

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------ helpers ------------------------------ */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(n, cur) {
  try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur }).format(n); }
  catch (_) { return cur + ' ' + Number(n).toFixed(2); }
}
const fmtDate = (s) => { try { return new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (_) { return s; } };

let lastBase = ''; // remembered so the background reminder job can build correct links
function baseUrl(req) {
  if (BASE_URL_ENV) return BASE_URL_ENV;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return lastBase || 'http://localhost:' + PORT;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  lastBase = proto + '://' + host;
  return lastBase;
}

/* ------------------------------ domain logic ------------------------------ */
function totals(inv) {
  const subtotal = round2(inv.items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
  const tax = round2(subtotal * (inv.tax_rate || 0) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}
function effStatus(inv) {
  if ((inv.status === 'sent' || inv.status === 'viewed') && inv.due_date < today()) return 'overdue';
  return inv.status;
}
function log(inv, msg) {
  inv.activity.push({ t: new Date().toISOString(), msg });
  inv.updated = new Date().toISOString();
}
function serialize(inv, req) {
  return Object.assign({}, inv, {
    totals: totals(inv),
    status_effective: effStatus(inv),
    public_url: baseUrl(req) + '/i/' + inv.public_id,
    days_overdue: effStatus(inv) === 'overdue' ? daysBetween(inv.due_date, today()) : 0,
  });
}

/** Validates + normalises invoice fields. Used by the web API and by MCP so both behave identically. */
function normalize(input, existing) {
  const out = {};
  const str = (v, max) => String(v).trim().slice(0, max);
  if (input.client_name !== undefined) {
    out.client_name = str(input.client_name, 200);
    if (!out.client_name) return { error: 'client_name is required' };
  }
  if (input.client_email !== undefined) {
    const e = str(input.client_email || '', 200);
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: 'client_email is not a valid email' };
    out.client_email = e;
  }
  if (input.currency !== undefined) {
    const c = str(input.currency || 'INR', 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return { error: 'currency must be a 3-letter code like INR or USD' };
    out.currency = c;
  }
  if (input.tax_rate !== undefined) {
    const r = Number(input.tax_rate);
    if (!isFinite(r) || r < 0 || r > 100) return { error: 'tax_rate must be a percentage between 0 and 100' };
    out.tax_rate = r;
  }
  if (input.tax_label !== undefined) out.tax_label = str(input.tax_label || 'Tax', 30);
  if (input.notes !== undefined) out.notes = str(input.notes || '', 2000);
  if (input.issue_date !== undefined) {
    if (!isDate(input.issue_date)) return { error: 'issue_date must be YYYY-MM-DD' };
    out.issue_date = input.issue_date;
  }
  if (input.due_date !== undefined) {
    if (!isDate(input.due_date)) return { error: 'due_date must be YYYY-MM-DD' };
    out.due_date = input.due_date;
  }
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || !input.items.length) return { error: 'items must be a non-empty list of {description, quantity, unit_price}' };
    if (input.items.length > 100) return { error: 'too many line items (max 100)' };
    out.items = [];
    for (const [i, it] of input.items.entries()) {
      const description = str((it && it.description) || '', 300);
      const quantity = Number(it && it.quantity);
      const unit_price = Number(it && (it.unit_price !== undefined ? it.unit_price : it.rate));
      if (!description) return { error: `item ${i + 1}: description is required` };
      if (!isFinite(quantity) || quantity <= 0) return { error: `item ${i + 1}: quantity must be a positive number` };
      if (!isFinite(unit_price) || unit_price < 0) return { error: `item ${i + 1}: unit_price must be zero or more` };
      out.items.push({ description, quantity, unit_price });
    }
  }
  return { value: out };
}

function createInvoice(user, input) {
  const base = Object.assign({ currency: 'INR', tax_rate: 0, tax_label: 'GST', notes: '', client_email: '' }, input);
  if (base.due_date === undefined) base.due_date = addDays(base.issue_date || today(), Number(input.due_in_days) >= 0 && input.due_in_days !== undefined ? Number(input.due_in_days) : 15);
  if (base.issue_date === undefined) base.issue_date = today();
  if (base.client_name === undefined) return { error: 'client_name is required' };
  if (base.items === undefined) return { error: 'items is required' };
  const n = normalize(base);
  if (n.error) return n;
  const v = n.value;
  if (v.due_date < v.issue_date) return { error: 'due_date cannot be before issue_date' };
  user.counter = (user.counter || 0) + 1;
  const now = new Date().toISOString();
  const inv = Object.assign({
    id: rid(8), user: user.username, number: 'INV-' + String(user.counter).padStart(4, '0'), public_id: rid(10),
    status: 'draft', claimed: false, views: 0, reminders: 0, last_reminder: null, activity: [], created: now, updated: now,
  }, v);
  log(inv, input.source === 'claude' ? 'Created by Claude' : 'Created');
  db.invoices[inv.id] = inv;
  save();
  return { invoice: inv };
}

function updateInvoice(inv, input) {
  const n = normalize(input);
  if (n.error) return n;
  const v = n.value;
  const issue = v.issue_date || inv.issue_date, due = v.due_date || inv.due_date;
  if (due < issue) return { error: 'due_date cannot be before issue_date' };
  const changed = Object.keys(v).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(inv[k]));
  Object.assign(inv, v);
  if (changed.length) log(inv, 'Edited: ' + changed.map((k) => k.replace('_', ' ')).join(', '));
  save();
  return { invoice: inv };
}

async function sendMail(to, subject, html) {
  if (!RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    return r.ok;
  } catch (_) { return false; }
}
function emailBody(user, inv, url, kind) {
  const t = totals(inv);
  const biz = esc(user.profile.business_name || user.username);
  const lead = kind === 'reminder'
    ? `This is a friendly reminder that invoice <b>${esc(inv.number)}</b> for <b>${esc(fmt(t.total, inv.currency))}</b> ${effStatus(inv) === 'overdue' ? 'was due on' : 'is due on'} <b>${esc(fmtDate(inv.due_date))}</b>.`
    : `${biz} sent you invoice <b>${esc(inv.number)}</b> for <b>${esc(fmt(t.total, inv.currency))}</b>, due <b>${esc(fmtDate(inv.due_date))}</b>.`;
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">Hi ${esc(inv.client_name)},<br><br>${lead}<br><br><a href="${esc(url)}" style="background:#0b6e6e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">View invoice</a><br><br>Thanks,<br>${biz}</div>`;
}

async function sendInvoice(user, inv, req) {
  if (inv.status === 'paid') return { error: 'Invoice is already paid.' };
  const url = baseUrl(req) + '/i/' + inv.public_id;
  if (inv.status === 'draft') inv.status = 'sent';
  inv.sent_at = inv.sent_at || new Date().toISOString();
  let emailed = false;
  if (inv.client_email) emailed = await sendMail(inv.client_email, `Invoice ${inv.number} from ${user.profile.business_name || user.username}`, emailBody(user, inv, url, 'invoice'));
  log(inv, emailed ? `Sent to ${inv.client_email}` : 'Marked as sent (share the link with your client)');
  save();
  return { invoice: inv, emailed, url };
}

async function remind(user, inv, req, auto) {
  if (inv.status === 'draft') return { error: 'This invoice is still a draft. Send it first.' };
  if (inv.status === 'paid') return { error: 'Invoice is already paid.' };
  const url = baseUrl(req) + '/i/' + inv.public_id;
  let emailed = false;
  if (inv.client_email) emailed = await sendMail(inv.client_email, `Reminder: invoice ${inv.number} ${effStatus(inv) === 'overdue' ? 'is overdue' : 'is due soon'}`, emailBody(user, inv, url, 'reminder'));
  inv.reminders += 1;
  inv.last_reminder = new Date().toISOString();
  log(inv, (auto ? 'Auto-reminder ' : 'Reminder ') + (emailed ? `emailed to ${inv.client_email}` : inv.client_email ? 'logged (email delivery not configured)' : 'logged (no client email on file)'));
  save();
  return { invoice: inv, emailed, url };
}

async function runReminders(req, onlyUser) {
  let count = 0;
  for (const inv of Object.values(db.invoices)) {
    if (onlyUser && inv.user !== onlyUser) continue;
    const user = db.users[inv.user];
    if (!user || user.profile.auto_reminders === false) continue;
    if (inv.status !== 'sent' && inv.status !== 'viewed') continue;
    const dueSoon = daysBetween(today(), inv.due_date) <= 2;
    const stale = !inv.last_reminder || Date.now() - Date.parse(inv.last_reminder) > 3 * 864e5;
    if (dueSoon && stale) { await remind(user, inv, req, true); count++; }
  }
  return count;
}

function findInvoice(user, ref) {
  ref = String(ref || '').trim();
  if (!ref) return null;
  const mine = Object.values(db.invoices).filter((i) => i.user === user.username);
  const byId = mine.find((i) => i.id === ref || i.public_id === ref);
  if (byId) return byId;
  const digits = ref.replace(/^inv[-\s]*/i, '');
  if (/^\d+$/.test(digits)) return mine.find((i) => i.number === 'INV-' + digits.padStart(4, '0')) || null;
  return mine.find((i) => i.number.toLowerCase() === ref.toLowerCase()) || null;
}

/* ------------------------------ users ------------------------------ */
function newUser(username, password) {
  const u = {
    username, pass: hashPw(password), token: rid(20), counter: 0, created: new Date().toISOString(),
    profile: { business_name: '', address: '', email: '', payment_info: '', auto_reminders: true },
  };
  db.users[username] = u;
  save();
  return u;
}
const userByToken = (t) => Object.values(db.users).find((u) => u.token === t && t.length >= 20);

function seed() {
  if (Object.keys(db.users).length) return;
  const u = newUser(DEMO_USER, DEMO_PASS);
  if (process.env.DEMO_TOKEN) u.token = process.env.DEMO_TOKEN;
  Object.assign(u.profile, {
    business_name: 'Demo Studio', address: '12 MG Road, Bengaluru 560001', email: 'hello@demostudio.example',
    payment_info: 'UPI: demostudio@upi\nBank: HDFC 5020 0000 0000 | IFSC HDFC0000001',
  });
  const a = createInvoice(u, { client_name: 'Acme Traders Pvt Ltd', client_email: 'accounts@acme.example', items: [{ description: 'Website maintenance, October', quantity: 1, unit_price: 45000 }], tax_rate: 18, issue_date: addDays(today(), -30), due_date: addDays(today(), -9), notes: 'Sample overdue invoice' }).invoice;
  a.status = 'sent'; log(a, 'Marked as sent (share the link with your client)');
  const b = createInvoice(u, { client_name: 'Nimbus Labs', client_email: 'finance@nimbus.example', items: [{ description: 'Brand workshop (2 days)', quantity: 2, unit_price: 30000 }], tax_rate: 18, issue_date: addDays(today(), -20), due_date: addDays(today(), -5), notes: 'Sample paid invoice' }).invoice;
  b.status = 'paid'; b.paid_at = new Date().toISOString(); log(b, 'Marked as paid');
  save();
  console.log(`Seeded demo user "${DEMO_USER}" / "${DEMO_PASS}"`);
}
seed();

/* ------------------------------ MCP (JSON-RPC over streamable HTTP) ------------------------------ */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const itemSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'What the line item is, e.g. "Logo design"' },
    quantity: { type: 'number', description: 'Units or hours, e.g. 40' },
    unit_price: { type: 'number', description: 'Price per unit in major currency units (rupees, not paise), before tax' },
  },
  required: ['description', 'quantity', 'unit_price'],
};
const invoiceRef = { type: 'string', description: 'Invoice number like "INV-0003" (or just "3")' };
const TOOLS = [
  {
    name: 'create_invoice',
    description: 'Create a new invoice for a client. It is saved as a DRAFT with a live shareable link; the user can review and edit it in the Chaser app before sending. Turn the user\'s request (or pasted email/notes) into structured line items, tax and dates. Use send=true only if the user explicitly asks to send it now.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string', description: 'Client email, if known. Needed for emailed reminders.' },
        items: { type: 'array', items: itemSchema, description: 'One entry per billable line' },
        currency: { type: 'string', description: '3-letter code. Default INR.' },
        tax_rate: { type: 'number', description: 'Tax percentage, e.g. 18 for 18% GST. Default 0.' },
        tax_label: { type: 'string', description: 'e.g. GST, VAT. Default GST.' },
        issue_date: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        due_in_days: { type: 'number', description: 'Days after issue date until due. Default 15. Ignored if due_date is given.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string', description: 'Optional note shown on the invoice, e.g. payment terms' },
        send: { type: 'boolean', description: 'Mark as sent immediately (and email the client if possible). Default false.' },
      },
      required: ['client_name', 'items'],
    },
  },
  {
    name: 'list_invoices',
    description: 'List the user\'s invoices with status (draft, sent, viewed, overdue, paid), totals and due dates. Use for questions like "who owes me money?" or "what is overdue?".',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'sent', 'viewed', 'overdue', 'paid', 'unpaid'], description: '"unpaid" = sent, viewed or overdue' },
        client: { type: 'string', description: 'Filter by client name (partial match)' },
        limit: { type: 'number', description: 'Max rows, default 20' },
      },
    },
  },
  { name: 'get_invoice', description: 'Get full details and activity history of one invoice.', inputSchema: { type: 'object', properties: { invoice: invoiceRef }, required: ['invoice'] } },
  {
    name: 'update_invoice',
    description: 'Edit an existing invoice. Only pass the fields to change. If you pass items, the entire item list is replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        invoice: invoiceRef, client_name: { type: 'string' }, client_email: { type: 'string' }, items: { type: 'array', items: itemSchema },
        currency: { type: 'string' }, tax_rate: { type: 'number' }, tax_label: { type: 'string' },
        issue_date: { type: 'string' }, due_date: { type: 'string' }, notes: { type: 'string' },
      },
      required: ['invoice'],
    },
  },
  { name: 'send_invoice', description: 'Mark a draft invoice as sent and email it to the client if an email is on file. Returns the public link.', inputSchema: { type: 'object', properties: { invoice: invoiceRef }, required: ['invoice'] } },
  { name: 'send_reminder', description: 'Send a payment reminder for a sent or overdue invoice.', inputSchema: { type: 'object', properties: { invoice: invoiceRef }, required: ['invoice'] } },
  { name: 'mark_paid', description: 'Mark an invoice as paid.', inputSchema: { type: 'object', properties: { invoice: invoiceRef }, required: ['invoice'] } },
  {
    name: 'set_business_profile',
    description: 'Set the sender details printed on every invoice. Only pass fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' }, address: { type: 'string' }, email: { type: 'string' },
        payment_info: { type: 'string', description: 'How clients should pay: UPI id, bank details, etc.' },
        auto_reminders: { type: 'boolean', description: 'Automatically remind clients about overdue invoices' },
      },
    },
  },
];

function summary(inv, req) {
  const t = totals(inv);
  const s = effStatus(inv);
  const lines = [
    `${inv.number} | ${inv.client_name} | ${fmt(t.total, inv.currency)} | status: ${s}${s === 'overdue' ? ` (${daysBetween(inv.due_date, today())} days)` : ''} | due ${inv.due_date}`,
  ];
  return lines.join('\n');
}
function detail(inv, req) {
  const t = totals(inv);
  const items = inv.items.map((i) => `  - ${i.description}: ${i.quantity} x ${fmt(i.unit_price, inv.currency)}`).join('\n');
  return [
    `${inv.number} for ${inv.client_name}${inv.client_email ? ' <' + inv.client_email + '>' : ''}`,
    `Status: ${effStatus(inv)}${inv.claimed && inv.status !== 'paid' ? ' (client says they have paid; confirm it)' : ''}`,
    `Issued ${inv.issue_date}, due ${inv.due_date}`,
    items,
    `Subtotal ${fmt(t.subtotal, inv.currency)}, ${inv.tax_label} ${inv.tax_rate}% ${fmt(t.tax, inv.currency)}, TOTAL ${fmt(t.total, inv.currency)}`,
    `Client link: ${baseUrl(req)}/i/${inv.public_id}`,
    `Edit in app: ${baseUrl(req)}/#invoice=${inv.id}`,
  ].join('\n');
}

async function callTool(user, name, args, req) {
  args = args || {};
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
  const need = (ref) => { const inv = findInvoice(user, ref); return inv || null; };
  switch (name) {
    case 'create_invoice': {
      const r = createInvoice(user, Object.assign({}, args, { source: 'claude' }));
      if (r.error) return fail(r.error);
      let extra = '';
      if (args.send === true) {
        const s = await sendInvoice(user, r.invoice, req);
        extra = s.error ? `\n(Could not send: ${s.error})` : `\nMarked as sent${s.emailed ? ' and emailed to the client' : ''}.`;
      }
      return ok(`Invoice created${r.invoice.status === 'draft' ? ' as a draft' : ''}.\n${detail(r.invoice, req)}${extra}\nTell the user they can review and edit it in the Chaser app at the "Edit in app" link before sending.`);
    }
    case 'list_invoices': {
      let list = Object.values(db.invoices).filter((i) => i.user === user.username);
      if (args.status === 'unpaid') list = list.filter((i) => ['sent', 'viewed', 'overdue'].includes(effStatus(i)));
      else if (args.status) list = list.filter((i) => effStatus(i) === args.status);
      if (args.client) list = list.filter((i) => i.client_name.toLowerCase().includes(String(args.client).toLowerCase()));
      list.sort((a, b) => b.created.localeCompare(a.created));
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      if (!list.length) return ok('No invoices match.');
      const owed = {};
      list.filter((i) => ['sent', 'viewed', 'overdue'].includes(effStatus(i))).forEach((i) => { owed[i.currency] = (owed[i.currency] || 0) + totals(i).total; });
      const owedTxt = Object.entries(owed).map(([c, v]) => fmt(v, c)).join(', ');
      return ok(list.slice(0, limit).map((i) => summary(i, req)).join('\n') + (owedTxt ? `\nUnpaid total in this list: ${owedTxt}` : ''));
    }
    case 'get_invoice': {
      const inv = need(args.invoice);
      if (!inv) return fail('Invoice not found. Use list_invoices to see invoice numbers.');
      return ok(detail(inv, req) + '\nActivity:\n' + inv.activity.slice(-10).map((a) => `  ${a.t.slice(0, 16).replace('T', ' ')} ${a.msg}`).join('\n'));
    }
    case 'update_invoice': {
      const inv = need(args.invoice);
      if (!inv) return fail('Invoice not found. Use list_invoices to see invoice numbers.');
      const { invoice, ...fields } = args;
      const r = updateInvoice(inv, fields);
      return r.error ? fail(r.error) : ok('Updated.\n' + detail(r.invoice, req));
    }
    case 'send_invoice': {
      const inv = need(args.invoice);
      if (!inv) return fail('Invoice not found.');
      const r = await sendInvoice(user, inv, req);
      return r.error ? fail(r.error) : ok(`${inv.number} marked as sent${r.emailed ? ` and emailed to ${inv.client_email}` : ' (no email sent: ' + (inv.client_email ? 'email delivery is not configured' : 'no client email on file') + ')'}.\nClient link: ${r.url}`);
    }
    case 'send_reminder': {
      const inv = need(args.invoice);
      if (!inv) return fail('Invoice not found.');
      const r = await remind(user, inv, req, false);
      return r.error ? fail(r.error) : ok(`Reminder ${r.emailed ? 'emailed to ' + inv.client_email : 'logged (' + (inv.client_email ? 'email delivery is not configured' : 'no client email on file') + ')'} for ${inv.number}. Client link: ${r.url}`);
    }
    case 'mark_paid': {
      const inv = need(args.invoice);
      if (!inv) return fail('Invoice not found.');
      inv.status = 'paid'; inv.paid_at = new Date().toISOString(); log(inv, 'Marked as paid'); save();
      return ok(`${inv.number} marked as paid.`);
    }
    case 'set_business_profile': {
      for (const k of ['business_name', 'address', 'email', 'payment_info']) if (args[k] !== undefined) user.profile[k] = String(args[k]).slice(0, 1000);
      if (args.auto_reminders !== undefined) user.profile.auto_reminders = !!args.auto_reminders;
      save();
      return ok('Business profile updated: ' + JSON.stringify(user.profile));
    }
    default: return fail('Unknown tool: ' + name);
  }
}

async function handleRpc(user, msg, req) {
  const id = msg.id;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chaser', title: 'Chaser Invoices', version: SERVER_VERSION },
        instructions: 'Chaser stores invoices and chases payments. Use create_invoice to turn a request into a draft invoice; the user reviews and edits it in the app. Amounts are in major currency units.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try { return reply(await callTool(user, msg.params && msg.params.name, msg.params && msg.params.arguments, req)); }
      catch (e) { console.error(e); return reply({ content: [{ type: 'text', text: 'Server error: ' + e.message }], isError: true }); }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return error(-32601, 'Method not found: ' + msg.method);
  }
}

/* ------------------------------ public invoice page ------------------------------ */
function invoicePage(inv, user, req, preview) {
  const t = totals(inv);
  const s = effStatus(inv);
  const p = user.profile;
  const stamp = { draft: 'Draft', sent: 'Awaiting payment', viewed: 'Awaiting payment', overdue: 'Overdue', paid: 'Paid' }[s];
  const rows = inv.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${esc(i.quantity)}</td><td class="n">${esc(fmt(i.unit_price, inv.currency))}</td><td class="n">${esc(fmt(i.quantity * i.unit_price, inv.currency))}</td></tr>`).join('');
  const canClaim = s !== 'paid' && s !== 'draft';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(inv.number)} · ${esc(p.business_name || user.username)}</title><meta name="robots" content="noindex">
<style>
:root{--ink:#101828;--mute:#667085;--line:#e4e7ec;--bg:#f2f4f7;--paid:#0b7a55;--over:#c2410c;--blue:#2457d6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.sheet{max-width:760px;margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:10px;padding:44px}
.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;flex-wrap:wrap}
h1{margin:0;font-size:26px;letter-spacing:-.02em}.mute{color:var(--mute)}.small{font-size:13px}
.stamp{display:inline-block;padding:4px 12px;border:2px solid currentColor;border-radius:6px;font-weight:700;font-size:13px;transform:rotate(-3deg)}
.s-paid{color:var(--paid)}.s-overdue{color:var(--over)}.s-sent,.s-viewed{color:var(--blue)}.s-draft{color:var(--mute)}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:32px 0}.meta b{display:block;font-size:12px;color:var(--mute);font-weight:600;margin-bottom:2px}
table{width:100%;border-collapse:collapse}th{font-size:12px;color:var(--mute);font-weight:600;text-align:left;border-bottom:1px solid var(--ink);padding:8px 0}
td{padding:12px 0;border-bottom:1px solid var(--line);vertical-align:top}.n{text-align:right;white-space:nowrap;padding-left:12px}th.n{text-align:right}
.tot{margin:20px 0 0 auto;width:280px}.tot div{display:flex;justify-content:space-between;padding:4px 0}.tot .g{border-top:1px solid var(--ink);margin-top:6px;padding-top:10px;font-size:20px;font-weight:700}
.pay{margin-top:32px;padding:16px 18px;background:var(--bg);border-radius:8px;white-space:pre-line}
.actions{margin-top:28px;display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-weight:600;padding:10px 16px;border-radius:8px;border:1px solid var(--ink);background:#fff;color:var(--ink);cursor:pointer}
button.p{background:var(--ink);color:#fff}button:focus-visible{outline:3px solid #9db8ff;outline-offset:2px}
.banner{background:#fff4e5;border:1px solid #f5c37a;color:#7a4a00;padding:10px 14px;border-radius:8px;margin-bottom:18px;font-size:14px}
@media(max-width:560px){.sheet{margin:0;border-radius:0;padding:24px}.meta{grid-template-columns:1fr}.tot{width:100%}}
@media print{body{background:#fff}.sheet{border:0;margin:0;padding:0}.actions,.banner{display:none}}
</style></head><body><main class="sheet">
${preview || s === 'draft' ? `<div class="banner">${s === 'draft' ? 'This invoice is a draft and has not been sent yet.' : 'Preview'}</div>` : ''}
<div class="top"><div><h1>${esc(p.business_name || user.username)}</h1><div class="mute small" style="white-space:pre-line">${esc(p.address)}${p.email ? '\n' + esc(p.email) : ''}</div></div>
<div style="text-align:right"><div class="stamp s-${s}">${esc(stamp)}</div><div style="margin-top:10px;font-weight:600">${esc(inv.number)}</div></div></div>
<div class="meta"><div><b>Billed to</b>${esc(inv.client_name)}${inv.client_email ? '<div class="mute small">' + esc(inv.client_email) + '</div>' : ''}</div>
<div><b>Issued</b>${esc(fmtDate(inv.issue_date))}<div style="margin-top:10px"><b>Due</b>${esc(fmtDate(inv.due_date))}${s === 'overdue' ? ` <span class="s-overdue small">(${daysBetween(inv.due_date, today())} days overdue)</span>` : ''}</div></div></div>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot"><div><span class="mute">Subtotal</span><span>${esc(fmt(t.subtotal, inv.currency))}</span></div>
${inv.tax_rate ? `<div><span class="mute">${esc(inv.tax_label)} (${esc(inv.tax_rate)}%)</span><span>${esc(fmt(t.tax, inv.currency))}</span></div>` : ''}
<div class="g"><span>Total</span><span>${esc(fmt(t.total, inv.currency))}</span></div></div>
${inv.notes ? `<p class="mute small" style="margin-top:28px;white-space:pre-line">${esc(inv.notes)}</p>` : ''}
${p.payment_info && s !== 'paid' ? `<div class="pay"><b>How to pay</b>\n${esc(p.payment_info)}</div>` : ''}
<div class="actions"><button onclick="window.print()">Download PDF</button>${canClaim ? `<button class="p" id="claim" ${inv.claimed ? 'disabled' : ''}>${inv.claimed ? 'Payment reported. Thank you' : "I've paid this invoice"}</button>` : ''}</div>
</main>
${canClaim && !inv.claimed ? `<script>document.getElementById('claim').onclick=async function(){this.disabled=true;try{await fetch('/i/${esc(inv.public_id)}/claim',{method:'POST'});this.textContent='Payment reported. Thank you'}catch(e){this.disabled=false}}</script>` : ''}
</body></html>`;
}

/* ------------------------------ HTTP plumbing ------------------------------ */
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && body !== null;
  res.writeHead(code, Object.assign({ 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(isObj ? JSON.stringify(body) : body);
};
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
function sessionUser(req) {
  const sid = parseCookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.user] || null;
}
function startSession(res, user, req) {
  const sid = rid(24);
  db.sessions[sid] = { user: user.username, exp: Date.now() + 30 * 864e5 };
  save();
  const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
  return { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}` };
}
const publicUser = (u, req) => ({ username: u.username, profile: u.profile, mcp_url: baseUrl(req) + '/mcp/' + u.token, base_url: baseUrl(req), email_enabled: !!RESEND_API_KEY });

// naive per-IP limiter for login/signup
const attempts = new Map();
function limited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); attempts.set(ip, a);
  return a.length > 20;
}

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/healthz') return send(res, 200, { ok: true });

  /* ---- MCP ---- */
  if (p.startsWith('/mcp')) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, accept', 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'mcp-session-id' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const token = p.split('/')[2] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = token && userByToken(token);
    if (!user) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or missing MCP token. Copy your connector URL from the Chaser app.' } }, cors);
    if (m === 'GET') return send(res, 405, { error: 'This MCP server uses POST only.' }, Object.assign({ Allow: 'POST' }, cors));
    if (m === 'DELETE') { res.writeHead(200, cors); return res.end(); }
    if (m !== 'POST') return send(res, 405, { error: 'Method not allowed' }, cors);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors); }
    const batch = Array.isArray(body);
    const results = (await Promise.all((batch ? body : [body]).map((x) => handleRpc(user, x || {}, req)))).filter(Boolean);
    if (!results.length) { res.writeHead(202, cors); return res.end(); }
    return send(res, 200, batch ? results : results[0], cors);
  }

  /* ---- public invoice ---- */
  let mm = p.match(/^\/i\/([a-f0-9]+)(\/claim)?$/);
  if (mm) {
    const inv = Object.values(db.invoices).find((i) => i.public_id === mm[1]);
    if (!inv) return send(res, 404, '<h1 style="font-family:sans-serif">Invoice not found</h1>');
    const user = db.users[inv.user];
    if (mm[2]) {
      if (m !== 'POST') return send(res, 405, { error: 'POST only' });
      if (!inv.claimed && inv.status !== 'paid' && inv.status !== 'draft') { inv.claimed = true; log(inv, 'Client reported that they have paid'); save(); }
      return send(res, 200, { ok: true });
    }
    const preview = url.searchParams.get('preview') === '1';
    if (!preview && inv.status === 'sent') { inv.status = 'viewed'; log(inv, 'Opened by client'); }
    if (!preview && inv.status !== 'draft') { inv.views += 1; save(); }
    return send(res, 200, invoicePage(inv, user, req, preview), { 'Cache-Control': 'no-store' });
  }

  /* ---- app API ---- */
  if (p.startsWith('/api/')) {
    let body = {};
    if (m === 'POST' || m === 'PUT') {
      try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch (_) { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    if (p === '/api/signup' && m === 'POST') {
      if (limited(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
      const name = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,30}$/.test(name)) return send(res, 400, { error: 'Username: 3 to 30 letters, numbers, dot, dash or underscore.' });
      if (String(body.password || '').length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' });
      if (db.users[name]) return send(res, 409, { error: 'That username is taken.' });
      const u = newUser(name, body.password);
      return send(res, 200, publicUser(u, req), startSession(res, u, req));
    }
    if (p === '/api/login' && m === 'POST') {
      if (limited(req)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
      const u = db.users[String(body.username || '').trim().toLowerCase()];
      if (!u || !checkPw(String(body.password || ''), u.pass)) return send(res, 401, { error: 'Wrong username or password.' });
      return send(res, 200, publicUser(u, req), startSession(res, u, req));
    }
    const user = sessionUser(req);
    if (!user) return send(res, 401, { error: 'Not signed in' });
    if (p === '/api/logout' && m === 'POST') { delete db.sessions[parseCookies(req).sid]; save(); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' }); }
    if (p === '/api/me' && m === 'GET') return send(res, 200, publicUser(user, req));
    if (p === '/api/profile' && m === 'PUT') {
      for (const k of ['business_name', 'address', 'email', 'payment_info']) if (body[k] !== undefined) user.profile[k] = String(body[k]).slice(0, 1000);
      if (body.auto_reminders !== undefined) user.profile.auto_reminders = !!body.auto_reminders;
      save(); return send(res, 200, publicUser(user, req));
    }
    if (p === '/api/token/regenerate' && m === 'POST') { user.token = rid(20); save(); return send(res, 200, publicUser(user, req)); }
    if (p === '/api/run-reminders' && m === 'POST') return send(res, 200, { reminded: await runReminders(req, user.username) });
    if (p === '/api/invoices' && m === 'GET') {
      const list = Object.values(db.invoices).filter((i) => i.user === user.username).sort((a, b) => b.created.localeCompare(a.created));
      return send(res, 200, list.map((i) => serialize(i, req)));
    }
    if (p === '/api/invoices' && m === 'POST') {
      const r = createInvoice(user, body);
      return r.error ? send(res, 400, { error: r.error }) : send(res, 200, serialize(r.invoice, req));
    }
    mm = p.match(/^\/api\/invoices\/([a-f0-9]+)(?:\/(send|remind|paid|unpaid))?$/);
    if (mm) {
      const inv = db.invoices[mm[1]];
      if (!inv || inv.user !== user.username) return send(res, 404, { error: 'Invoice not found' });
      const act = mm[2];
      if (!act && m === 'GET') return send(res, 200, serialize(inv, req));
      if (!act && m === 'PUT') { const r = updateInvoice(inv, body); return r.error ? send(res, 400, { error: r.error }) : send(res, 200, serialize(inv, req)); }
      if (!act && m === 'DELETE') { delete db.invoices[inv.id]; save(); return send(res, 200, { ok: true }); }
      if (m === 'POST') {
        let r = {};
        if (act === 'send') r = await sendInvoice(user, inv, req);
        else if (act === 'remind') r = await remind(user, inv, req, false);
        else if (act === 'paid') { inv.status = 'paid'; inv.paid_at = new Date().toISOString(); log(inv, 'Marked as paid'); save(); }
        else if (act === 'unpaid') { inv.status = 'sent'; inv.claimed = false; log(inv, 'Marked as unpaid'); save(); }
        return r.error ? send(res, 400, { error: r.error }) : send(res, 200, Object.assign(serialize(inv, req), { emailed: !!r.emailed }));
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  /* ---- app shell ---- */
  if (p === '/' && m === 'GET') {
    return send(res, 200, fs.readFileSync(INDEX_HTML, 'utf8'), { 'Cache-Control': 'no-store' });
  }
  return send(res, 404, '<h1 style="font-family:sans-serif">Not found</h1>');
}

http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); else res.end(); });
}).listen(PORT, () => {
  console.log(`Chaser running on :${PORT}`);
  const demo = db.users[DEMO_USER];
  if (demo) console.log(`Demo MCP path: /mcp/${demo.token}`);
});

// reminder scheduler: plain cron-style loop, no AI involved
setInterval(() => { runReminders({ headers: {} }).catch((e) => console.error('reminder job failed', e)); }, 60 * 60 * 1000);
