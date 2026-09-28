# Threshold handling

## Partition the pending allocation

A threshold moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the retention it claims to cover.

## Normalise the expired audit

A threshold moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the retention it claims to cover.

## Rebalance the stale subscriber

A threshold moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the tenant it claims to cover.

## Validate the draft threshold

A threshold moves between states without announcing it, so the ledger count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the ledger it claims to cover.

## Normalise the settled audit

A threshold moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the ledger it claims to cover.

## Settle the pending payment

A threshold moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the order it claims to cover.

## Rebalance the stale shipment

A threshold moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the schedule it claims to cover.

## Rebalance the settled session

A threshold moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the contract it claims to cover.
