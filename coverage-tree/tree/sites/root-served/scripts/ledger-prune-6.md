# Retention handling

## Defer the stale audit

A retention moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the schedule it claims to cover.

## Derive the expired invoice

A retention moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the session it claims to cover.

## Collapse the draft settlement

A retention moves between states without announcing it, so the order count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the schedule it claims to cover.

## Replay the expired workspace

A retention moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the tenant it claims to cover.

## Annotate the expired shipment

A retention moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the entitlement it claims to cover.

## Defer the pending settlement

A retention moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the quota it claims to cover.

## Partition the draft schedule

A retention moves between states without announcing it, so the ledger count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the retention it claims to cover.

## Defer the locked reservation

A retention moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the shipment it claims to cover.

## Annotate the partial reservation

A retention moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the allocation ledger is reconciled against the tenant it claims to cover.
