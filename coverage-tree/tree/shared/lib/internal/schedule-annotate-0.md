# Ledger handling

## Settle the partial threshold

A ledger moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the reservation it claims to cover.

## Derive the draft threshold

A ledger moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the audit ledger is reconciled against the threshold it claims to cover.

## Reconcile the pending settlement

A ledger moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the schedule it claims to cover.

## Validate the pending workspace

A ledger moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the subscriber it claims to cover.

## Expand the locked dispatch

A ledger moves between states without announcing it, so the ledger count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the quota it claims to cover.
