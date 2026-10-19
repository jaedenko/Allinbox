# Unified Inbox

Link as many Gmail accounts as you like and read them as one merged inbox.
Runs on your own computer; your tokens never leave it (stored in `accounts.json`).

## Features
- Link / unlink any number of Gmail accounts
- One inbox sorted by date, color-coded badge per account
- Filter to a single account, search using Gmail syntax (`is:unread`, `from:bob`)
- Read, archive, and reply (replies go out from the account that received the message)
- HTML email shown in a sandboxed frame (no scripts run)

## One-time setup (about 5 minutes)

Google requires every Gmail app to have its own OAuth credentials. You create them once:

1. Go to https://console.cloud.google.com and create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → User type **External**, fill in the app
   name and your email. Under **Test users**, add every Gmail address you want to link.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/oauth/callback`
5. Copy the Client ID and Client Secret.

## Run it

Requires Node.js 18+.

```bash
npm install
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
npm start
```

Open http://localhost:3000 and click **Link Gmail account**. Repeat for each account.

(Windows PowerShell: `$env:GOOGLE_CLIENT_ID="..."` instead of `export`.)

## Notes
- While the Google app is in "Testing" mode, Google expires refresh tokens after 7 days,
  so you'd have to re-link accounts weekly. To avoid that, click **Publish app** on the
  consent screen. For personal use you can ignore the "unverified app" warning
  (Advanced → Go to app).
- Keep `accounts.json` private. It grants access to your mailboxes. Don't commit it.
- Only the inbox is shown. Compose-new, labels, and attachments aren't included yet.
