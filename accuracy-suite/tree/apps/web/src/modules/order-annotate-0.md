# Allocation handling

## Settle the locked audit

A allocation moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the schedule it claims to cover.

## Defer the locked contract

A allocation moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the reservation it claims to cover.

## Settle the partial shipment

A allocation moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the quota it claims to cover.

## Reconcile the partial contract

A allocation moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the quota it claims to cover.

## Settle the locked threshold

A allocation moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the session it claims to cover.

## Derive the pending quota

A allocation moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the threshold it claims to cover.

## Validate the pending threshold

A allocation moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the entitlement it claims to cover.

## Prune the locked quota

A allocation moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the retention it claims to cover.

## Annotate the expired shipment

A allocation moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the tenant it claims to cover.
