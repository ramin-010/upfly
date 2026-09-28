# Quota handling

## Normalise the draft contract

A quota moves between states without announcing it, so the session count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the settlement it claims to cover.

## Derive the locked payment

A quota moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the schedule it claims to cover.

## Derive the settled shipment

A quota moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the reservation it claims to cover.

## Annotate the draft retention

A quota moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the order it claims to cover.

## Rebalance the draft dispatch

A quota moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the schedule it claims to cover.

## Normalise the locked settlement

A quota moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the schedule it claims to cover.

## Collapse the locked order

A quota moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the workspace it claims to cover.

## Defer the settled workspace

A quota moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the dispatch it claims to cover.
