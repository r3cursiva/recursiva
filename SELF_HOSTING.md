# Self-hosting recursiva

Run recursiva on one machine with Docker: the app and its Postgres, two containers. Nothing else is needed: no account
anywhere, no mail provider (sign-in codes go to the server log until you set one up).

Needs Docker with Compose v2 (`docker compose version`), about 1 GB of free memory and 2 GB of disk for the build.
Steps below were run on macOS (arm64) with Docker 29; the image builds for amd64 and arm64 alike.

## Start

```sh
git clone <this repository> recursiva && cd recursiva/deploy/self-host
cp .env.example .env
sed -i.bak "s/change-me/$(openssl rand -hex 16)/; s/you@example.com/YOUR@ADDRESS/" .env   # database password, and who may create workspaces
docker compose up -d --build     # first build takes a few minutes; later starts take seconds
curl localhost:3800/healthz      # {"ok":true}
```

The app is now at <http://localhost:3800>, on this machine only (`RSVA_BIND=127.0.0.1`).

Once images are published to `ghcr.io` (workflow `.github/workflows/images.yml`, run on a `v*` tag or by hand), you can skip
the build: set `RSVA_IMAGE` and `RSVA_TAG` in `.env` and run `docker compose pull && docker compose up -d`.

## First workspace and first sign-in

Accounts exist only through workspaces and invites, so the first workspace is made from the server's shell:

```sh
./bootstrap.sh myteam YOUR@ADDRESS "My team"     # slug, owner's address, name; one project, APP
```

Open <http://localhost:3800>, type the address, and read the code from the log:

```sh
docker compose logs app | grep "is your recursiva code"      # mail to YOUR@ADDRESS: 123456 is your recursiva code
```

Then create issues, or more workspaces (the addresses in `RSVA_WORKSPACE_CREATORS` may create them), and invite people
from Settings. An invitation is a mail; without a mail provider the link is in the log as well.

## Mail, a domain, TLS

- **Mail.** Set `RESEND_API_KEY` and `RSVA_MAIL_FROM` (an address on a domain verified at <https://resend.com>) in `.env`, then
  `docker compose up -d`. Codes, invitations and (with `RSVA_NOTIFY=on`) notifications are then mailed. While `RSVA_MAIL=log`
  and no key is set, anyone who can read the server log can sign in as anyone: keep the app on localhost or on a network you trust.
- **A domain.** Put a reverse proxy with TLS (Caddy, nginx, a tunnel) in front, keep `RSVA_BIND=127.0.0.1`, and set
  `RSVA_ALLOWED_HOSTS=recursiva.example.com`, `RSVA_ALLOWED_ORIGINS=https://recursiva.example.com` and `RSVA_TRUST_PROXY` to
  the proxy's address as the app sees it. Without them the app answers only to `localhost`.

## Backup and restore

```sh
./backup.sh                      # prints backups/recursiva-<UTC time>.tar.gz; the app keeps running
./restore.sh backups/recursiva-<UTC time>.tar.gz     # replaces the database and the uploads, then starts the app
```

The archive holds a Postgres dump, the uploaded files and `manifest.txt` (the image, Postgres version and number of
migrations). It does not hold `.env`: copy that file separately. Restore with the same or a newer image than made the archive.
Copy the archives off the machine; the script keeps none for you.

## Update

```sh
git pull && ./backup.sh && docker compose up -d --build     # or: docker compose pull && docker compose up -d
```

Migrations run when the server starts and are additive. Logs: `docker compose logs -f app`. Stop: `docker compose stop`;
remove with the data: `docker compose down -v`.

## Not yet

An installer and a `recursiva-ctl` command (rollback, doctor), signed images, a web way to make the first workspace without
the shell step above.
