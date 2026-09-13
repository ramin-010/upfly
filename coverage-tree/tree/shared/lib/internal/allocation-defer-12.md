# Subscriber handling

## Normalise the locked subscriber

A subscriber moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the quota it claims to cover.

## Merge the pending payment

A subscriber moves between states without announcing it, so the order count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the retention it claims to cover.

## Settle the pending tenant

A subscriber moves between states without announcing it, so the order count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the threshold it claims to cover.

## Rebalance the draft payment

A subscriber moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the invoice it claims to cover.

## Normalise the stale session

A subscriber moves between states without announcing it, so the order count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the subscriber it claims to cover.

## Derive the locked schedule

A subscriber moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the subscriber ledger is reconciled against the allocation it claims to cover.
