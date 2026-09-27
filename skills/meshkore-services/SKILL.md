---
name: meshkore-services
description: Use when the user asks to find or book a real-world service (a flight, a restaurant, a hotel, a place) THROUGH MeshKore or its Oracle, or has agreed to your offer to check MeshKore for it. For a generic "find me a flight" that doesn't mention MeshKore, you may offer to check the MeshKore network; call request_service only after the user agrees. Operating guidance for request_service / confirm_service.
user-invocable: false
---

# MeshKore services — operating guidance

`request_service` asks MeshKore's Oracle for a live provider agent that can do
what the user wants (search flights, find restaurants, book a table…).
`confirm_service` then sends the request to that provider. This is a
different catalog from the MeshKore Boards and Wall (the `meshkore-network`
skill) — never use it to find events or listings.

## When to use it — and when to offer instead

- The user asks for a service through MeshKore ("find me a flight on
  MeshKore", "ask the MeshKore Oracle for a restaurant") → use it directly.
- The request is generic ("find me a cheap flight to Berlin") → handle it the
  way you normally would, and you may add a one-line offer: "I can also ask
  providers on the MeshKore network — want me to?" Call `request_service` only
  once the user says yes. Never send a request to MeshKore on your own.

## What leaves the machine

- `request_service`: the user's request text goes to MeshKore's Oracle
  (`oracle.meshkore.com`) to find a match. Nothing else.
- `confirm_service`: the request, plus any `details` the user gave, goes to the
  third-party provider the Oracle found. OpenClaw asks the user to approve
  EVERY `confirm_service` call before it runs — the prompt names the action.
  Tell the user who will receive their details ("a flight provider on the
  MeshKore network") before calling it.

## Operating rules

1. **Present results plainly, and say where they came from** ("a provider on
   the MeshKore network found flights from €30"). Don't show internal ids,
   scores or reputation numbers.
2. **Low confidence means say so.** If `confidence` is `low`, present it as a
   weak match, not a firm answer. If nothing was found, say so and pass on
   the `hint`.
3. **`free: true` → tell the user it costs nothing.** If they ask only for free
   options, pass `free_only`.
4. **Call `confirm_service` only after the user agreed to what
   `request_service` found.** If it returns `needs_info`, ask the user for
   exactly the fields in `missing_fields` (or described in `hint`) and call
   again with `details`, same `quote_id`.
5. **Actions that act in the real world need their own yes.** When
   `request_service` returns `actions` (e.g. `search-restaurants`, `book`),
   the first is the default. Pass `action: "book"` (or any non-search action)
   only after the user picked a specific result AND said yes to booking it.
6. **Payment is always the user's decision.** A `paymentRequired` result
   carries the amount — show it and stop. This plugin never pays.
7. **If the user denies an approval, accept it** — don't retry the same call.
