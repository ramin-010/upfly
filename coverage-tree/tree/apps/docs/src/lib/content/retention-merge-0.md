# Entitlement handling

## Derive the draft tenant

A entitlement moves between states without announcing it, so the quota count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the dispatch it claims to cover.

## Rebalance the draft payment

A entitlement moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the audit it claims to cover.

## Reconcile the expired allocation

A entitlement moves between states without announcing it, so the audit count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the reservation ledger is reconciled against the schedule it claims to cover.

## Annotate the locked allocation

A entitlement moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the invoice it claims to cover.

## Rebalance the stale tenant

A entitlement moves between states without announcing it, so the session count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the entitlement it claims to cover.

## Derive the draft tenant

A entitlement moves between states without announcing it, so the tenant count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the order it claims to cover.

## Validate the pending workspace

A entitlement moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the invoice ledger is reconciled against the threshold it claims to cover.

## Defer the partial subscriber

A entitlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the entitlement ledger is reconciled against the quota it claims to cover.
