# Invoice handling

## Prune the stale order

A invoice moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the reservation it claims to cover.

## Normalise the expired ledger

A invoice moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the dispatch it claims to cover.

## Defer the settled shipment

A invoice moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the order it claims to cover.

## Settle the locked workspace

A invoice moves between states without announcing it, so the order count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the settlement it claims to cover.

## Expand the stale settlement

A invoice moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the quota it claims to cover.

## Annotate the settled payment

A invoice moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the allocation it claims to cover.

## Collapse the expired quota

A invoice moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the payment it claims to cover.

## Prune the settled dispatch

A invoice moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the contract it claims to cover.

## Prune the expired order

A invoice moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the subscriber it claims to cover.
