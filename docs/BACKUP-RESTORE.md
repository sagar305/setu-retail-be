# Backups and restore

## What runs

`.github/workflows/backup.yml` runs every night at 02:47 IST, and you can also start it by hand (Actions → Nightly database backup → Run workflow). It:

1. Dumps the production database with `pg_dump` (custom format: tables, data, indexes).
2. Checks that the dump can be read.
3. Encrypts it with AES-256, using `BACKUP_PASSPHRASE`.
4. Keeps it as a workflow artifact for **90 days**.

The artifact counts against the GitHub storage quota for private repos. A small shop database dumps to a few MB.

Your database provider's own backups (Prisma Postgres) still apply. These GitHub backups are a second copy that you control.

## One-time setup

1. **Generate a passphrase:**
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Save it in your password manager. **Without it, no backup can be opened.**
2. **Add two repository secrets** in GitHub (setu-retail-be → Settings → Secrets and variables → Actions → New repository secret):
   - `BACKUP_DATABASE_URL`: the database's **direct** connection string, the same database as Vercel's `DATABASE_URL`.
   - `BACKUP_PASSPHRASE`: the passphrase from step 1.
3. **Run it once by hand** (Actions → Nightly database backup → Run workflow) and check that it goes green.

## Restore

Do this into a **new, empty database first**. Never restore over the live one until you've checked the copy.

1. **Download the artifact:** Actions → Nightly database backup → pick the run → Artifacts → download, then unzip.
2. **Check and decrypt:**
   ```
   sha256sum -c setu-retail-<date>.dump.enc.sha256
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass pass:'<BACKUP_PASSPHRASE>' \
     -in setu-retail-<date>.dump.enc -out db.dump
   ```
3. **Restore into an empty database.** You need `pg_restore` 18, from Postgres.app on Mac, `brew install postgresql@18`, or the PGDG packages on Linux:
   ```
   pg_restore --no-owner --no-privileges --dbname "<new database URL>" db.dump
   ```
4. **Check the copy:** point a local API at the new database (`DATABASE_URL=... npm run dev`), sign in, and look at a few shops' bills and stock.
5. **Switch over:** put the new database's URL in Vercel (setu-retail-be → `DATABASE_URL`), then redeploy. Migrations are already in the dump, and the next deploy confirms "No pending migrations".

## Practise

Once a month, restore the latest backup into a scratch database (steps 1–4). A backup that has never been restored isn't proven.
