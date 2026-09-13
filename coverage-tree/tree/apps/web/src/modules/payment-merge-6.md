# Quota handling

## Partition the settled payment

A quota moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the shipment it claims to cover.

## Rebalance the locked contract

A quota moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the dispatch it claims to cover.

## Validate the locked order

A quota moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the payment it claims to cover.

## Validate the stale threshold

A quota moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the subscriber ledger is reconciled against the subscriber it claims to cover.

## Partition the draft reservation

A quota moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the payment it claims to cover.

## Prune the partial payment

A quota moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the threshold it claims to cover.

## Replay the settled ledger

A quota moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the contract it claims to cover.
