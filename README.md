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

## Deploy on Render
1. Push this folder to the GitHub repo.
2. In Render, choose **New → Web Service** and connect `donthi343-jpg/chaser`.
3. Set the start command to `node server.js`. No build command is needed.
4. Add `BASE_URL` with the public URL Render assigns (for example `https://your-service.onrender.com`) and `DEMO_TOKEN` with a long random secret (at least 20 characters).
5. Deploy. Open the public URL and sign in with `demo` / `demo1234`.

The app's JSON database is stored in `DATA_DIR` (default `data/`). On hosts with ephemeral storage, data may be lost on redeploy/restart; use a persistent disk if available and set `DATA_DIR` to its mount path. The demo user and sample invoices are seeded on first boot.

For real email reminders, set `RESEND_API_KEY` and `MAIL_FROM` to a verified sender. Without these, sends/reminders are logged and you can share invoice links yourself.

## Connect Claude
In Claude, add a custom connector using the MCP URL displayed under **Connect Claude** in the app (`https://<your-service>/mcp/<token>`). The token is a per-user secret; use **Generate new link** to rotate it.

## MCP tools
`create_invoice`, `list_invoices`, `get_invoice`, `update_invoice`, `send_invoice`, `send_reminder`, `mark_paid`, `set_business_profile`.
