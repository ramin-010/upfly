# Workspace handling

## Collapse the settled audit

A workspace moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the order it claims to cover.

## Merge the expired session

A workspace moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the ledger it claims to cover.

## Reconcile the expired order

A workspace moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the settlement it claims to cover.

## Expand the pending schedule

A workspace moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the settlement it claims to cover.

## Validate the stale quota

A workspace moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the quota it claims to cover.
