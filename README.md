# Chaser: invoices Claude writes, Chaser chases

A freelancer tells Claude: *"Invoice Acme for 40 hours at ₹2,000 plus 18% GST, due in 15 days."*
Claude calls this app through MCP, and a real invoice appears in the web app with a live client link.
The freelancer edits it, sends it, sees when the client opens it, and Chaser chases overdue payments
on a schedule, long after the chat has ended.

**There is no AI in this app.** No AI keys, no AI SDKs, zero npm dependencies. Claude (the customer's own
plan) does the thinking. Chaser stores, edits, serves and chases. The only cost is hosting.

## Run locally

    node server.js            # Node 18+, nothing to install
    open http://localhost:3000   # login: demo / demo1234

The server prints the demo MCP path on start (`/mcp/<token>`).

## Deploy (about 5 minutes)
Any host that runs `node.server.js` works. Easiest is Render:

1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo. Runtime Node, build command empty, start command `node server.js`.
   (Or New > Blueprint, which reads `render.yaml`.)
3. Add env vars:
   - `DEMO_TOKEN` = a long random string, 20+ chars. Keeps the demo's MCP URL stable across restarts.
   - `BASE_URL` = your public URL, e.g. `https://chaser.onrender.com` (used in client links and emails).
4. Open the URL, sign in with `demo` / `demo1234`, go to **Connect Claude** and copy your connector link.

Heads-up on free tiers: Render's free plan sleeps after ~15 min idle (first load takes up to a minute) and its disk
is wiped on each deploy. Before you submit, either use a paid instance, add a persistent disk
(`DATA_DIR=/var/data`), or ping `/healthz` every 5 minutes with a free uptime monitor. The demo user and sample
invoices are re-created on boot, so the demo always works.

### Optional: real reminder emails
Set `RESEND_API_KEY` (and `MAIL_FROM`, a verified sender) and Chaser emails clients invoices and reminders.
Without it, sends and reminders are recorded in the invoice's activity log, and you share the client link yourself.
Resend is plain email delivery, not AI.

## Connect to Claude
1. Claude > Settings > Connectors > **Add custom connector**.
2. Name: `Chaser`. URL: your connector link from the app (`https://<your-app>/mcp/<token>`). Save.
3. In a new chat, enable the Chaser connector and ask Claude to bill someone.

The token in the URL is the per-user secret. Use **Generate a new link** in the app to rotate it.
Test without Claude: `npx @modelcontextprotocol/inspector` and connect to the same URL.

## MCP tools
`create_invoice`, `list_invoices`, `get_invoice`, `update_invoice`, `send_invoice`, `send_reminder`,
`mark_paid`, `set_business_profile`

## Two-minute demo script
1. **Claude:** "Set my business name to Pixel & Co, pay by UPI pixelco@upi." (shows profile tool)
2. **Claude:** "Invoice Globex (ap@globex.example) for 40 hours of development at ₹2,000/hour plus 18% GST, due in 15 days."
3. **App** (already open on Invoices): a "Claude just created INV-000X" toast appears and the row highlights. Open it.
4. **Edit by hand:** change hours 40 to 45, add a line "Hosting setup, ₹5,000". Save. Totals update.
5. **Send to client**, then **Client page**: show the live invoice a client sees.
6. On the client page click **I've paid this invoice**. Back in the app, the badge "Client says paid" appears.
7. **Claude:** "Who owes me money? Remind anyone overdue." It lists the overdue Acme sample and sends a reminder.
8. **Mark paid** in the app. Collected total goes up.

## Layout
    server.js        REST API, MCP endpoint, public invoice page, reminder job (single file)
    public/index.html  dashboard: sign in, invoice list, editor, Connect Claude, Settings
    data/db.json     created on first run (set DATA_DIR to move it)
