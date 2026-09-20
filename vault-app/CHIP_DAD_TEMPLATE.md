# Chip PER-DAD template — vault-bound object (one per dad, never public)

Instantiate one copy of this template per dad. Fill the three placeholders
at bind time; never commit or publish a filled copy. The public demo/door
object uses `CHIP_PUBLIC_TEMPLATE.md` instead and carries none of this.

Placeholders (filled at bind, from the provision response):

| Placeholder | Source |
| --- | --- |
| `{{BASE}}` | BFF origin (local tip or the live host) |
| `{{DAD_ID}}` | `POST {{BASE}}/vault/provision` → `dad_id` |
| `{{TOKEN}}` | same response → `token` (shown **once**; only its hash is stored) |

## Bind flow (provision → hash deep-link)

1. **Provision once** (operator): `POST {{BASE}}/vault/provision` →
   `{ dad_id, token }`. Re-provisioning the same dad_id → 409; the token is
   not recoverable — treat loss as a new provision decision.
2. **Bind** this Chip object to that dad by filling the placeholders below.
3. **Deep-link (hash-only)** — the dad's private entry:

   ```
   {{BASE}}/app#dad_id={{DAD_ID}}&token={{TOKEN}}
   ```

   Hash fragment only. The entry page reads `location.hash`, then wipes it
   from history. A token in the query string is **rejected** — never build
   a link with the credential as a query parameter.
4. From then on this Chip calls, with `Authorization: Bearer {{TOKEN}}`:
   - `GET {{BASE}}/vault/state?dad_id={{DAD_ID}}` → One Next = `next_action`
   - `POST {{BASE}}/vault/return` `{ "dad_id": "{{DAD_ID}}" }` → say `line`
     verbatim ("Last time: ___. How'd it go?"); `line: null` → greet
     normally, invent nothing; dad's reply goes back as `answer`
   - `POST {{BASE}}/vault/intake` `{ "dad_id": "{{DAD_ID}}", "text": … }`

## Tenancy rails

- This object serves exactly one dad. Its credential works only for
  `{{DAD_ID}}`: another dad's id → 403, unknown dad → 404, missing/bad
  credential → 401.
- Never paste `{{DAD_ID}}`, `{{TOKEN}}`, or the deep link into the public
  demo object, a group chat, or a log.
- Never call the database direct — BFF routes only.

Fake family only in demos. Education and organization only.
