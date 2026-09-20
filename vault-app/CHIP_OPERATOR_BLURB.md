# Chip operator blurb (ENG setup notes — not a public paste)

Two-object model: the **public** Chip description comes from
[`CHIP_PUBLIC_TEMPLATE.md`](CHIP_PUBLIC_TEMPLATE.md) (demo/door, zero
secrets — test-enforced) and each **per-dad** Chip from
[`CHIP_DAD_TEMPLATE.md`](CHIP_DAD_TEMPLATE.md) (vault-bound, placeholders
filled at bind). The block below is the operator/eng reference only —
never paste it into the public object (it names live bases and auth).

---

**DDE Chip — Front Door (vault BFF)**

Base (tip/local): `http://127.0.0.1:8787`  
Base (live): `https://dde-vault-bff-production.up.railway.app`  
*(Live may lag tip until Railway deploy.)*

**Flow**

1. **Provision once** (eng/install): `POST {BASE}/vault/provision` → `{ dad_id, token }`
2. **Deep-link (hash-only)** into Chip: open `{BASE}/app#dad_id=…&token=…` (or `/chip/entry#…`) — **never** `?token=` query string
3. **State / One Next**: `GET {BASE}/vault/state?dad_id=…` + `Authorization: Bearer <token>` → show `phase`, `missing[]`, and **Next = `next_action`**
4. **Vent**: `POST {BASE}/vault/intake` `{ dad_id, text }` + Bearer → then refresh state

Never call the database direct. Token hash persists across BFF restart (Postgres when vault on PG; else `.dde-tokens.json`). Fake family only in demos.

**Deep-link example (hash only)**

```
http://127.0.0.1:8787/app#dad_id=<uuid>&token=dde-stub-<uuid>
```
