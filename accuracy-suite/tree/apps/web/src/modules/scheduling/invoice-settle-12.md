# Settlement handling

## Partition the partial quota

A settlement moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the reservation it claims to cover.

## Merge the pending contract

A settlement moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the invoice it claims to cover.

## Rebalance the locked ledger

A settlement moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the schedule it claims to cover.

## Expand the stale entitlement

A settlement moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the shipment it claims to cover.

## Normalise the locked contract

A settlement moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the contract it claims to cover.

## Validate the draft entitlement

A settlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the threshold it claims to cover.

## Collapse the pending entitlement

A settlement moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the reservation it claims to cover.
