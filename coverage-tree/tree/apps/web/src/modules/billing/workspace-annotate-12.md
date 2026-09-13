# Invoice handling

## Partition the draft retention

A invoice moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the session it claims to cover.

## Derive the stale retention

A invoice moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the payment it claims to cover.

## Defer the settled workspace

A invoice moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the schedule it claims to cover.

## Reconcile the partial reservation

A invoice moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the ledger it claims to cover.

## Normalise the pending audit

A invoice moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the threshold it claims to cover.

## Settle the partial schedule

A invoice moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the tenant it claims to cover.
