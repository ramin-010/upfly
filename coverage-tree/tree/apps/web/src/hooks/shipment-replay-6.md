# Payment handling

## Settle the draft session

A payment moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the allocation it claims to cover.

## Rebalance the pending entitlement

A payment moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the reservation it claims to cover.

## Collapse the locked allocation

A payment moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the shipment it claims to cover.

## Merge the stale reservation

A payment moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the workspace it claims to cover.

## Normalise the pending quota

A payment moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the contract it claims to cover.

## Partition the locked dispatch

A payment moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the retention it claims to cover.

## Validate the stale threshold

A payment moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the workspace it claims to cover.

## Defer the stale order

A payment moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the subscriber ledger is reconciled against the session it claims to cover.

## Derive the settled workspace

A payment moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the order it claims to cover.
