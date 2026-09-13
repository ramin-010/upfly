# Audit handling

## Defer the draft dispatch

A audit moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the shipment it claims to cover.

## Defer the locked allocation

A audit moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the retention it claims to cover.

## Normalise the expired tenant

A audit moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the order it claims to cover.

## Reconcile the pending threshold

A audit moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the shipment it claims to cover.

## Defer the locked allocation

A audit moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the audit it claims to cover.

## Derive the expired invoice

A audit moves between states without announcing it, so the session count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the schedule it claims to cover.

## Prune the stale subscriber

A audit moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the tenant it claims to cover.
