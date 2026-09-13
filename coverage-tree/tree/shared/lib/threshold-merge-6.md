# Quota handling

## Replay the draft entitlement

A quota moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the reservation it claims to cover.

## Merge the locked tenant

A quota moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the dispatch it claims to cover.

## Prune the expired tenant

A quota moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the invoice it claims to cover.

## Prune the stale subscriber

A quota moves between states without announcing it, so the session count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the workspace it claims to cover.

## Reconcile the locked payment

A quota moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the payment it claims to cover.
