# Supabase → Firebase migration

The backend code is already migrated. This is the checklist of **live steps you run**
(they need your Google login / credentials and touch live data, so I can't do them).

Firebase account to use: **srujanyamali@gmail.com**

---

## 1. Create the Firebase project (console)

1. Go to <https://console.firebase.google.com> (signed in as srujanyamali@gmail.com).
2. **Add project** → name it (e.g. `thoughts`). Google Analytics optional.
3. **Build → Authentication → Get started → Sign-in method →** enable **Email/Password**.
4. **Build → Firestore Database → Create database** → start in **production mode**, pick a region.
5. **Build → Storage → Get started.** Note the bucket name shown as `gs://…`
   (new projects: `PROJECT_ID.firebasestorage.app`). Storage requires the **Blaze** plan
   for new buckets — upgrade if prompted (it has a free tier).

## 2. Get credentials

- **Web API key:** Project settings (gear) → *General* → **Web API Key**.
- **Service account JSON:** Project settings → *Service accounts* → **Generate new private key**.
  Save it as `backend/serviceAccount.json` (this file is gitignored — see step 4).

## 3. Configure `backend/.env`

Copy `backend/.env.example` → `backend/.env` and fill in:

```
FIREBASE_WEB_API_KEY=<the Web API Key>
FIREBASE_STORAGE_BUCKET=<PROJECT_ID.firebasestorage.app>   # exact name, no gs://
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccount.json
```

## 4. Protect secrets (one-time)

Make sure these never get committed. Add to `backend/.gitignore` if missing:

```
serviceAccount.json
.env
.env.supabase
```

## 5. Install deps

```
cd backend
.venv/bin/python -m pip install -r requirements.txt
```
(The repo venv's `pip` shebang points at an old path; use `python -m pip`.)

## 6. Create the Firestore composite index

The thoughts query filters `user_id ==` **and** orders by `created_at desc`, which needs a
composite index. Either:
- Deploy it: `firebase deploy --only firestore:indexes` (uses `firestore.indexes.json`), **or**
- Run the app once, hit the thoughts list, and click the auto-generated console link in the error.

Index build takes a few minutes — do this before going live.

## 7. Migrate the data  (Supabase → Firebase)

Put your **Supabase** read credentials in `backend/.env.supabase`:

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_KEY=<service-role key>
```
(These came from your old `backend/.env`.)

Then, from `backend/`:

```
.venv/bin/python migrate_to_firebase.py --dry-run     # preview counts, no writes
.venv/bin/python migrate_to_firebase.py --all         # do it (idempotent)
```

What it does:
- **Users** → imported into Firebase Auth with the **same uid** and email, **no password**.
  Everyone resets their password on first login (Supabase password hashes can't be exported).
- **Vault files** → copied to Cloud Storage at the identical `{uid}/path` layout.
- **thoughts** → written to Firestore preserving original id + `created_at`.

You can run a single part with `--users`, `--storage`, or `--thoughts`.

## 8. Tell users to reset passwords

Since passwords don't carry over, existing users must use the app's password-reset / re-register
flow on first login. (If you want a server-driven reset, `auth.generate_password_reset_link(email)`
returns a link you email; or enable Firebase's built-in reset email.)

## 9. Run & verify

```
cd backend && .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```
- `GET /health` → `{"status":"online"}` (also confirms Firebase init succeeded at startup).
- Sign up a test user, create a note (checks Storage), add a thought (checks Firestore).

---

### What changed in code (FYI)
- `dependencies/firebase.py` (new) — Admin SDK init + Web API key helper.
- `dependencies/auth.py` — verifies Firebase ID tokens (was Supabase JWT/JWKS).
- `routers/auth.py` — signup/login/refresh via Firebase REST (same response shape).
- `routers/vault.py` — Cloud Storage (same `{uid}/path` layout, same HTTP contract).
- `routers/thoughts.py` — Firestore `thoughts` collection.
- `migrate_to_firebase.py` (new) — one-time data copy.
- `firestore.indexes.json` (new) — the composite index.

The **frontend and `vault_sync.py` are unchanged** — the API contract is identical.
The Supabase code remains in git history (and on `main`) if you need to roll back.
