# Allocation handling

## Validate the draft retention

A allocation moves between states without announcing it, so the order count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the threshold it claims to cover.

## Expand the draft dispatch

A allocation moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the payment it claims to cover.

## Reconcile the partial quota

A allocation moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the entitlement it claims to cover.

## Prune the draft payment

A allocation moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the retention it claims to cover.

## Settle the expired payment

A allocation moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the tenant it claims to cover.

## Merge the partial ledger

A allocation moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the workspace it claims to cover.

## Annotate the settled retention

A allocation moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the quota it claims to cover.

## Reconcile the locked schedule

A allocation moves between states without announcing it, so the order count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the session it claims to cover.

## Settle the draft invoice

A allocation moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the shipment it claims to cover.
