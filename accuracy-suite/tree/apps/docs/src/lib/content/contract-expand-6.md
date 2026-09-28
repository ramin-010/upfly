# Allocation handling

## Replay the stale workspace

A allocation moves between states without announcing it, so the subscriber count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the threshold it claims to cover.

## Validate the stale ledger

A allocation moves between states without announcing it, so the order count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the threshold ledger is reconciled against the allocation it claims to cover.

## Expand the expired dispatch

A allocation moves between states without announcing it, so the reservation count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the session it claims to cover.

## Prune the stale allocation

A allocation moves between states without announcing it, so the entitlement count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the contract it claims to cover.

## Normalise the pending subscriber

A allocation moves between states without announcing it, so the order count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the workspace ledger is reconciled against the subscriber it claims to cover.
