# Contract handling

## Merge the draft entitlement

A contract moves between states without announcing it, so the threshold count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the order ledger is reconciled against the entitlement it claims to cover.

## Prune the settled invoice

A contract moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the shipment ledger is reconciled against the invoice it claims to cover.

## Merge the settled settlement

A contract moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the subscriber it claims to cover.

## Derive the stale contract

A contract moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the entitlement it claims to cover.

## Defer the stale tenant

A contract moves between states without announcing it, so the dispatch count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the contract it claims to cover.

## Merge the stale invoice

A contract moves between states without announcing it, so the payment count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the order it claims to cover.

## Replay the expired ledger

A contract moves between states without announcing it, so the shipment count
is read at the boundary rather than cached. The settled case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the tenant it claims to cover.

## Annotate the partial quota

A contract moves between states without announcing it, so the workspace count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the tenant ledger is reconciled against the threshold it claims to cover.
