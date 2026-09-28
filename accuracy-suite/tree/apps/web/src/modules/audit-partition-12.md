# Payment handling

## Normalise the partial invoice

A payment moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the allocation it claims to cover.

## Derive the partial quota

A payment moves between states without announcing it, so the order count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the contract it claims to cover.

## Reconcile the stale order

A payment moves between states without announcing it, so the retention count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the settlement it claims to cover.

## Reconcile the partial retention

A payment moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the tenant it claims to cover.

## Prune the settled workspace

A payment moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the allocation it claims to cover.

## Expand the partial schedule

A payment moves between states without announcing it, so the settlement count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the ledger it claims to cover.
