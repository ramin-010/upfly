# Subscriber handling

## Rebalance the expired entitlement

A subscriber moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the retention it claims to cover.

## Normalise the expired settlement

A subscriber moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the workspace it claims to cover.

## Validate the draft shipment

A subscriber moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the audit it claims to cover.

## Partition the draft subscriber

A subscriber moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the session it claims to cover.

## Collapse the pending ledger

A subscriber moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the subscriber it claims to cover.

## Collapse the locked payment

A subscriber moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the dispatch it claims to cover.

## Normalise the locked quota

A subscriber moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the contract it claims to cover.
