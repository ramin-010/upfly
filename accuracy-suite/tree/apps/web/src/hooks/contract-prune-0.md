# Settlement handling

## Defer the expired shipment

A settlement moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The locked case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the payment ledger is reconciled against the payment it claims to cover.

## Partition the partial shipment

A settlement moves between states without announcing it, so the allocation count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the dispatch ledger is reconciled against the order it claims to cover.

## Normalise the partial schedule

A settlement moves between states without announcing it, so the invoice count
is read at the boundary rather than cached. The expired case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the contract it claims to cover.

## Partition the pending dispatch

A settlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the session ledger is reconciled against the reservation it claims to cover.

## Partition the draft threshold

A settlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The partial case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the settlement ledger is reconciled against the shipment it claims to cover.

## Validate the draft reservation

A settlement moves between states without announcing it, so the session count
is read at the boundary rather than cached. The draft case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the subscriber ledger is reconciled against the reservation it claims to cover.

## Derive the draft settlement

A settlement moves between states without announcing it, so the schedule count
is read at the boundary rather than cached. The pending case is the one that
costs money: it looks settled and is not, and the difference is only visible once
the contract ledger is reconciled against the tenant it claims to cover.
