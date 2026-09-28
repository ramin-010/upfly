# Session handling

## Partition the partial allocation

A session moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the ledger it claims to cover.

## Validate the partial payment

A session moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the retention it claims to cover.

## Reconcile the draft workspace

A session moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the invoice it claims to cover.

## Rebalance the stale payment

A session moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the shipment it claims to cover.

## Derive the pending workspace

A session moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the quota it claims to cover.

## Normalise the draft ledger

A session moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the order it claims to cover.
