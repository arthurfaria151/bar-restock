# Shared Handout on the venue Raspberry Pi

The static website at topd.guarasolutions.com uses the Pi as its shared Handout
server. Named accounts can edit shared notes; all authorised accounts can view
live updates and historical files. Each person signs into the whole app with
one personal PIN. The same session opens Handout automatically; there is no
username field or second login. The server assigns each person's permissions.

Business days use **Australia/Brisbane**, ending at **02:00 the following
morning**. For example, 8 October's handout closes at 02:00 on 9 October AEST
(16:00 UTC on 8 October). The Pi writes `handout-2026-10-08.md` and starts a new
handout. Files and immutable snapshots persist in `/var/lib/bar-handout`.
The server timer runs without an open browser. After a shutdown, it archives
missed days on startup. If power is interrupted during file writing, the file
is reconstructed from SQLite on restart. Keep the Pi powered and its clock
synchronised for timely archival.

## Install on the Pi

Run these commands in the **Pi's terminal**, where the prompt is
`poolmaster@ZaOne`. Do not paste a script shebang into the Mac's zsh prompt.

```bash
git clone https://github.com/arthurfaria151/bar-restock.git ~/bar-restock-handout
cd ~/bar-restock-handout
sudo bash scripts/install-handout-pi.sh
```

If the checkout already exists, use `git pull --ff-only` inside it instead of
cloning again. The installer requires 64-bit Raspberry Pi OS if Node 24 is not
already installed. It uses an existing Node 24+ or installs a separate,
checksum-verified official Node runtime for this service. It does not replace
the Node runtime used by other apps. It prompts locally for your display name
and a personal PIN, creating the first administrator. PINs do not go into
the repository or website. It installs the `bar-handout` systemd service on loopback port 8787.

The installer adds `handout.guarasolutions.com` to the existing
`/etc/cloudflared/config.yml`, routes it to `http://127.0.0.1:8787`, validates
and backs up the configuration, and restarts `cloudflared`. Other ingress
rules are preserved. Rerunning is safe if this hostname still has the same
service. A conflicting existing hostname stops the tunnel change.

If the Pi has a Cloudflare origin certificate, the installer creates the DNS
record through `cloudflared tunnel route dns`, without overwriting an existing
record. Otherwise create this **proxied CNAME** in Cloudflare DNS:

| Name | Target |
| --- | --- |
| handout | 76b4c77c-37f8-4159-aff2-97a6210792b7.cfargotunnel.com |

This uses the existing tunnel supplied by the venue. No new tunnel is needed.
The tunnel credentials JSON stays on the Pi. Confirm the server is ready:

```bash
systemctl status bar-handout --no-pager
curl --fail http://127.0.0.1:8787/health
curl --fail https://handout.guarasolutions.com/health
```

Both health checks should return `{"ok":true}`. `handout-config.js` connects
the website to `https://handout.guarasolutions.com`. If the hostname changes,
update that public URL, run `npm run version:web`, commit and deploy.
The Handout uses shared server storage; the rest of the app's stock and shelf
features continue to use device storage.

## Update an existing account to PIN sign-in

After pulling this release and rerunning the installer, migrate the existing
Arthur account without changing its identity or Handout history:

```bash
sudo bash scripts/set-staff-pin.sh arthur admin
```

Enter and confirm your PIN privately in the Pi terminal. Choose 6–12 digits.
The command checks uniqueness, stores only a salted hash, and restarts the
service. It removes password login for the migrated account. Update the Pi
before publishing the PIN-only website.

## Add another person or change their PIN

```bash
sudo bash scripts/set-staff-pin.sh sam bartender 'Sam'
```

The first argument is an internal account ID used only during provisioning;
staff never enter it to sign in. Use `manager` for booking approvals without catalog administration, or `admin` for a person who manages products,
par levels and shelves. Both roles can edit the shared Handout. Repeating the
command changes that person's PIN and preserves their account identity.
Duplicate PINs are rejected. Existing read-only Handout permissions are kept
when an account is migrated.

Sessions last up to 12 hours and expire together across the app and Handout.
Changing a PIN invalidates that person's existing tokens. A new sign-in needs
a connection to the Pi; an already verified, unexpired tab session supports
device-local work when offline. Shared Handout needs a connection to save.
Replacing the session secret revokes all tokens. Accounts load on service start.

## Persistence and operations

- Database: `/var/lib/bar-handout/handout.sqlite`, with WAL and full synchronous
  commits. The server rejects stale edits and checks the business date on each
  write; previously closed handouts cannot be edited.
- Archive files: `/var/lib/bar-handout/archives/handout-YYYY-MM-DD.md`.
  Authenticated users can view them and download copies in the website.
- Secrets: `/etc/bar-handout.env`, root-readable; users contain salted PIN
  hashes in `/var/lib/bar-handout/users.json`.
- Logs: `journalctl -u bar-handout --no-pager`. The service logs no PINs, passwords,
  session tokens or note contents.
- Back up the archive directory and use SQLite's `.backup` command for a live
  database backup; copying only the `.sqlite` file during writes can omit WAL
  changes. No automatic deletion policy is applied to historical handouts.
- Edits require a connection. A failed request or conflicting edit keeps the
  draft on screen. A retry of the same save identifier commits once. Drafts
  are not described as saved until the server confirms them.

Pi installation was confirmed on 8 October 2026: the service health check
returned `{"ok":true}`, the existing tunnel configuration validated and the
Handout DNS record was created. SSH to the Pi’s private LAN address remains
unavailable from the cloud workspace. Public cloud verification requires
`handout.guarasolutions.com` in the environment’s network allowlist.

## Development

Backend needs Node 24+ and no npm dependencies. Supply `HANDOUT_USERS_JSON`,
`HANDOUT_SESSION_SECRET` and a writable `HANDOUT_DATA_DIR`, then run
`node handout-server/server.mjs`. Its HTTP listener binds to 127.0.0.1. CORS
allows only the configured website/native origins. To use a proxy's client IP
for rate limiting, enable `HANDOUT_TRUST_PROXY=1` and configure that trusted
proxy to overwrite `X-Real-IP`; the default limits attempts by socket address.

`npm test` covers real HTTP streams, authentication, concurrent note edits,
retries, persistence, date boundaries and archive immutability. Browser tests
use an isolated, real local SQLite server to check multi-user live updates,
conflicting drafts, read-only access and downloadable daily archives.

## Bookings

The same PIN session authorizes `/api/bookings`. Bartenders submit pending
requests; managers/admins approve or decline them. Admins/managers can create
approved bookings directly and edit or cancel active bookings. A requester can
edit or withdraw their pending request. Viewing accounts cannot make changes.
To provision a manager locally on the Pi:

```bash
sudo bash scripts/set-staff-pin.sh alex manager 'Alex'
```

All start/end times are interpreted in Australia/Brisbane. Approved bookings
that overlap a business day appear in its Handout, including bookings spanning
02:00. Pending, declined and cancelled bookings do not appear in the current
Handout. Closing snapshots retain booking details and task statuses in both
SQLite and the Markdown file; later edits cannot rewrite closed archives.
Preparation task updates are shared across devices with per-task version
checks. Bookings and task states are stored in the existing SQLite database.
Past bookings are read-only, and cancelled/declined records remain available
in the history view. Keep database and archive backups as described above.

The health response includes `"features":{"bookings":true}` once the Pi is
updated. Rerun the existing installer after pulling; it preserves accounts,
PINs and archives while migrating the database automatically. The website
must be published after this backend update. Bookings require connectivity;
unsaved form details are kept in the current browser tab after a failed save.
