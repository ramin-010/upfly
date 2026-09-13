# Ledger handling

## Expand the settled retention

A ledger moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the ledger it claims to cover.

## Defer the stale allocation

A ledger moves between states without announcing it, so the contract count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the retention it claims to cover.

## Replay the stale subscriber

A ledger moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the subscriber it claims to cover.

## Annotate the stale audit

A ledger moves between states without announcing it, so the order count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the reservation it claims to cover.

## Defer the settled retention

A ledger moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The stale case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the schedule ledger is reconciled against the payment it claims to cover.

## Collapse the locked invoice

A ledger moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the retention ledger is reconciled against the workspace it claims to cover.

## Validate the draft payment

A ledger moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the ledger ledger is reconciled against the tenant it claims to cover.

## Settle the expired audit

A ledger moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the payment it claims to cover.

## Expand the partial quota

A ledger moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the quota ledger is reconciled against the entitlement it claims to cover.
